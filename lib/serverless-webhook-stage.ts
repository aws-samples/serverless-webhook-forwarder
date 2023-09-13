// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { Aspects, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cdkNag from 'cdk-nag';
import ServerlessWebhookStack from './serverless-webhook-stack';
import Ec2DemoStack from './demoEc2-stack';

export interface ServerlessWebhookStageProps extends StageProps {
  readonly cfnDeploymentRoleArns?: string[];
  readonly lambdaLogLevel?: string;
  readonly tailnet?: string;
  readonly targetTailscaleIp?: string;
  readonly targetTailscalePort?: string;
  readonly targetProxyResponseMode?: string;
  readonly webhookAllowedIpCidr?: string;
}

export default class ServerlessWebhookStage extends Stage {
  public readonly ec2Stack: Ec2DemoStack;

  constructor(scope: Construct, id: string, props: ServerlessWebhookStageProps) {
    super(scope, id, props);

    const webhookStack = new ServerlessWebhookStack(this, 'webhook', {
      cfnDeploymentRoleArns: props.cfnDeploymentRoleArns,
      lambdaLogLevel: props.lambdaLogLevel,
      tailnet: props.tailnet,
      targetTailscaleIp: props.targetTailscaleIp,
      targetTailscalePort: props.targetTailscalePort,
      targetProxyResponseMode: props.targetProxyResponseMode,
      webhookAllowedIpCidr: props.webhookAllowedIpCidr,
    });
    this.ec2Stack = new Ec2DemoStack(this, 'demoec2', {
      rotateCredsLambdaArn: webhookStack.rotateCredsLambda.functionArn,
    });

    // Add CDK-Nag checks on our CDK app
    Aspects.of(this).add(
      new cdkNag.AwsSolutionsChecks({
        verbose: true,
      }),
    );
  }

  static getStagePropsFromContect(
    scope: Construct,
  ): ServerlessWebhookStageProps {
    return {
      cfnDeploymentRoleArns: (
        scope.node.tryGetContext('cfnDeploymentRoleArns') ?? []
      ),
      lambdaLogLevel: scope.node.tryGetContext('lambdaLogLevel'),
      tailnet: scope.node.tryGetContext('tailnet'),
      targetTailscaleIp: scope.node.tryGetContext('targetTailscaleIp'),
      targetTailscalePort: scope.node.tryGetContext('targetTailscalePort'),
      targetProxyResponseMode: scope.node.tryGetContext(
        'targetProxyResponseMode',
      ),
      webhookAllowedIpCidr: scope.node.tryGetContext('webhookAllowedIpCidr'),
    };
  }
}
