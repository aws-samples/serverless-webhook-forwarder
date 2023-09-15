// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import {
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
} from 'aws-cdk-lib/aws-codebuild';
import { Repository as CCRepository } from 'aws-cdk-lib/aws-codecommit';
import {
  CodeBuildStep,
  CodePipeline as CdkCodePipelineL3,
  CodePipelineSource as CdkCodePipelineSourceL3,
  ManualApprovalStep,
} from 'aws-cdk-lib/pipelines';
import {
  CloudFormationDeleteStackAction,
  ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import {
  Role,
} from 'aws-cdk-lib/aws-iam';
import ServerlessWebhookStage from './serverless-webhook-stage';

export default class PipelineStack extends cdk.Stack {
  readonly pipelineL3: CdkCodePipelineL3;

  private static readonly BUILD_IMAGE = (
    LinuxBuildImage.fromCodeBuildImageId(
      'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
    )
  );

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = new CCRepository(this, 'repo', {
      repositoryName: 'serverless-webhook',
      description: 'Serverless Webhook repository',
    });

    const codeCommit = CdkCodePipelineSourceL3.codeCommit(
      repo,
      'main',
    );

    // Create the pipeline
    this.pipelineL3 = new CdkCodePipelineL3(this, 'Pipeline', {
      pipelineName: 'Serverless-Webhook-Forwarder-Pipeline',
      publishAssetsInParallel: false,
      synth: new CodeBuildStep('Synth', {
        buildEnvironment: {
          buildImage: PipelineStack.BUILD_IMAGE,
          computeType: ComputeType.MEDIUM,
          privileged: true,
        },
        input: codeCommit,
        partialBuildSpec: BuildSpec.fromObject({
          version: '0.2',
          'run-as': 'codebuild-user',
          env: {
            variables: {
              HOME: '/home/codebuild-user',
            },
          },
          phases: {
            install: {
              'run-as': 'root',
              'runtime-versions': {
                nodejs: 18,
              },
              commands: [
                'chmod 666 /var/run/docker.sock',
                'mkdir -p /home/codebuild-user',
                'chown -R codebuild-user:codebuild-user /home/codebuild-user',
                'chmod ug+x /home/codebuild-user',
              ],
            },
          },
        }),
        commands: [
          './build.sh',
          'mkdir -p cdk.out',
          'npm ci',
          'npm run build',
          'npm run lint',
          'npm run cdk -- synth --all --require-approval never',
        ],
        primaryOutputDirectory: 'cdk.out',
      }),
    });

    const deployWave = this.pipelineL3.addWave('deploy', {});

    const serverlessWebhookStage = new ServerlessWebhookStage(
      this,
      'serverless-webhook',
      {
        ...ServerlessWebhookStage.getStagePropsFromContect(scope),
        stageName: 'Deploy',
      },
    );

    // Add the serverless webhook stage to the deploy wave along with a manual
    // action before the demo stack
    deployWave.addStage(
      serverlessWebhookStage,
      {
        stackSteps: [
          {
            stack: serverlessWebhookStage.ec2Stack,
            pre: [
              new ManualApprovalStep('oauth-update-manual-step', {
                comment: 'Update oAuth secret before proceeding',
                // TODO Would be good to add link to the oauth secret in the approval message, e.g.:
                // externalEntityLink: serverlessWebhookStage.ec2Stack.stackOutput('oauth-url'),
              }),
            ],
          },
        ],
      },
    );

    const cloudFormationExecutionRoleName = (
      `cdk-${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}-cfn-exec-`
      + `role-${serverlessWebhookStage.ec2Stack.account}`
      + `-${serverlessWebhookStage.ec2Stack.region}`
    );

    // Create the action that will delete the demo stack
    const deleteEc2StackAction = new CloudFormationDeleteStackAction({
      actionName: 'Delete-demoec2-stack',
      adminPermissions: false,
      stackName: serverlessWebhookStage.ec2Stack.stackName,
      runOrder: 2,
      deploymentRole: Role.fromRoleName(
        this,
        'CfnExecutionRole',
        cloudFormationExecutionRoleName,
        {
          mutable: false,
        },
      ),
    });

    // Add approval step before we delete the demo stack
    const approvalAction = new ManualApprovalAction({
      actionName: 'Approval',
      additionalInformation: 'Approval required before we delete',
      runOrder: 1,
    });

    // Convert Level 3 CDK Pipeline Construct to Level 2 CodePipeline construct
    this.pipelineL3.buildPipeline();
    const pipelineL2 = this.pipelineL3.pipeline;

    // Add delete stage
    pipelineL2.addStage({
      stageName: 'Delete',
      actions: [
        approvalAction,
        deleteEc2StackAction,
      ],
    });

    NagSuppressions.addResourceSuppressions(
      this.pipelineL3,
      [
        {
          id: 'AwsSolutions-CB3',
          reason: 'We need docker in the build process',
        },
        {
          id: 'AwsSolutions-CB4',
          reason: 'KMS encryption is not enabled as this is a PoC',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK Pipeline requires these permissions',
        },
        {
          id: 'AwsSolutions-S1',
          reason: 'No access logs on the artifact bucket required',
        },
      ],
      true,
    );
  }
}
