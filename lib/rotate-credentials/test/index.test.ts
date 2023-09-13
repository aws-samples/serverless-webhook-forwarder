// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { jest } from '@jest/globals';
import {
  SecretsManagerRotationEvent,
} from 'aws-lambda';

import * as secretRotationService from '../services/secret-rotation';
import { secretManagerClient, handler } from '../index';

describe('index', () => {
  const rotateSecret = jest.spyOn(secretRotationService, 'default');
  const secretId = 'test-secret-id';
  const clientRequestToken = 'test-req-id';
  const step = 'createSecret';
  const baseEvent: SecretsManagerRotationEvent = {
    SecretId: secretId,
    ClientRequestToken: clientRequestToken,
    Step: step,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    rotateSecret.mockReset();
  });

  describe('handler only', () => {
    it('happy path rotateSecret succeeds', async () => {
      rotateSecret.mockImplementationOnce(() => Promise.resolve());
      await expect(handler(
        {
          ...baseEvent,
        },
        {} as any,
        {} as any,
      )).resolves;
      expect(rotateSecret).toHaveBeenCalledTimes(1);
      expect(rotateSecret).toHaveBeenCalledWith(
        secretManagerClient,
        secretId,
        clientRequestToken,
        step,
      );
    });

    it('fails when the rotateSecret call fails', async () => {
      const testError = Error('Test error');
      rotateSecret.mockImplementationOnce(() => Promise.reject(testError));
      await expect(handler(
        {
          ...baseEvent,
        },
        {} as any,
        {} as any,
      )).rejects.toThrow(testError);
      expect(rotateSecret).toHaveBeenCalledTimes(1);
      expect(rotateSecret).toHaveBeenCalledWith(
        secretManagerClient,
        secretId,
        clientRequestToken,
        step,
      );
    });
  });
});
