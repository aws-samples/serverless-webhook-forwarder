// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2alpha from '@aws-cdk/aws-apigatewayv2-alpha';
import {
  HttpLambdaIntegration,
} from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';

export interface ServerlessWebhookStackProps extends cdk.StackProps {
  readonly cfnDeploymentRoleArns?: string[];
  readonly lambdaLogLevel?: string;
  readonly tailnet?: string;
  readonly targetTailscaleIp?: string;
  readonly targetTailscalePort?: string;
  readonly targetProxyResponseMode?: string;
  readonly webhookAllowedIpCidr?: string;
}

export default class ServerlessWebhookStack extends cdk.Stack {
  public readonly rotateCredsLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ServerlessWebhookStackProps) {
    super(scope, id, props);

    const cfnDeploymentRoleArns: string[] = props.cfnDeploymentRoleArns ?? [];

    // This is the API Gateway that will be used to handle the webhook requests
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'powertoolsLayer',
      (
        `arn:aws:lambda:${cdk.Stack.of(this).region}:094274105915:`
        + 'layer:AWSLambdaPowertoolsTypeScript:11'
      ),
    );

    // This creates the Tailscale Extension Layer.  Lambda layers are versioned, hence
    // we set the removal policy to retain the old layer when we create a new one.
    const tailscaleLayer = new lambda.LayerVersion(this, 'TailscaleLayer', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'layer/dist/tailscale-layer.zip'),
      ),
      compatibleArchitectures: [
        lambda.Architecture.X86_64,
      ],
    });

    const tsSecret = new secretsmanager.Secret(this, 'TsAuthKeySecret', {
      description: (
        'Secret to contain the Tailscale auth key. '
        + 'This should be autopopulated by the secrets rotation logic.'
      ),
    });
    cdk.Tags.of(tsSecret).add('Purpose', 'Cattle');

    // This is the Lambda function that will be used to handle the
    // API Gateway requests. It will forward requests to the chosen
    // TS_TARGET IP/hostname and optionally return a response.
    const lambdaFn = new lambda.Function(this, 'WebhookForwarder', {
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      description: 'Webhook Forwarder',
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'webhook-forwarder/dist'),
      ),
      environment: {
        SECRET_NAME: tsSecret.secretName,
        TS_TARGET: props.targetTailscaleIp ?? '100.x.y.z',
        TS_PORT: props.targetTailscalePort ?? '8080',
        PROXY_RESPONSE: props.targetProxyResponseMode ?? 'FULL',
        LOG_LEVEL: props.lambdaLogLevel ?? 'info',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [
        tailscaleLayer,
        powertoolsLayer,
      ],
    });

    // The secrete that will contain the OAuth client credentials
    const oAuthSecret = new secretsmanager.Secret(this, 'TsOAuthSecret', {
      description: 'Secret to contain the Tailscale oAuth API keys.',
    });
    NagSuppressions.addResourceSuppressions(
      oAuthSecret,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'The Tailscale OAuth credentials need to be rotated manually',
        },
      ],
    );

    // This Lambda function is used to rotate the Tailscale Authorisation Key
    // stored in Secrets Manager.  It is autopopulated and updated every 2 months
    // by the rotateCreds Lambda function
    this.rotateCredsLambda = new lambda.Function(this, 'rotate-credentials', {
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      description: 'Webhook Forwarder',
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'rotate-credentials/dist'),
      ),
      environment: {
        OAUTH_SECRET_ARN: oAuthSecret.secretArn,
        SECRET_NAME: tsSecret.secretName,
        LOG_LEVEL: props.lambdaLogLevel ?? 'info',
        TAG_NAME: 'lambdawebhookforwarder',
        TAILNET: props.tailnet ?? 'undefined',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [
        powertoolsLayer,
      ],
    });
    this.rotateCredsLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowUpdatingTheDemoEc2Secret',
      actions: [
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecretVersionStage',
      ],
      effect: iam.Effect.ALLOW,
      resources: [
        cdk.Arn.format(
          {
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            resource: 'secret',
            resourceName: 'TsDemoAuthKeySecret*',
            service: 'secretsmanager',
          },
          cdk.Stack.of(this),
        ),
      ],
    }));
    NagSuppressions.addResourceSuppressions(
      this.rotateCredsLambda,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: (
            'The secret will be created by another stack, exact ARN starts '
            + 'with this prefix'
          ),
          appliesTo: [
            'Resource::arn:<AWS::Partition>:secretsmanager:<AWS::Region>:'
            + '<AWS::AccountId>:secret:TsDemoAuthKeySecret*',
          ],
        },
      ],
      true,
    );

    // This will allow webhook forwarder lambda to retrieve
    // the current Tailscale auth key from Secrets Manager.
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowWebhookLambdaToRead',
        principals: [
          lambdaFn.grantPrincipal,
        ],
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
        conditions: {
          StringEquals: {
            'secretsmanager:VersionStage': [
              'AWSCURRENT',
            ],
          },
        },
      }),
    );

    // This will deny everyone except the webhook forwarder and credentials rotation
    // lambdas from reading the Tailscale auth key
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyOthersToRead',
        notPrincipals: [
          lambdaFn.grantPrincipal,
          this.translateLambdaToSTSAssumedArn(lambdaFn),
          this.rotateCredsLambda.grantPrincipal,
          this.translateLambdaToSTSAssumedArn(this.rotateCredsLambda),
          // Uncomment the below line to allow you to view the secret value (e.g. in the console)
          // new iam.ArnPrincipal(`insert your role arn here + assumed role'),
          new iam.AccountPrincipal(cdk.Stack.of(this).account),
        ],
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        effect: iam.Effect.DENY,
        resources: [
          '*',
        ],
      }),
    );

    // This will allow the credentials rotation lambda to read and update the Tailscale Auth key
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRotationLambdaToDescribeAndPut',
        principals: [
          this.rotateCredsLambda.grantPrincipal,
        ],
        actions: [
          'secretsmanager:DescribeSecret',
          'secretsmanager:PutSecretValue',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
      }),
    );

    // This will allow the credentials rotation lambda to read only the current version of
    // the Tailscale Auth key
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRotationLambdaToGetPending',
        principals: [
          this.rotateCredsLambda.grantPrincipal,
        ],
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
        conditions: {
          StringEquals: {
            'secretsmanager:VersionStage': [
              'AWSPENDING',
            ],
          },
        },
      }),
    );

    // This will allow the credentials rotation lambda to update only the current version
    // of the Tailscale Auth key
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRotationLambdaToUpdateVersion',
        principals: [
          this.rotateCredsLambda.grantPrincipal,
        ],
        actions: [
          'secretsmanager:UpdateSecretVersionStage',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
        conditions: {
          StringEquals: {
            'secretsmanager:VersionStage': [
              'AWSCURRENT',
            ],
          },
        },
      }),
    );

    // This will deny everyone except the credentials rotation lambda from writing to
    // the Tailscale Auth key.
    tsSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyAnyOtherToWrite',
        notPrincipals: [
          this.rotateCredsLambda.grantPrincipal,
          this.translateLambdaToSTSAssumedArn(this.rotateCredsLambda),
          new iam.AccountPrincipal(cdk.Stack.of(this).account),
        ],
        actions: [
          'secretsmanager:PutSecretValue',
          'secretsmanager:UpdateSecretVersionStage',
        ],
        effect: iam.Effect.DENY,
        resources: [
          '*',
        ],
      }),
    );

    // If the cfnDeploymentRoleArns value has been populated in the cdk.context.json file
    // this will allow that role to delete or write the Tailscale Auth key resource policy
    // and deny everyone else this permission.  If this value has not been populated in
    // cdk.context.json then no restriction on who can delete or write to this resource
    // policy is applied.
    if (cfnDeploymentRoleArns.length > 0) {
      tsSecret.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowPipelineToUpdate',
          principals: cfnDeploymentRoleArns.map(
            (arn) => new iam.ArnPrincipal(arn),
          ),
          actions: [
            'secretsmanager:DeleteResourcePolicy',
            'secretsmanager:PutResourcePolicy',
          ],
          effect: iam.Effect.ALLOW,
          resources: [
            '*',
          ],
        }),
      );
      tsSecret.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'DenyNonPipelinePolicyUpdates',
          notPrincipals: [
            ...cfnDeploymentRoleArns.map(
              (arn) => new iam.ArnPrincipal(arn),
            ),
            new iam.AccountPrincipal(cdk.Stack.of(this).account),
          ],
          actions: [
            'secretsmanager:DeleteResourcePolicy',
            'secretsmanager:PutResourcePolicy',
          ],
          effect: iam.Effect.DENY,
          resources: [
            '*',
          ],
        }),
      );
    }

    // This will allow users and roles in this account to read and update the OAuth key secret
    oAuthSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowUsersAndRolesToWrite',
        principals: [
          new iam.AccountPrincipal(cdk.Stack.of(this).account),
        ],
        actions: [
          'secretsmanager:DescribeSecret',
          'secretsmanager:PutSecretValue',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
      }),
    );

    // This will allow the credentials rotation lambda to read and update the current
    // version of the OAuth key secret
    oAuthSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRotationLambdaToRead',
        principals: [
          this.rotateCredsLambda.grantPrincipal,
        ],
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          '*',
        ],
        conditions: {
          StringEquals: {
            'secretsmanager:VersionStage': [
              'AWSCURRENT',
            ],
          },
        },
      }),
    );

    // If the cfnDeploymentRoleArns value has been populated in the cdk.context.json file
    // this will allow that role to delete or write the Tailscale oAuth key resource policy
    // and deny everyone else this permission.  If this value has not been populated in
    // cdk.context.json then no restriction on who can delete or write to this resource
    // policy is applied.
    if (cfnDeploymentRoleArns.length > 0) {
      oAuthSecret.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowPipelineToUpdate',
          principals: cfnDeploymentRoleArns.map(
            (arn) => new iam.ArnPrincipal(arn),
          ),
          actions: [
            'secretsmanager:DeleteResourcePolicy',
            'secretsmanager:PutResourcePolicy',
          ],
          effect: iam.Effect.ALLOW,
          resources: [
            '*',
          ],
        }),
      );
    }

    // This lambda handles your authorisation logic for your endpoint exposed
    // via API Gateway, please find more information at:
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-apigatewayv2-authorizers-alpha-readme.html
    const customAuthLambdaFn = new lambda.Function(this, 'customAuthoriser', {
      memorySize: 128,
      timeout: cdk.Duration.seconds(15),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      description: 'Custom authoriser for API - allows specific IP range only',
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'authoriser/dist'),
      ),
      environment: {
        AUTHD_SOURCE_CIDR: props.webhookAllowedIpCidr ?? '0.0.0.0/32',
        LOG_LEVEL: props.lambdaLogLevel ?? 'info',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [
        powertoolsLayer,
      ],
    });

    // This creates a rotation schedule for the OAuth client credentials stored in Secrets Manager
    new secretsmanager.RotationSchedule(this, 'tsAuthRotationSchedule', {
      secret: tsSecret,
      rotationLambda: this.rotateCredsLambda,
      automaticallyAfter: cdk.Duration.days(60),
      rotateImmediatelyOnUpdate: false,
    });

    // The following resources create the API Gateway HTTP API with associated configuration
    const webhookFwderIntegration = new HttpLambdaIntegration(
      'WebhookfwderIntegration',
      lambdaFn,
    );

    // Creates the custom authorizer that the API uses to restrict access to source IP CIDR range
    const authorizer = new HttpLambdaAuthorizer(
      'webhookforwarderauthoriser',
      customAuthLambdaFn,
      {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        resultsCacheTtl: cdk.Duration.seconds(0),
        identitySource: ['$context.identity.sourceIp'],
      },
    );

    // Creates the API Gateway HTTP API
    const webHookApi = new apigwv2alpha.HttpApi(this, 'webhookForwarderApi', {
      defaultIntegration: webhookFwderIntegration,
      defaultAuthorizer: authorizer,
    });
    if (webHookApi.defaultStage == null) {
      throw Error('Default stage is missing');
    }
    const logGroup = new logs.LogGroup(this, 'APIGWAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });
    logGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));
    const stage = webHookApi.defaultStage.node.defaultChild as apigwv2.CfnStage;
    stage.accessLogSettings = {
      destinationArn: logGroup.logGroupArn,
      format: JSON.stringify({
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        requestId: '$context.requestId',
        requestTime: '$context.requestTime',
        responseLength: '$context.responseLength',
        sourceIp: '$context.identity.sourceIp',
        status: '$context.status',
        userAgent: '$context.identity.userAgent',
      }),
    };

    // Adds a route to the API Gateway HTTP API
    webHookApi.addRoutes({
      integration: webhookFwderIntegration,
      path: '/',
      authorizer,
    });

    // Export the API Gateway URL
    new cdk.CfnOutput(this, 'Webhook URL', {
      value: webHookApi.apiEndpoint,
    });

    // Add permission to the webhook forwarder Lambda to read the Secret with
    // the Tailscale authorisation key
    lambdaFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'getSecretValue',
      actions: [
        'secretsmanager:GetSecretValue',
      ],
      effect: iam.Effect.ALLOW,
      resources: [
        tsSecret.secretArn,
      ],
    }));

    // Add permission to the rotateCreds Lambda to read the oAuth secret
    this.rotateCredsLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowReadingOAuthSecret',
      actions: [
        'secretsmanager:GetSecretValue',
      ],
      effect: iam.Effect.ALLOW,
      resources: [
        oAuthSecret.secretArn,
      ],
    }));

    NagSuppressions.addResourceSuppressions(
      lambdaFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole requires no restrictions',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
    );

    NagSuppressions.addResourceSuppressions(
      [
        customAuthLambdaFn,
        lambdaFn,
        this.rotateCredsLambda,
      ],
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole requires no restrictions',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'X-Ray tracing requires no restrictions',
          appliesTo: [
            'Resource::*',
          ],
        },
      ],
      true,
    );
  }

  translateLambdaToSTSAssumedArn(lambdaFn: lambda.IFunction): iam.IPrincipal {
    return new iam.ArnPrincipal(cdk.Arn.format(
      {
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        service: 'sts',
        region: '',
        resource: 'assumed-role',
        resourceName: `${lambdaFn.role?.roleName ?? 'no-role'}/${lambdaFn.functionName}`,
      },
      cdk.Stack.of(this),
    ));
  }
}
