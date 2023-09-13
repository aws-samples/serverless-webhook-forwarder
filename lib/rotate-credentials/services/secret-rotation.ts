// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import {
  SecretsManagerClient,
  DescribeSecretCommand,
  DescribeSecretCommandOutput,
  PutSecretValueCommand,
  GetSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { Logger } from '@aws-lambda-powertools/logger';

import SecretRotationDisabledError from '../data_types/secret-rotation-disabled-error';
import SecretVersionNotFoundError from '../data_types/secret-version-not-found-error';
import SecretVersionStageError from '../data_types/secret-version-stage-error';
import InputValueError from '../data_types/input-value-error';
import TailscaleApiKeyClient, {
  TailscaleClientKey,
  KeyUsageType,
} from './tailscale-api-key-client';
import TailscaleOAuthClient, {
  TailscaleOAuthCredentials,
} from './tailscale-oauth-client';
import {
  ensureEnvVarsAreSet,
  OAUTH_SECRET_ARN,
  TAILNET,
  TAG_NAME,
} from './env';

export const logger = new Logger({ serviceName: 'tailscaleClientKeyRotation' });

export enum SecretStages {
  Current = 'AWSCURRENT',
  Pending = 'AWSPENDING',
}

export const SECRET_PURPOSE_TAG_KEY = 'Purpose';

async function checkSecretVersionIsStagedForRotation(
  metadata: DescribeSecretCommandOutput,
  secretId: string,
  requestToken: string,
): Promise<boolean> {
  if (metadata.RotationEnabled === false) {
    throw new SecretRotationDisabledError(
      `Secret ${secretId} does not have rotation enabled`,
    );
  }

  const versions = metadata.VersionIdsToStages;
  if (versions == null || (Object.keys(versions) as string[]).indexOf(requestToken) === -1) {
    throw new SecretVersionNotFoundError(
      `Secret version ${requestToken} has no stage for rotation at secret ${secretId}`,
    );
  }
  const versionTags = versions![requestToken];
  if (versionTags.indexOf(SecretStages.Current) >= 0) {
    logger.info(`Secret version ${requestToken} already set as AWSCURRENT for secret ${secretId}`);
    return false;
  }
  if (versionTags.indexOf(SecretStages.Pending) === -1) {
    throw new SecretVersionStageError(
      `Secret version ${requestToken} not set as AWSPENDING for rotation of secret ${secretId}.`,
    );
  }
  return true;
}

function extractKeyUsageType(
  metadata: DescribeSecretCommandOutput,
): KeyUsageType {
  const filteredTags = (metadata.Tags ?? [])
    .filter(
      (tagObj) => (tagObj.Key ?? '') === SECRET_PURPOSE_TAG_KEY,
    );
  if (filteredTags.length === 1) {
    if (filteredTags[0].Value === KeyUsageType.Reusable) {
      return KeyUsageType.Reusable;
    }
  }
  return KeyUsageType.SingleUse;
}

async function createSecret(
  tsClient: TailscaleApiKeyClient,
  smClient: SecretsManagerClient,
  secretId: string,
  requestToken: string,
  keyUsageType: KeyUsageType,
): Promise<void> {
  const keyData = await tsClient.createKey(keyUsageType);
  await smClient.send(new PutSecretValueCommand({
    ClientRequestToken: requestToken,
    SecretId: secretId,
    SecretString: JSON.stringify(keyData),
    VersionStages: [
      SecretStages.Pending,
    ],
  }));
  logger.info(`createSecret: Successfully put secret value ${requestToken} for ${secretId}.`);
}

async function getTailscaleOAuthSecret(
  smClient: SecretsManagerClient,
): Promise<TailscaleOAuthCredentials> {
  const secretId: string = OAUTH_SECRET_ARN;
  try {
    const secretValue = await smClient.send(new GetSecretValueCommand({
      SecretId: secretId,
      VersionStage: SecretStages.Current,
    }));
    return JSON.parse(secretValue.SecretString!) as TailscaleOAuthCredentials;
  } catch (error) {
    logger.error(
      `Ran into ${error} while retrieving the Tailscale OAuth credentials. `
      + `Could not retrieve AWSCURRENT from ${secretId}, did you initialize it? `
      + 'The secret value needs to have the following syntax: '
      + '\'{ "id": "your-oauth-id", "key": "your-oauth-key" }\'',
    );
    throw error;
  }
}

async function getTailscaleSecret(
  smClient: SecretsManagerClient,
  secretId: string,
  requestToken: string,
): Promise<TailscaleClientKey> {
  try {
    const secretValue = await smClient.send(new GetSecretValueCommand({
      SecretId: secretId,
      VersionId: requestToken,
    }));
    return JSON.parse(secretValue.SecretString!) as TailscaleClientKey;
  } catch (error) {
    logger.error(
      `Ran into ${error} while retrieving the Tailscale Client Key. `
      + `Could not retrieve ${requestToken} from ${secretId}. `,
    );
    throw error;
  }
}

async function testSecret(
  tsClient: TailscaleApiKeyClient,
  smClient: SecretsManagerClient,
  secretId: string,
  requestToken: string,
  keyUsageType: KeyUsageType,
): Promise<void> {
  try {
    const tsKeyData = await getTailscaleSecret(smClient, secretId, requestToken);
    await tsClient.verifyKey(tsKeyData.id, keyUsageType);
  } catch (error) {
    logger.error(
      `Ran into ${error} while verifying the Tailscale Client Key secret. `
      + `Failed to verify ${requestToken} on ${secretId}. `,
    );
    throw error;
  }
}

async function finishSecret(
  tsClient: TailscaleApiKeyClient,
  smClient: SecretsManagerClient,
  secretId: string,
  requestToken: string,
  metadata: DescribeSecretCommandOutput,
): Promise<void> {
  try {
    const filteredVersionIds: string[] = (
      Object.keys(metadata.VersionIdsToStages!)
        .filter(
          (key) => metadata.VersionIdsToStages![key].indexOf(SecretStages.Current) >= 0,
        )
    );
    const currentVersionId: string | undefined = (
      filteredVersionIds.length > 0
        ? filteredVersionIds[0]
        : undefined
    );

    // Stage the secret version as the new current
    await smClient.send(new UpdateSecretVersionStageCommand({
      SecretId: secretId,
      VersionStage: SecretStages.Current,
      MoveToVersionId: requestToken,
      RemoveFromVersionId: currentVersionId,
    }));

    logger.info(
      'finishSecret: Successfully set AWSCURRENT stage to version '
      + `${requestToken} for secret ${secretId}.`,
    );
  } catch (error) {
    logger.error(
      `Ran into ${error} while finishng the Tailscale Client Key secret rotation. `
      + `Failed to finish rotation of ${requestToken} on ${secretId}. `,
    );
    throw error;
  }
}

export default async function rotateSecret(
  smClient: SecretsManagerClient,
  secretId: string,
  requestToken: string,
  step: string,
): Promise<void> {
  ensureEnvVarsAreSet();
  const oauthCreds: TailscaleOAuthCredentials = await getTailscaleOAuthSecret(
    smClient,
  );
  const tsOAuth = new TailscaleOAuthClient(oauthCreds);
  const tsClient = new TailscaleApiKeyClient(
    TAILNET,
    TAG_NAME,
    await tsOAuth.authenticate(),
  );
  const metadata = await smClient.send(new DescribeSecretCommand({
    SecretId: secretId,
  }));
  const canContinue = await checkSecretVersionIsStagedForRotation(
    metadata,
    secretId,
    requestToken,
  );
  if (canContinue === false) {
    logger.info(`rotateSecret: all done on ${secretId}`);
    return;
  }

  const keyUsageType = extractKeyUsageType(metadata);
  if (step === 'createSecret') {
    await createSecret(tsClient, smClient, secretId, requestToken, keyUsageType);
  } else if (step === 'setSecret') {
    // Testing the secret instead, as no external set is required.
    await testSecret(tsClient, smClient, secretId, requestToken, keyUsageType);
  } else if (step === 'testSecret') {
    await testSecret(tsClient, smClient, secretId, requestToken, keyUsageType);
  } else if (step === 'finishSecret') {
    await finishSecret(tsClient, smClient, secretId, requestToken, metadata);
  } else {
    logger.error(`lambda_handler: Invalid step parameter ${step} for secret ${secretId}`);
    throw new InputValueError(`Invalid step parameter ${step} for secret ${secretId}`);
  }
}
