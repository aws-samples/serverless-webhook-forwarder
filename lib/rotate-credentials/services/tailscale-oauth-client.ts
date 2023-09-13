// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import {
  type AuthenticateResponse,
} from '../data_types/tailscale-v2-api-types';
import TailscaleApiError from '../data_types/tailscale-api-error';

export interface Headers {
  [key: string]: string;
}

export interface TailscaleAuthHeaders extends Headers {
  readonly Authorization: string;
}

export interface TailscaleOAuthCredentials {
  readonly id: string;
  readonly key: string;
}

export default class TailscaleOAuth {
  protected readonly credentials: TailscaleOAuthCredentials;

  protected static readonly tailscaleOAuthApiUrl = 'https://api.tailscale.com/api/v2/oauth/token';

  constructor(credentials: TailscaleOAuthCredentials) {
    this.credentials = credentials;
  }

  protected async sendRequest(
    method: string,
    body: object,
  ): Promise<AuthenticateResponse> {
    const result = await fetch(
      TailscaleOAuth.tailscaleOAuthApiUrl,
      {
        method,
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
      },
    );
    if (!result.ok) {
      throw new TailscaleApiError(
        `The ${method} request for ${TailscaleOAuth.tailscaleOAuthApiUrl} `
        + `resulted in: ${result.status}`,
      );
    }
    const data = await result.json();
    return data;
  }

  protected getAuthHeaders(): TailscaleAuthHeaders {
    const oauthCredString = `${this.credentials.id}:${this.credentials.key}`;
    const oauthB64CredString: string = Buffer.from(oauthCredString)
      .toString('base64');
    return {
      Authorization: `Basic ${oauthB64CredString}`,
    };
  }

  async authenticate(): Promise<string> {
    const tokenData: AuthenticateResponse = await this.sendRequest(
      'POST',
      {
        grant_type: 'client_credentials',
      },
    );
    return tokenData.access_token;
  }
}
