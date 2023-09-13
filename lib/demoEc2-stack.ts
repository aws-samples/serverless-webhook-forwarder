// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface Ec2StackProps extends cdk.StackProps {
  readonly rotateCredsLambdaArn: string;
}

export default class Ec2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Ec2StackProps) {
    super(scope, id, props);

    const { rotateCredsLambdaArn } = props;

    // Create a secret to store a single use key to authenticate the EC2 to the Tailnet
    const tsDemoSecret = new secretsmanager.Secret(this, 'TsDemoAuthKeySecret', {
      description: (
        'Secret to contain the single use Tailscale auth key for the demo EC2 instance. '
        + 'This should be autopopulated by the secrets rotation logic.'
      ),
    });
    cdk.Tags.of(tsDemoSecret).add('Purpose', 'Pet');
    NagSuppressions.addResourceSuppressions(
      tsDemoSecret,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'The demo secret is valid only once, no rotation required',
        },
      ],
    );

    // This creates a rotation schedule for the OAuth client credentials stored in Secrets Manager
    new secretsmanager.CfnRotationSchedule(this, 'tsAuthDemoRotationScheduleCfn', {
      secretId: tsDemoSecret.secretArn,
      rotateImmediatelyOnUpdate: true,
      rotationLambdaArn: rotateCredsLambdaArn,
      rotationRules: {},
    });

    // Create a VPC with a single public and private subnet in 1 AZ
    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 1,
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          name: 'privateSubnet',
          cidrMask: 24,
        },
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'publicSubnet',
          cidrMask: 24,
        },
      ],
    });
    NagSuppressions.addResourceSuppressions(
      vpc,
      [
        {
          id: 'AwsSolutions-VPC7',
          reason: 'PoC only, no Flow Logs configured to reduce runtime cost',
        },
      ],
    );

    const ec2NoInbound = new ec2.SecurityGroup(this, 'ec2NoInbound', { vpc });

    const demoInstanceRole = new iam.Role(this, 'DemoInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      inlinePolicies: {
        allowReadTSSecret: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AllowTsAuthGetCurrentKey',
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DeleteSecret',
              ],
              effect: iam.Effect.ALLOW,
              resources: [
                tsDemoSecret.secretArn,
              ],
            }),
          ],
        }),
      },
    });

    // Add managed role AmazonSSMManagedInstanceCore to EC2 instance to
    // support session manager
    demoInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'AmazonSSMManagedInstanceCore',
      ),
    );
    NagSuppressions.addResourceSuppressions(
      demoInstanceRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AmazonSSMManagedInstanceCore requires no restrictions',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
          ],
        },
      ],
    );

    // Create the demoEC2 instance and run a simply python webserver
    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      role: demoInstanceRole,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2NoInbound,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(
            8,
            {
              encrypted: true,
              volumeType: ec2.EbsDeviceVolumeType.GP3,
            },
          ),
        },
      ],
      init: ec2.CloudFormationInit.fromElements(
        // Create a simple config file that runs a Python web server
        ec2.InitService.systemdConfigFile('simpleserver', {
          command: '/usr/bin/python3 -m http.server 8080',
          cwd: '/var/www/html',
        }),
        // Start the server using SystemD
        ec2.InitService.enable('simpleserver', {
          serviceManager: ec2.ServiceManager.SYSTEMD,
        }),
        // Drop an example file to show the web server working
        ec2.InitFile.fromString('/var/www/html/index.html', 'Hello! It\'s working!'),
      ),
    });
    NagSuppressions.addResourceSuppressions(
      instance,
      [
        {
          id: 'AwsSolutions-EC28',
          reason: 'Demo instance does not require detailed monitoring',
        },
        {
          id: 'AwsSolutions-EC29',
          reason: (
            'Demo instance does not require auto-scaling or termination '
            + 'protection'
          ),
        },
      ],
    );
    cdk.Tags.of(instance).add('InstallTailscale', 'Yes');

    // Create a SSM document content to install Tailscale and delete the single use secret once done
    const docContent = {
      schemaVersion: '2.2',
      description: 'SSM Run Command document to install Tailscale',
      mainSteps: [
        {
          action: 'aws:runShellScript',
          name: 'installTailscale',
          inputs: {
            timeoutSeconds: '600',
            runCommand: [
              'echo "Sleep for 10s in case of a conflict with patch manager locking DNF"',
              'sleep 10',
              'sudo dnf update && sudo dnf upgrade -y',
              'sudo dnf install \'dnf-command(config-manager)\' -y',
              'sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/amazon-linux/2/tailscale.repo',
              'sudo dnf install tailscale -y',
              'sudo dnf install jq -y',
              'sudo systemctl enable --now tailscaled',
              `TSAUTHKEY=$(aws secretsmanager get-secret-value --secret-id ${tsDemoSecret.secretName} --version-stage AWSCURRENT | jq -r '.SecretString | fromjson | .key')`,
              'sudo tailscale up --authkey=$TSAUTHKEY --hostname=demoEc2Instance',
            ],
          },
        },
      ],
    };

    // Create the SSM document in Systems Manager
    const ssmCommandDoc = new ssm.CfnDocument(this, 'installTailscaleDoc', {
      documentType: 'Command',
      content: docContent,
    });

    const ssmAutomationExecRole = new iam.Role(this, 'AutomationExecRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.ServicePrincipal('ssm.amazonaws.com'),
        {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'aws:SourceArn': cdk.Arn.format(
              {
                service: 'ssm',
                resource: 'automation-execution',
                resourceName: '*',
                arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              },
              this,
            ),
          },
        },
      ),
      inlinePolicies: {
        allowReadTSSecret: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AllowAutomationToMonitorCommands',
              actions: [
                'ssm:DescribeInstanceInformation',
                'ssm:ListCommands',
                'ssm:ListCommandInvocations',
              ],
              effect: iam.Effect.ALLOW,
              resources: [
                '*',
              ],
            }),
            new iam.PolicyStatement({
              sid: 'AllowDescribeInstanceStatus',
              actions: [
                'ec2:DescribeInstanceStatus',
              ],
              effect: iam.Effect.ALLOW,
              resources: [
                '*',
              ],
              conditions: {
                StringEquals: {
                  'ec2:Region': this.region,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: 'AllowAutomationToRunCommands',
              actions: [
                'ssm:SendCommand',
              ],
              effect: iam.Effect.ALLOW,
              resources: [
                cdk.Arn.format(
                  {
                    service: 'ssm',
                    resource: 'document',
                    resourceName: ssmCommandDoc.ref,
                    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                  },
                  this,
                ),
                cdk.Arn.format(
                  {
                    service: 'ec2',
                    resource: 'instance',
                    resourceName: instance.instanceId,
                    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                  },
                  this,
                ),
                cdk.Arn.format(
                  {
                    service: 'ssm',
                    resource: 'managed-instance',
                    resourceName: instance.instanceId,
                    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                  },
                  this,
                ),
              ],
            }),
          ],
        }),
      },
    });
    NagSuppressions.addResourceSuppressions(
      ssmAutomationExecRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The demo secret is valid only once, no rotation required',
          appliesTo: [
            'Resource::*',
          ],
        },
      ],
    );

    // Create the SSM Automation to run the run command and manage retries
    const ssmAutomation = new ssm.CfnDocument(this, 'installTailscaleAutomation', {
      documentType: 'Automation',
      content: {
        schemaVersion: '0.3',
        description: 'SSM Automation document to orchestrate running of the run command',
        assumeRole: '{{AutomationAssumeRole}}',
        parameters: {
          InstanceId: {
            description: 'The instance ID',
            type: 'String',
          },
          AutomationAssumeRole: {
            default: '',
            description: (
              'The ARN of the role that Automation needs to perform the '
              + 'installation tasks to perform the actions on your behalf.'
            ),
            type: 'String',
          },
        },
        mainSteps: [
          {
            name: 'fetchInstanceState',
            action: 'aws:executeAwsApi',
            timeoutSeconds: 60,
            onFailure: 'Continue',
            isCritical: true,
            inputs: {
              Service: 'ec2',
              Api: 'DescribeInstanceStatus',
              InstanceIds: [
                '{{InstanceId}}',
              ],
            },
            outputs: [
              {
                Name: 'InstanceState',
                Selector: '$.InstanceStatuses[0].InstanceState.Name',
                Type: 'String',
              },
            ],
          },
          {
            name: 'checkInstanceStartingOrRunning',
            action: 'aws:branch',
            // Stop if we don't match a specific case:
            isEnd: true,
            inputs: {
              Choices: [
                {
                  // If it is starting, lets wait until it runs
                  NextStep: 'waitUntilInstanceRuns',
                  Variable: '{{fetchInstanceState.InstanceState}}',
                  StringEquals: 'pending',
                },
                {
                  // If it is running, jump to runRunCommand directly
                  NextStep: 'runRunCommand',
                  Variable: '{{fetchInstanceState.InstanceState}}',
                  StringEquals: 'running',
                },
                // In all other cases ('shutting-down', 'terminated',
                // 'stopping', 'stopped') the instance cannot run the
                // commands that we require.
                //
                // Prior deployments of this stack might be included
                // in the tag selection of the association.
                // Hence, we need to make sure these are filtered out
                // with a Success state.
              ],
            },
          },
          {
            name: 'waitUntilInstanceRuns',
            action: 'aws:waitForAwsResourceProperty',
            timeoutSeconds: 180,
            onFailure: 'Abort',
            isCritical: true,
            inputs: {
              Service: 'ec2',
              Api: 'DescribeInstanceStatus',
              InstanceIds: [
                '{{InstanceId}}',
              ],
              PropertySelector: '$.InstanceStatuses[0].InstanceState.Name',
              DesiredValues: [
                'running',
              ],
            },
          },
          {
            name: 'assertInstanceRuns',
            action: 'aws:assertAwsResourceProperty',
            onFailure: 'Abort',
            isCritical: true,
            inputs: {
              Service: 'ec2',
              Api: 'DescribeInstanceStatus',
              InstanceIds: [
                '{{InstanceId}}',
              ],
              PropertySelector: '$.InstanceStatuses[0].InstanceState.Name',
              DesiredValues: [
                'running',
              ],
            },
          },
          {
            name: 'runRunCommand',
            action: 'aws:runCommand',
            onFailure: 'Abort',
            maxAttempts: 30,
            isEnd: true,
            isCritical: true,
            inputs: {
              DocumentName: ssmCommandDoc.ref,
              InstanceIds: [
                '{{InstanceId}}',
              ],
            },
          },
        ],
      },
    });

    // Associate the SSM automation document with the EC2 instance
    const association = new ssm.CfnAssociation(this, 'ssmDocAssociation', {
      name: ssmAutomation.ref,
      automationTargetParameterName: 'InstanceId',
      documentVersion: '$LATEST',
      parameters: {
        AutomationAssumeRole: [
          ssmAutomationExecRole.roleArn,
        ],
      },
      targets: [{
        key: 'tag:InstallTailscale',
        values: ['Yes'],
      }],
      waitForSuccessTimeoutSeconds: 180,
    });
    // Make sure this is added after the instance is created, so 3 minutes
    // of waiting is sufficient time for it to launch and install.
    association.node.addDependency(instance);
  }
}
