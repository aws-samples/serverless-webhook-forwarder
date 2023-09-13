// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import type * as TailscaleV2Api from '../data_types/tailscale-v2-api-types';
import TailscaleApiError from '../data_types/tailscale-api-error';
import TailscaleApiUnauthenticatedError from '../data_types/tailscale-api-unauth-error';
import TailscaleApiKeyNotFoundError from '../data_types/tailscale-api-key-not-found-error';
import TailscaleVerifyExpiredError from '../data_types/tailscale-verify-expired-error';
import TailscaleVerifyRevokedError from '../data_types/tailscale-verify-revoked-error';
import TailscaleVerifyCapabilityError from '../data_types/tailscale-verify-capability-error';

export interface Headers {
  [key: string]: string;
}

export enum KeyUsageType {
  Reusable = 'Cattle',
  SingleUse = 'Pet',
}

export interface TailscaleAuthHeaders extends Headers {
  readonly Authorization: string;
}

export interface TailscaleClientKey {
  readonly id: string;
  readonly key: string;
  readonly created: string;
  readonly expires: string;
}

export default class TailscaleApiKeyClient {
  protected readonly tailscaleApiUrl = 'https://api.tailscale.com/api/v2';

  protected static readonly keyDefaultLifetimeInSec = 90 * 24 * 3600;

  protected static readonly keyMinimumFutureExpiryInDays = 60;

  protected readonly tailNet: string;

  protected readonly tagName: string;

  protected readonly accessToken?: string;

  constructor(tailNet: string, tagName: string, accessToken?: string) {
    this.tailNet = tailNet;
    this.tagName = tagName;
    this.accessToken = accessToken;
  }

  protected getAuthHeaders(): TailscaleAuthHeaders {
    if (this.accessToken == null || this.accessToken.length === 0) {
      throw new TailscaleApiUnauthenticatedError(
        'No access token is configured yet, make sure you run the '
        + 'authenticate function first before.',
      );
    }
    return {
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  protected async sendRequest(method: string, body?: object, id?: string): Promise<unknown> {
    const result = await fetch(
      this.getTailnetKeysUrl(id),
      {
        method,
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
      },
    );
    if (result.status === 404 && id != null) {
      throw new TailscaleApiKeyNotFoundError(
        `The key ${id} was not found`,
      );
    }
    if (!result.ok) {
      throw new TailscaleApiError(
        `The ${method} request for ${this.getTailnetKeysUrl(id)} resulted `
        + `in: ${result.status}`,
      );
    }

    return result.json();
  }

  protected getTailnetKeysUrl(id?: string): string {
    const suffix = (
      id == null
        ? ''
        : `/${id}`
    );
    return `${this.tailscaleApiUrl}/tailnet/${this.tailNet}/keys${suffix}`;
  }

  async createKey(keyUsageType: KeyUsageType): Promise<TailscaleClientKey> {
    const response = await this.sendRequest(
      'POST',
      {
        capabilities: {
          devices: {
            create: {
              reusable: keyUsageType === KeyUsageType.Reusable,
              ephemeral: true,
              preauthorized: false,
              tags: [
                `tag:${this.tagName}`,
              ],
            },
          },
        },
        expirySeconds: TailscaleApiKeyClient.keyDefaultLifetimeInSec,
      },
    ) as TailscaleV2Api.CreateAuthKeyResponse;

    return {
      id: response.id,
      key: response.key,
      created: response.created,
      expires: response.expires,
    };
  }

  async verifyKey(id: string, keyUsageType: KeyUsageType): Promise<boolean> {
    const response = await this.sendRequest(
      'GET',
      undefined, // No body
      id,
    ) as TailscaleV2Api.DescribeAuthKeyResponse;

    const expiryDate = new Date(response.expires);
    if (expiryDate < new Date()) {
      throw new TailscaleVerifyExpiredError(
        `The key expired on ${response.expires}`,
      );
    }

    const shouldBeValidOnDate = new Date();
    shouldBeValidOnDate.setDate(
      shouldBeValidOnDate.getDate()
      + TailscaleApiKeyClient.keyMinimumFutureExpiryInDays,
    );
    if (expiryDate < shouldBeValidOnDate) {
      throw new TailscaleVerifyExpiredError(
        `The key expires on ${response.expires}, that is within the next `
        + `${TailscaleApiKeyClient.keyMinimumFutureExpiryInDays} days`,
      );
    }

    const revokeDate = response.revoked ? new Date(response.revoked) : undefined;
    if (revokeDate && revokeDate < shouldBeValidOnDate) {
      throw new TailscaleVerifyRevokedError(
        `The key was revoked on ${response.revoked}`,
      );
    }

    const correctReusableState = keyUsageType === KeyUsageType.Reusable;
    if (response.capabilities.devices.create.reusable !== correctReusableState) {
      const errorDetail = (
        correctReusableState
          ? 'not reusable, while it should be'
          : 'reusable, while it should not be'
      );
      throw new TailscaleVerifyCapabilityError(
        `The client authentication key (${id}) is ${errorDetail}! `
        + `Capability: ${JSON.stringify(response.capabilities)}`,
      );
    }

    if (response.capabilities.devices.create.ephemeral === false) {
      throw new TailscaleVerifyCapabilityError(
        `The client authentication key (${id}) is not ephemeral! `
        + `Capability: ${JSON.stringify(response.capabilities)}`,
      );
    }

    if (response.capabilities.devices.create.tags == null) {
      throw new TailscaleVerifyCapabilityError(
        `The client authentication key (${id}) is not tagged properly! `
        + `Capability: ${JSON.stringify(response.capabilities)}`,
      );
    }
    if (response.capabilities.devices.create.tags.indexOf(`tag:${this.tagName}`) === -1) {
      throw new TailscaleVerifyCapabilityError(
        `The client authentication key (${id}) is not tagged properly! `
        + `Capability: ${JSON.stringify(response.capabilities)}`,
      );
    }

    return true;
  }

  async deleteKey(id: string): Promise<void> {
    await this.sendRequest(
      'DELETE',
      undefined, // No body
      id,
    );
  }
}
