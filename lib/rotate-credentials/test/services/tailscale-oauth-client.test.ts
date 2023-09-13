// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import TailscaleOAuthClient, {
  TailscaleOAuthCredentials,
} from '../../services/tailscale-oauth-client';

import {
  setupFetchResolvedMock,
  setupFetchRejectsMock,
} from '../helpers';

const originalFetch = global.fetch;
const tailscaleOAuthAPIUrl = 'https://api.tailscale.com/api/v2/oauth/token';

describe('TailscaleOAuthClient', () => {
  const credentials: TailscaleOAuthCredentials = {
    id: 'oauth-id',
    key: 'oauth-secret-key',
  };
  const b64AuthString = Buffer.from(`${credentials.id}:${credentials.key}`)
    .toString('base64');
  const authHeaders = {
    Authorization: `Basic ${b64AuthString}`,
  };

  afterEach(() => {
    // Reset fetch
    global.fetch = originalFetch;
  });

  describe('happy path', () => {
    const correctClientCredentials = 'super-secret-access-token';

    beforeEach(() => {
      setupFetchResolvedMock({ access_token: correctClientCredentials });
    });

    it('fetches client key credentials using the Tailscale API', async () => {
      const tsOAuthClient = new TailscaleOAuthClient(credentials);
      const clientCredentials: string = await tsOAuthClient.authenticate();
      expect(clientCredentials).toBe(correctClientCredentials);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        tailscaleOAuthAPIUrl,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            grant_type: 'client_credentials',
          }),
        },
      );
    });
  });

  describe('403 Error', () => {
    beforeEach(() => {
      setupFetchResolvedMock({}, {}, 403);
    });

    it('fetches client key credentials results in 403 forbidden', async () => {
      const tsOAuthClient = new TailscaleOAuthClient(credentials);
      await expect(
        tsOAuthClient.authenticate(),
      ).rejects.toThrow(
        `The POST request for ${tailscaleOAuthAPIUrl} resulted in: 403`,
      );
    });
  });

  describe('API Error', () => {
    const apiError = Error('The API Error');
    beforeEach(() => {
      setupFetchRejectsMock(apiError);
    });

    it('fails to fetch client key credentials using the Tailscale API', async () => {
      const tsOAuthClient = new TailscaleOAuthClient(credentials);
      await expect(
        tsOAuthClient.authenticate(),
      ).rejects.toBe(apiError);
    });
  });
});
