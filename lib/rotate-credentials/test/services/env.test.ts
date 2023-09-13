// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { ensureEnvVarsAreSet } from '../../services/env';

describe('ensureEnvVarsAreSet', () => {
  it('is missing OAUTH_SECRET_ARN', () => {
    process.env.OAUTH_SECRET_ARN = '';
    expect(() => ensureEnvVarsAreSet()).toThrow(
      'Could not determine what Tailscale OAuth Secret to read. '
      + 'Please specify the OAUTH_SECRET_ARN environment variable.',
    );
  });

  it('is missing TAILNET', () => {
    process.env.OAUTH_SECRET_ARN = 'something';
    process.env.TAILNET = '';
    expect(() => ensureEnvVarsAreSet()).toThrow(
      'Could not determine what Tailscale TailNet to use. '
      + 'Please specify the TAILNET environment variable.',
    );
  });

  it('is missing TAILNET', () => {
    process.env.OAUTH_SECRET_ARN = 'something';
    process.env.TAILNET = 'tailNet';
    process.env.TAG_NAME = '';
    expect(() => ensureEnvVarsAreSet()).toThrow(
      'Could not determine what Tailscale Tag Name to apply. '
      + 'Please specify the TAG_NAME environment variable.',
    );
  });

  it('is all set properly', () => {
    process.env.OAUTH_SECRET_ARN = 'something';
    process.env.TAILNET = 'tailNet';
    process.env.TAG_NAME = 'tagName';
    expect(ensureEnvVarsAreSet()).toBeUndefined();
  });
});
