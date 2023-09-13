// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import TailscaleApiKeyClient, {
  TailscaleClientKey,
  KeyUsageType,
} from '../../services/tailscale-api-key-client';

import {
  cloneObject,
  getDateInDays,
  setupFetchResolvedMock,
  setupFetchRejectsMock,
} from '../helpers';

const originalFetch = global.fetch;

describe('TailscaleApiKeyClient', () => {
  const accessToken = 'secret-token-to-test-with';
  const tailNet = 'tailnet-to-use';
  const tagName = 'tag-to-use';
  const tailscaleTailnetKeysUrl = `https://api.tailscale.com/api/v2/tailnet/${tailNet}/keys`;
  const defaultExpiryInSec = 90 * 24 * 3600;
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  };

  afterEach(() => {
    // Reset fetch
    global.fetch = originalFetch;
  });

  describe('init without credentials', () => {
    it('undefined', async () => {
      const tsClient = new TailscaleApiKeyClient(tailNet, tagName, undefined);
      await expect(tsClient.deleteKey('id')).rejects.toThrow(
        'No access token is configured yet, make sure you run the '
        + 'authenticate function first before.',
      );
    });

    it('empty string', async () => {
      const tsClient = new TailscaleApiKeyClient(tailNet, tagName, '');
      await expect(tsClient.deleteKey('id')).rejects.toThrow(
        'No access token is configured yet, make sure you run the '
        + 'authenticate function first before.',
      );
    });
  });

  describe.each([
    KeyUsageType.Reusable,
    KeyUsageType.SingleUse,
  ])('create key - %s', (keyUsageType: KeyUsageType) => {
    const baseTailscaleClientKeyDetails = {
      id: 'test-id',
      key: 'super-secret-client-key',
      created: getDateInDays(0),
      expires: getDateInDays(61),
      capabilities: {
        devices: {
          create: {
            reusable: keyUsageType === KeyUsageType.Reusable,
            ephemeral: true,
            preauthorized: false,
            tags: [
              `tag:${tagName}`,
            ],
          },
        },
      },
    };
    const correctClientKeyDetails = {
      id: baseTailscaleClientKeyDetails.id,
      key: baseTailscaleClientKeyDetails.key,
      created: baseTailscaleClientKeyDetails.created,
      expires: baseTailscaleClientKeyDetails.expires,
    };

    it('creates a new client key', async () => {
      setupFetchResolvedMock(baseTailscaleClientKeyDetails, {});
      const tsClient = new TailscaleApiKeyClient(tailNet, tagName, accessToken);
      const clientKeyDetails: TailscaleClientKey = await tsClient.createKey(
        keyUsageType,
      );
      expect(clientKeyDetails).toStrictEqual(correctClientKeyDetails);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        tailscaleTailnetKeysUrl,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            capabilities: cloneObject(
              baseTailscaleClientKeyDetails.capabilities,
            ),
            expirySeconds: defaultExpiryInSec,
          }),
        },
      );
    });

    it('API returns 403 forbidden', async () => {
      setupFetchResolvedMock(baseTailscaleClientKeyDetails, {}, 403);
      const tsClient = new TailscaleApiKeyClient(tailNet, tagName, accessToken);
      await expect(tsClient.createKey(keyUsageType)).rejects.toThrow(
        `The POST request for ${tailscaleTailnetKeysUrl} resulted in: 403`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        tailscaleTailnetKeysUrl,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            capabilities: cloneObject(
              baseTailscaleClientKeyDetails.capabilities,
            ),
            expirySeconds: defaultExpiryInSec,
          }),
        },
      );
    });

    it('API failure is forwarded', async () => {
      const apiError = Error('API Error');
      setupFetchRejectsMock(apiError);
      const tsClient = new TailscaleApiKeyClient(tailNet, tagName, accessToken);
      await expect(tsClient.createKey(keyUsageType)).rejects.toThrow(apiError);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        tailscaleTailnetKeysUrl,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            capabilities: cloneObject(
              baseTailscaleClientKeyDetails.capabilities,
            ),
            expirySeconds: defaultExpiryInSec,
          }),
        },
      );
    });
  });

  describe.each([
    KeyUsageType.Reusable,
    KeyUsageType.SingleUse,
  ])('verify key - %s', (keyUsageType: KeyUsageType) => {
    const baseTailscaleClientKeyDetails = {
      id: 'test-id',
      key: 'super-secret-client-key',
      created: getDateInDays(0),
      expires: getDateInDays(61),
      capabilities: {
        devices: {
          create: {
            reusable: keyUsageType === KeyUsageType.Reusable,
            ephemeral: true,
            preauthorized: false,
            tags: [
              `tag:${tagName}`,
            ],
          },
        },
      },
    };
    const id = 'the-id';
    const tsClient = new TailscaleApiKeyClient(tailNet, tagName, accessToken);

    it('valid key data returned', async () => {
      setupFetchResolvedMock(baseTailscaleClientKeyDetails, {});
      await expect(tsClient.verifyKey(id, keyUsageType)).resolves.toBeTruthy();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `${tailscaleTailnetKeysUrl}/${id}`,
        {
          method: 'GET',
          headers: authHeaders,
        },
      );
    });

    it('expiry date is in the past', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          expires: getDateInDays(-1), // Yesterday
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The key expired on ${getDateInDays(-1)}`,
      );
    });

    it('expiry date is too close', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          expires: getDateInDays(59), // 60 days is minimum, so 59 should fail
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The key expires on ${getDateInDays(59)}, that is within the next `
        + '60 days',
      );
    });

    it('expiry date is 61 days in the future', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          expires: getDateInDays(61), // Minimum future expiry
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).resolves.toBeTruthy();
    });

    it('key is revoked', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          revoked: getDateInDays(-1), // Yesterday
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The key was revoked on ${getDateInDays(-1)}`,
      );
    });

    it('key is scheduled to be revoked too soon', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          revoked: getDateInDays(59), // Minimum of 60 days again
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The key was revoked on ${getDateInDays(59)}`,
      );
    });

    it('key is scheduled to be revoked in the future', async () => {
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          revoked: getDateInDays(61), // Future music, no worries
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).resolves.toBeTruthy();
    });

    it('key is/is not allowed to create reusable sessions', async () => {
      const capabilities = {
        devices: {
          create: {
            ...cloneObject(
              baseTailscaleClientKeyDetails.capabilities.devices.create,
            ),
            // Wrong on purpose, so it toggles the opposite way:
            reusable: keyUsageType === KeyUsageType.SingleUse,
          },
        },
      };
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          capabilities,
        },
      );
      const errorDetail = (
        keyUsageType === KeyUsageType.Reusable
          ? 'not reusable, while it should be'
          : 'reusable, while it should not be'
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The client authentication key (${id}) is ${errorDetail}! `
        + `Capability: ${JSON.stringify(capabilities)}`,
      );
    });

    it('key is not allowed to create ephemeral sessions', async () => {
      const capabilities = {
        devices: {
          create: {
            ...cloneObject(
              baseTailscaleClientKeyDetails.capabilities.devices.create,
            ),
            ephemeral: false,
          },
        },
      };
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          capabilities,
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The client authentication key (${id}) is not ephemeral! `
        + `Capability: ${JSON.stringify(capabilities)}`,
      );
    });

    it('key does not have any tags', async () => {
      const capabilities = {
        devices: {
          create: {
            ...cloneObject(
              baseTailscaleClientKeyDetails.capabilities.devices.create,
            ),
            tags: undefined,
          },
        },
      };
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          capabilities,
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The client authentication key (${id}) is not tagged properly! `
        + `Capability: ${JSON.stringify(capabilities)}`,
      );
    });

    it('key does not have the required tag', async () => {
      const capabilities = {
        devices: {
          create: {
            ...cloneObject(
              baseTailscaleClientKeyDetails.capabilities.devices.create,
            ),
            tags: ['tag:unrelated', 'tag:irrelevant'],
          },
        },
      };
      setupFetchResolvedMock(
        baseTailscaleClientKeyDetails,
        {
          capabilities,
        },
      );
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The client authentication key (${id}) is not tagged properly! `
        + `Capability: ${JSON.stringify(capabilities)}`,
      );
    });

    it('API returns 404 not found', async () => {
      setupFetchResolvedMock(baseTailscaleClientKeyDetails, {}, 404);
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The key ${id} was not found`,
      );
    });

    it('API returns 403 forbidden', async () => {
      setupFetchResolvedMock(baseTailscaleClientKeyDetails, {}, 403);
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(
        `The GET request for ${tailscaleTailnetKeysUrl}/${id} resulted in: 403`,
      );
    });

    it('API failure is forwarded', async () => {
      const apiError = Error('API Error');
      setupFetchRejectsMock(apiError);
      await expect(tsClient.verifyKey(id, keyUsageType)).rejects.toThrow(apiError);
    });
  });

  describe('delete key', () => {
    const id = 'the-id';
    const tsClient = new TailscaleApiKeyClient(tailNet, tagName, accessToken);

    it('happy path', async () => {
      setupFetchResolvedMock({}, {});
      await expect(tsClient.deleteKey(id)).resolves;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `${tailscaleTailnetKeysUrl}/${id}`,
        {
          method: 'DELETE',
          headers: authHeaders,
        },
      );
    });

    it('API returns 404 not found', async () => {
      setupFetchResolvedMock({}, {}, 404);
      await expect(tsClient.deleteKey(id)).rejects.toThrow(
        `The key ${id} was not found`,
      );
    });

    it('API returns 403 forbidden', async () => {
      setupFetchResolvedMock({}, {}, 403);
      await expect(tsClient.deleteKey(id)).rejects.toThrow(
        `The DELETE request for ${tailscaleTailnetKeysUrl}/${id} resulted in: 403`,
      );
    });
  });
});
