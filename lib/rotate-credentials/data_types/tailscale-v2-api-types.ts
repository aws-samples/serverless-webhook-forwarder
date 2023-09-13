// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

export interface DeviceCreateCapabilities {
  readonly reusable?: boolean;
  readonly ephemeral?: boolean;
  readonly preauthorized?: boolean;
  readonly tags?: string[];
}

export interface DeviceCapabilities {
  readonly create: DeviceCreateCapabilities;
}

export interface Capabilities {
  readonly devices: DeviceCapabilities;
}

export interface DescribeAuthKeyResponse {
  readonly id: string;
  readonly created: string;
  readonly expires: string;
  readonly revoked?: string;
  readonly capabilities: Capabilities;
}

export interface CreateAuthKeyResponse extends DescribeAuthKeyResponse {
  readonly key: string;
}

export interface AuthenticateResponse {
  readonly access_token: string;
}
