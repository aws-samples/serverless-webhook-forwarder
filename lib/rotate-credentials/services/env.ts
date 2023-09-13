// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import InputValueError from '../data_types/input-value-error';

interface ProcessEnv {
  OAUTH_SECRET_ARN: string;
  TAILNET: string;
  TAG_NAME: string;
}

export function ensureEnvVarsAreSet(): void {
  if ((process.env.OAUTH_SECRET_ARN ?? '').length === 0) {
    throw new InputValueError(
      'Could not determine what Tailscale OAuth Secret to read. '
      + 'Please specify the OAUTH_SECRET_ARN environment variable.',
    );
  }
  if ((process.env.TAILNET ?? '').length === 0) {
    throw new InputValueError(
      'Could not determine what Tailscale TailNet to use. '
      + 'Please specify the TAILNET environment variable.',
    );
  }
  if ((process.env.TAG_NAME ?? '').length === 0) {
    throw new InputValueError(
      'Could not determine what Tailscale Tag Name to apply. '
      + 'Please specify the TAG_NAME environment variable.',
    );
  }
}

export const {
  OAUTH_SECRET_ARN,
  TAILNET,
  TAG_NAME,
} = process.env as NodeJS.ProcessEnv & ProcessEnv;
