// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { jest } from '@jest/globals';
import 'aws-sdk-client-mock-jest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  DescribeSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  UpdateSecretVersionStageCommand,
  Tag,
} from '@aws-sdk/client-secrets-manager';

import TailscaleOAuthClient from '../../services/tailscale-oauth-client';
import TailscaleApiKeyClient, {
  KeyUsageType,
} from '../../services/tailscale-api-key-client';
import rotateSecret, {
  logger,
  SecretStages,
} from '../../services/secret-rotation';
import * as Env from '../../services/env';
import { getDateInDays } from '../helpers';

jest.mock('../../services/env', () => ({
  ensureEnvVarsAreSet: jest.fn(),
  OAUTH_SECRET_ARN: 'oauthSecretArn',
  TAG_NAME: 'testTag',
  TAILNET: 'testTailNet',
}));
jest.mock('../../services/tailscale-oauth-client');
jest.mock('../../services/tailscale-api-key-client');

describe.each([
  ['No Tags array -> SingleUse', [], KeyUsageType.SingleUse],
  ['Zero Tags -> SingleUse', [], KeyUsageType.SingleUse],
  ['Irrelevant Tags', [{ Key: 'Other', Value: 'Cattle' }, { Key: 'Another', Value: 'Cattle' }], KeyUsageType.SingleUse],
  ['Tagged reusable', [{ Key: 'Another', Value: 'SingleUse' }, { Key: 'Purpose', Value: 'Cattle' }], KeyUsageType.Reusable],
  ['Tagged single', [{ Key: 'Another', Value: 'Cattle' }, { Key: 'Purpose', Value: 'SingleUse' }], KeyUsageType.SingleUse],
])('secret-rotation - %s', (caseDescription: string, tags: Tag[], keyUsageType: KeyUsageType) => {
  const smClient = mockClient(SecretsManagerClient);
  const TailscaleOAuthClientMock: any = TailscaleOAuthClient as unknown;
  const TailscaleApiKeyClientMock: any = TailscaleApiKeyClient as unknown;
  const secretId = 'testSecretId';
  const requestToken = 'versionId';
  const oauthSecret = {
    id: 'theId',
    key: 'theKey',
  };
  const accessToken = 'testAccessToken';
  const clientKey = {
    id: 'theId',
    key: 'theKey',
    created: getDateInDays(0),
    expires: getDateInDays(61),
  };
  const describeSecretTagsObj = (
    caseDescription === 'No Tags array -> SingleUse' ? {} : {
      Tags: tags,
    }
  );

  beforeEach(() => {
    jest.spyOn(logger, 'info').mockReturnValue({} as any);
    jest.spyOn(logger, 'error').mockReturnValue({} as any);
    (Env.ensureEnvVarsAreSet as any).mockReturnValue();
    smClient
      .on(
        GetSecretValueCommand,
        {
          SecretId: Env.OAUTH_SECRET_ARN,
          VersionStage: SecretStages.Current,
        },
      )
      .resolvesOnce({
        SecretString: JSON.stringify(oauthSecret),
      });
    smClient
      .on(DescribeSecretCommand)
      .resolves({
        RotationEnabled: true,
        VersionIdsToStages: {
          versionId: [
            SecretStages.Pending,
          ],
          currentId: [
            SecretStages.Current,
          ],
          oldId: [
            'irrelevantStage',
          ],
        },
        ...describeSecretTagsObj,
      });
    TailscaleOAuthClientMock.prototype.authenticate.mockImplementationOnce(
      () => Promise.resolve(accessToken),
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
    smClient.reset();
  });

  describe('rotateSecret init code', () => {
    const step = 'createSecret';

    it('fails when some environment variable is not configured', async () => {
      (Env.ensureEnvVarsAreSet as any).mockReset();
      (Env.ensureEnvVarsAreSet as any).mockImplementationOnce(
        () => {
          throw Error('mock reject missing env');
        },
      );
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock reject missing env');
      expect(Env.ensureEnvVarsAreSet).toHaveBeenCalledTimes(1);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 0);
      expect(TailscaleOAuthClientMock).toHaveBeenCalledTimes(0);
      expect(TailscaleOAuthClientMock.prototype.authenticate).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock).toHaveBeenCalledTimes(0);
      expect(smClient).toHaveReceivedCommandTimes(DescribeSecretCommand, 0);
    });

    it('fails when SecretManager fails to retrieve the OAuth secret', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .rejectsOnce('mock reject get secret');
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock reject get secret');
      expect(Env.ensureEnvVarsAreSet).toHaveBeenCalledTimes(1);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(TailscaleOAuthClientMock).toHaveBeenCalledTimes(0);
      expect(TailscaleOAuthClientMock.prototype.authenticate).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock).toHaveBeenCalledTimes(0);
      expect(smClient).toHaveReceivedCommandTimes(DescribeSecretCommand, 0);
    });

    it('fails when the Tailscale OAuth authenticate call fails', async () => {
      const testError = Error('Test Error');
      TailscaleOAuthClientMock.prototype.authenticate.mockReset();
      TailscaleOAuthClientMock.prototype.authenticate.mockImplementationOnce(
        () => Promise.reject(testError),
      );
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(testError);
      expect(Env.ensureEnvVarsAreSet).toHaveBeenCalledTimes(1);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(TailscaleOAuthClientMock).toHaveBeenCalledTimes(1);
      expect(TailscaleOAuthClientMock.prototype.authenticate).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock).toHaveBeenCalledTimes(0);
      expect(smClient).toHaveReceivedCommandTimes(DescribeSecretCommand, 0);
    });

    it('fails when SecretsManager fails to describe the secret to rotate', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .rejects('mock reject describe secret');
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock reject describe secret');
      expect(Env.ensureEnvVarsAreSet).toHaveBeenCalledTimes(1);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(TailscaleOAuthClientMock).toHaveBeenCalledTimes(1);
      expect(TailscaleOAuthClientMock.prototype.authenticate).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock).toHaveBeenCalledWith(
        Env.TAILNET,
        Env.TAG_NAME,
        accessToken,
      );
      expect(smClient).toHaveReceivedCommandTimes(DescribeSecretCommand, 1);
    });
  });

  describe('rotateSecret check if secret version is staged correctly', () => {
    const step = 'createSecret';

    it('no rotation enabled', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: false,
          VersionIdsToStages: {
            versionId: [
              'SomeStage',
            ],
          },
          ...describeSecretTagsObj,
        });
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(`Secret ${secretId} does not have rotation enabled`);
    });

    it('no version stages', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: undefined,
          ...describeSecretTagsObj,
        });
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(
        `Secret version ${requestToken} has no stage for rotation at `
        + `secret ${secretId}`,
      );
    });

    it('requestToken is missing in version stages', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: {
            unrelated: [SecretStages.Pending],
            another: [],
          },
          ...describeSecretTagsObj,
        });
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(
        `Secret version ${requestToken} has no stage for rotation at `
        + `secret ${secretId}`,
      );
    });

    it('version is staged as current version already - nothing to do', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: {
            versionId: [SecretStages.Current],
            another: [SecretStages.Pending],
          },
          ...describeSecretTagsObj,
        });
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).resolves.toBeUndefined();
      // No further actions required, check that it doesn't do anything else:
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('version is not staged as pending', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: {
            versionId: ['unrelated'],
            another: [SecretStages.Current],
          },
          ...describeSecretTagsObj,
        });
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(
        `Secret version ${requestToken} not set as AWSPENDING for rotation `
        + `of secret ${secretId}`,
      );
    });
  });

  describe('createSecret - %s', () => {
    const step = 'createSecret';

    beforeEach(() => {
      smClient
        .on(PutSecretValueCommand)
        .resolvesOnce({});
      TailscaleApiKeyClientMock.prototype.createKey.mockImplementationOnce(
        () => Promise.resolve(clientKey),
      );
    });

    it('Tailscale createKey API call failed', async () => {
      const apiError = Error('Test API Error');
      TailscaleApiKeyClientMock.prototype.createKey.mockReset();
      TailscaleApiKeyClientMock.prototype.createKey.mockImplementationOnce(
        () => Promise.reject(apiError),
      );
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('Test API Error');
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledWith(
        keyUsageType,
      );
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('SecretManager fails to put the secret value', async () => {
      smClient.reset(); // Required to setup non happy path
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: {
            versionId: [SecretStages.Pending],
            another: [SecretStages.Current],
          },
          ...describeSecretTagsObj,
        });
      smClient
        .on(PutSecretValueCommand)
        .rejectsOnce('mock fail put secret value');
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock fail put secret value');
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledWith(
        keyUsageType,
      );
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(PutSecretValueCommand, {
        ClientRequestToken: requestToken,
        SecretId: secretId,
        SecretString: JSON.stringify(clientKey),
        VersionStages: [
          SecretStages.Pending,
        ],
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('happy path', async () => {
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).resolves.toBeUndefined();
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledWith(
        keyUsageType,
      );
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(PutSecretValueCommand, {
        ClientRequestToken: requestToken,
        SecretId: secretId,
        SecretString: JSON.stringify(clientKey),
        VersionStages: [
          SecretStages.Pending,
        ],
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });
  });

  describe.each(['testSecret', 'setSecret'])('%s', (step: string) => {
    it('SecretManager fails to fetch the secret value', async () => {
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: secretId,
            VersionId: requestToken,
          },
        )
        .rejectsOnce('mock fail get secret value');
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock fail get secret value');
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
      expect(smClient).toHaveReceivedNthSpecificCommandWith(1, GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(smClient).toHaveReceivedNthSpecificCommandWith(2, GetSecretValueCommand, {
        SecretId: secretId,
        VersionId: requestToken,
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('Tailscale verifyKey failed', async () => {
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: secretId,
            VersionId: requestToken,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(clientKey),
        });
      const validationError = Error('Test Validation Error');
      TailscaleApiKeyClientMock.prototype.verifyKey.mockImplementationOnce(
        () => Promise.reject(validationError),
      );
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('Test Validation Error');
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
      expect(smClient).toHaveReceivedNthSpecificCommandWith(1, GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(smClient).toHaveReceivedNthSpecificCommandWith(2, GetSecretValueCommand, {
        SecretId: secretId,
        VersionId: requestToken,
      });
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledWith(
        clientKey.id,
        keyUsageType,
      );
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('happy path', async () => {
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: secretId,
            VersionId: requestToken,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(clientKey),
        });
      TailscaleApiKeyClientMock.prototype.verifyKey.mockImplementationOnce(
        () => Promise.resolve(),
      );
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).resolves.toBeUndefined();
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
      expect(smClient).toHaveReceivedNthSpecificCommandWith(1, GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(smClient).toHaveReceivedNthSpecificCommandWith(2, GetSecretValueCommand, {
        SecretId: secretId,
        VersionId: requestToken,
      });
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(1);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledWith(
        clientKey.id,
        keyUsageType,
      );
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });
  });

  describe.each(['first run', 'rotated before'])('finishSecret %s', (runTitle) => {
    const step = 'finishSecret';

    beforeEach(() => {
      const versionStages: { [key: string]: string[] } = {
        versionId: [
          SecretStages.Pending,
        ],
        otherId: [
          'irrelevantStage',
        ],
      };
      if (runTitle === 'rotated before') {
        versionStages.currentId = [SecretStages.Current];
      }
      smClient.reset();
      smClient
        .on(
          GetSecretValueCommand,
          {
            SecretId: Env.OAUTH_SECRET_ARN,
            VersionStage: SecretStages.Current,
          },
        )
        .resolvesOnce({
          SecretString: JSON.stringify(oauthSecret),
        });
      smClient
        .on(DescribeSecretCommand)
        .resolves({
          RotationEnabled: true,
          VersionIdsToStages: versionStages,
          ...describeSecretTagsObj,
        });
    });

    it('SecretManager fails to update secret version stage', async () => {
      smClient
        .on(UpdateSecretVersionStageCommand)
        .rejectsOnce('mock fail update secret version stage');
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow('mock fail update secret version stage');
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(UpdateSecretVersionStageCommand, {
        SecretId: secretId,
        VersionStage: SecretStages.Current,
        MoveToVersionId: requestToken,
        RemoveFromVersionId: runTitle === 'first run' ? undefined : 'currentId',
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });

    it('happy path', async () => {
      smClient
        .on(UpdateSecretVersionStageCommand)
        .resolvesOnce({});
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).resolves.toBeUndefined();
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedNthSpecificCommandWith(1, GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(UpdateSecretVersionStageCommand, {
        SecretId: secretId,
        VersionStage: SecretStages.Current,
        MoveToVersionId: requestToken,
        RemoveFromVersionId: runTitle === 'first run' ? undefined : 'currentId',
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });
  });

  describe('wrong step name', () => {
    const step = 'promoteToTopSecret';

    it('should fail correctly', async () => {
      await expect(rotateSecret(
        smClient as any,
        secretId,
        requestToken,
        step,
      )).rejects.toThrow(`Invalid step parameter ${step} for secret ${secretId}`);
      expect(smClient).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
      expect(smClient).toHaveReceivedCommandWith(GetSecretValueCommand, {
        SecretId: Env.OAUTH_SECRET_ARN,
        VersionStage: SecretStages.Current,
      });
      // No other actions required
      expect(smClient).toHaveReceivedCommandTimes(PutSecretValueCommand, 0);
      expect(smClient).toHaveReceivedCommandTimes(UpdateSecretVersionStageCommand, 0);
      expect(TailscaleApiKeyClientMock.prototype.createKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.verifyKey).toHaveBeenCalledTimes(0);
      expect(TailscaleApiKeyClientMock.prototype.deleteKey).toHaveBeenCalledTimes(0);
    });
  });
});
