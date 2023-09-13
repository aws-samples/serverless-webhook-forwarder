#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as cdkNag from 'cdk-nag';
import PipelineStack from '../lib/serverless-webhook-pipeline-stack';

const app = new cdk.App();
const pipelineStack = new PipelineStack(
  app,
  'Serverless-Webhook-PipelineStack',
  {},
);

// Add CDK-Nag checks on our CDK app
cdk.Aspects.of(pipelineStack).add(
  new cdkNag.AwsSolutionsChecks({
    verbose: true,
  }),
);
