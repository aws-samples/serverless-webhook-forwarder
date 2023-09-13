// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import {
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  SecretsManagerRotationHandler,
  SecretsManagerRotationEvent,
} from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';

import rotateSecret from './services/secret-rotation';

export const logger = new Logger({ serviceName: 'tailscaleClientKeyRotation' });
export const secretManagerClient = new SecretsManagerClient({});

/**
 * Lambda Handler for SecretsManager Rotation request.
 *
 * This handler retrieves a new credential set from the TailScale API.
 *
 * @param event: SecretsManagerRotationEvent The SecretsManager Rotation event.
 *
 * @returns Promise<void>
 */
export const handler: SecretsManagerRotationHandler = async (
  event: SecretsManagerRotationEvent,
): Promise<void> => {
  logger.info(
    `Rotation step: ${event.Step} with client request token: `
    + `${event.ClientRequestToken} on secret ${event.SecretId}`,
  );
  await rotateSecret(
    secretManagerClient,
    event.SecretId,
    event.ClientRequestToken,
    event.Step,
  );
};

export default {
  handler,
};
