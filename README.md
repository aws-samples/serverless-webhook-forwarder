<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
-->

# Serverless Webhook Forwarder

This CDK project deploys the following architecture:

![AWS Architecture diagram showing serverless webhook
architecture](./images/ArchitectureDiagram.png)

You can read more about this solution in the [AWS Compute blog
here](https://aws.amazon.com/blogs/compute/building-a-secure-webhook-forwarder-using-an-aws-lambda-extension-and-tailscale/).

**Please note:** this sample uses an alpha CDK library to deploy the API Gateway.
This alpha library is not marked as stable yet, and therefore might introduce
breaking changes with future releases.

## How-to deploy the solution

In order to deploy the solution, we need both an AWS account and a Tailscale account.
You can setup an [AWS account here](https://aws.amazon.com/free/) and a
[Tailscale Account here](https://tailscale.com/start).

### Setup Tailscale Account and credentials

First we will setup a free Tailscale account, setup an OAuth client (with
long-lived credentials) so that we can automatically generate authorisation
keys (with 90 day validity) and automatically update those via Secrets manager.

1. Go to [Tailscale Account here](https://tailscale.com/start) and create a
   free account.
2. Note down your organisation name from [this
   page](https://login.tailscale.com/admin/settings/general).

We will setup the OAuth client and credentials later in the process to avoid
needing to persist these credentials for any length of time.
We now move on to configuring and deploying the AWS components.

### Deploy AWS solution components

#### Step 1 - Deploy the AWS CDK stack

In order to deploy the solution we will use
[AWS Cloud9](https://aws.amazon.com/cloud9/). Login to the AWS console with
admin permissions and navigate to the Cloud9 service.

Click `Create Environment`, give this a name (e.g.
`ServerlessWebhookForwarder`), select the latest version of Ubuntu as the
platform, leave the rest of the defaults as is and click `Create`.
Once the environment is created, select it from your list of Environments and
then select `Open in Cloud9`.

In the terminal window that opens at the bottom of the screen, enter the
commands below in sequence (note you should replace {AWS_ACCOUNT_NUMBER} and
{REGION} with the account and region you want to deploy this solution into
(you can get the account number you are in by running the command:

```bash
aws sts get-caller-identity
```

This should be the account you are logged into Cloud9 with:

```bash
cdk bootstrap aws://{AWS_ACCOUNT_NUMBER}/{REGION}
git clone https://github.com/aws-samples/serverless-webhook-forwarder
```

This will bootstrap your account so it can run CDK projects and copy all the
code from the GitHub repo into your Cloud9 environment.

One of these files is the `cdk.context.json` file that contains the
configuration parameters that need to be completed.

Open this file (you can navigate to in the file directory in the left hand menu
of Cloud9) and make 1 edit:

1. Edit the value of the "tailnet" key to enter the name of your
   `Tailscale Organisation` you noted down earlier from [this
   page](https://login.tailscale.com/admin/settings/general) - this is probably
   your email address.

Leave the remaining fields with default values and save the file.
Your file will now look something like the below:

```json
{
  "cfnDeploymentRoleArns": [],
  "lambdaLogLevel": "info",
  "tailnet": "youremail@address.com",
  "targetTailscaleIp": "Tailscale IP of target to forward events to - should be of format 100.x.y.z",
  "targetTailscalePort": "8080",
  "targetProxyResponseMode": "FULL",
  "webhookAllowedIpCidr": "0.0.0.0/0"
}
```

We now need to copy the code repo from our Cloud9 instance to CodeCommit and
deploy the solution by running the commands below from the terminal window
(note you will need to replace {REGION} with the region you are using, e.g.
`eu-west-1`):

```bash
cd serverless-webhook-forwarder
./deploy-pipeline.sh
git remote set-url origin https://git-codecommit.{REGION}.amazonaws.com/v1/repos/serverless-webhook
git add .
git commit -m 'update cdk context'
git push
```

The deploy-pipeline.sh command will take a few minutes to run and will ask if
you wish to proceed after listing all the changes it will make, press `y` if
you are happy with these followed by `return` to proceed.

This will create the deployment pipeline in
[AWS CodePipeline](https://aws.amazon.com/codepipeline/) using
[AWS CloudFormation](https://aws.amazon.com/cloudformation/).
When you push the code to the CodeCommit repository, the pipeline will be
triggered and it will build and deploy the solution.

You can watch progress of the solution in
[CodePipeline](https://console.aws.amazon.com/codesuite/codepipeline/pipelines)
- it will take 5 – 10 minutes to fully deploy as it runs through the following
steps listed below.  Note that if you see the error message "Error calling startBuild.
Cannot have more than 1 builds in the queue for the account" in CodePipeline just click
the `Retry` button on that stage in CodePipeline.

1. **Source** - This downloads the source code into from CodeCommit.
2. **Build** – This stage is executed a number of times. The first time it
   runs, it executes the `build.sh` script in the project root. This is the
  shell script that builds the Lambda extension.
  It also packages some additional binaries into the extension that are
  dependencies, including the `tailscale` and `tailscaled` binaries. As well as
  `curl`, `jq` and `openssl`. These are all dependencies called in the
  `extension.sh` script that is the Lambda extension and sets up the Tailscale
  connection before registering the Lambda extension with the Lambda service.
3. **UpdatePipeline** - This stage updates the pipeline, such that changes to
  the pipeline stack and its deployment targets are automatically updated
  as defined by the CDK Pipelines code.
4. **Assets** - The assets generated in the Build step are copied into the
   deployment bucket to enable the CloudFormation templates to reference the
   assets with their S3 paths.
5. **serverless-webhook** – this is the final stage in which the generated
   CloudFormation templates are compared against what has been deployed
   (if the pipeline has been run before), identifies differences and then makes
   changes to align the deployed resources to what is defined in the updated
   CloudFormation template.

#### Step 2 - Setup Tailscale OAuth Client

In order to get and refresh, the Tailscale auth key that is used by the Lambda
function extension to authenticate to the Tailscale network. We generate an
OAuth client with the permissions to create and API key that means we can
generate a new Tailscale auth key every couple of months.

Secrets Manager will automatically do this every 60 days and update the auth
key before it expires. This is a one-time setup activity that will ensure
continued access to your Tailscale network.

To create an OAuth client, login to your Tailscale account we need to first
create a tag in Tailscale (required for OAuth client creation with correct
permissions), and then can we create the OAuth client:

##### Step 2.1 - Create tag

1. Go to [Access Controls](https://login.tailscale.com/admin/acls/file) in your
   Tailscale admin console
2. Add a tag which your user has access to. For example:

```json
// Define the tags which can be applied to devices and by which users.
"tagOwners": {
  "tag:lambdawebhookforwarder": ["autogroup:admin"],
},
```

3.	Click Save

##### Step 2.2 - Create the OAuth client

1. Go to the [Tailscale admin
    console](https://login.tailscale.com/admin/settings/oauth) and choose
    OAuth clients.  Select `Generate OAuth client`.
2. Select `Write` access for `Devices`.
3. Click the `Add tags` dropdown and select the tag you created earlier:

![screenshot of Tailscale UI showing addition of
tags](./images/tailscaleTags.png)

4. Click `Generate client`
5. Copy the client ID and the Client secret.
   Note this is the only chance to copy the client secret, you cannot retrieve
   its value later.

##### Step 2.3 - Store OAuth credentials in AWS

Next we store this OAuth Client secret in AWS Secrets Manager.
To do this navigate back to your terminal in Cloud9 or you can use the AWS CLI
via [AWS CloudShell](https://aws.amazon.com/cloudshell/).

1. Log into the [AWS
   Console](https://console.aws.amazon.com/secretsmanager/landing) and ensure
   you in the correct region.
2. Click on 'Secrets' from the left hand menu and the secret with
   'TsOAuthSecret' in the name (there will also be sequence of random
   characters in the name), and then copy the Secret name.
3. Click on CloudShell in the bottom left corner of your screen.
   This will start a terminal session with the AWS CLI installed and with the
   access permissions of the user you are logged in with (must have write
   permission to the AWS SSM parameter API).
4. To add your Tailscale OAuth client secret, enter the command (replacing
   `YOUR_CLIENT_ID` and `YOUR_CLIENT_SECRET` with your OAuth client secret ID
   and client secret) and SECRET_NAME with the secret name you copied in
  step 2.2:

```bash
aws secretsmanager put-secret-value \
  --secret-id SECRET_NAME \
  --secret-string "{\"id\":\"YOUR_CLIENT_ID\",\"key\":\"YOUR_CLIENT_SECRET\"}"
```

After entering this command you should get a JSON response that includes
`VersionId` among other values.  If you get a different response, check your
command and that your user has the right permissions and try again (if you get
a different version number, that’s fine, it just means you are updating an
existing parameter vs creating a first version of a new one).

5. Finally we tell Secrets Manager to use these credentials to get a Tailscale
auth key for the Lambda Layer and store this in another Secret (the
TsAuthKey secret).  To do this run the command below in the Cloud9 terminal or
CloudShell replacing `SECRET_NAME` with the TsAuthKey Secret - NOTE this is
**not** the same secret you just updated.

Make sure you get the right Secret Name from Secrets Manager, you should use
the TsAuthKey secret and not the TsOAuth secret.

```bash
aws secretsmanager rotate-secret --secret-id SECRET_NAME
```

With this done, the solution will be able to use the OAuth keys in the
Parameter Store to call the Tailscale API to generate auth tokens.
The first time the Secret is created, Secrets Manager will do this and store
the first auth token for use by the Lambda Extension.

#### Step 3 - Deploy the DemoEC2 stack

With the TsAuthKey secret now populated we can deploy the DemoEC2 stack which
will create an EC2 instance in a private subnet and connect to your Tailnet.
To do this, navigate to
[CodePipeline](https://console.aws.amazon.com/codesuite/codepipeline/), make
sure are in the right region, go to pipelines and select the
`Serverless-Webhook-Forwarder-Pipeline` pipeline, scroll the deploy stage and
click `Review` on the `demoec2.oauth-update-manual-step` step and then approve.
This will allow the pipeline to proceed and the EC2 instance to use the
TsAuthKey to connect to your Tailscale network.

Once this completes, login to your [Tailscale Machines
Page](https://login.tailscale.com/admin/machines) and note down the IP address
(in format 100.x.y.z) for the `demoec2instance`.

#### Step 4 - Update configuration files

Finally we update the remaining configuration values and rerun the pipeline to
update these.  Navigate to CodeCommit, select your repository and open the
`cdk.context.json` file we edited earlier.  Update the `targetTailscaleIp`
with the IP address of the DemoEc2 instance from the previous step as below, save
and commit the change (you can also directly update the environment variables on the
Lambda function).

This file will now looks something like:

```json
{
  "cfnDeploymentRoleArns": ["arn:aws:iam::123456789012:role/cdk-abc123def-cfn-exec-role-123456789012-eu-west-1"],
  "lambdaLogLevel": "info",
  "tailnet": "youremail@address.com",
  "targetTailscaleIp": "100.91.92.93",
  "targetTailscalePort": "8080",
  "targetProxyResponseMode": "FULL",
  "webhookAllowedIpCidr": "0.0.0.0/0"
}
```

#### Step 4 - Test

The final step is to test the solution to make sure it all works (make sure the
CodePipeline deployment has finished first).  You will need to retrieve 
your API URL from [API1 Gateway](https://console.aws.amazon.com/apigateway/home) 
by clicking on the `webhookForwarderApi` API and copying the `Invoke URL` from 
the subsequent screen.

When you put this URL into your browser, you will send a GET request to API
Gateway which will perform an authorisation check (initially by checking if
your IP is in the range `0.0.0.0/0`), proxy the request to the Webhookforwarder
Lambda function, which will then proxy the request over the Tailscale Tailnet
to the demo EC2 instance say in a private subnet via the NAT gateway.

The simple python webserver on the EC2 will then return “Hello! It’s working!”
to the Lambda function which will relay this to API Gateway that will then
relay this to your browser.  As long as you see the message
"Hello! It's working!" appear in your browser - you're done!

## Clean up

We provide a two-step clean up process:

1. Remove Demo EC2 stack - this includes the EC2 instance, VPC, NAT
   Gateway and related resources used for testing but will leave the Serverless
   webhook stack in place so that you can continue to use the Lambda Extension.
2. Remove Webhook Forwarder resources stack - this step describes how-to remove
   all webhook forwarder resources created by this CDK project. As well as the
   pipeline that creates and updates them.

### Remove Demo EC2 stack

There is a pipeline stage that waits for manual approval to proceed that will
remove the `Deploy-demoec2` stack.  In order to 'release' this stage login to
the [AWS CodePipeline
console](https://console.aws.amazon.com/codesuite/codepipeline/pipelines/),
make sure you are in the correct region and click on
`Serverless-Webhook-Forwarder-Pipeline`.  Scroll to the bottom of the page and
click on the `Review` button in the Delete Approval step. Once approved, this
will automatically delete the Demo EC2 stack and its resources.

### Remove Webhook Forwarder resources

In order to remove the resources from your account, you just need to delete the
two remaining stacks for the deployment pipeline and the serverless webhook
stack. To do this, navigate to the [AWS CloudFormation
console](https://console.aws.amazon.com/cloudformation/), select `Stacks` from
the left hand menu and the radio button next to the
`Deploy-webhook` stack and then press delete.

Do the same for the `Serverless-Webhook-PipelineStack`. This will instruct AWS
CloudFormation to delete all created resources within these stacks.

This will destroy all resources created earlier with the exception of the
created Lambda Extension Layer.  If you want to remove this to, navigate to the
[Lambda page](https://console.aws.amazon.com/lambda/home/), navigate to the
"Functions" page, select the `ServerlessWebhookLayer` and click "Delete" to
remove the layer.

## Additional Configuration Options

### Source IP restriction

API Gateway will request an authorisation decision from the authoriser Lambda
function. This Lambda function uses source IP from the request to make this
decision. You can add additional checks to the code to enhance the
authorisation rules.

The allowed source IPs are defined by the CIDR range put in the
`AUTHD_SOURCE_CIDR` environment variable. This can be set either via the
`cdk.context.json` file by changing the value of the `webhookAllowedIpCidr` key
or by updating the environment variable on the created Lambda function (e.g.
via the console). The default value is `0.0.0.0/0` (i.e. any source IP
address is allowed).

### Proxy response

The webhook forwarder Lambda Function also provides the ability to choose the
response returned to the external event producer via the environment variable
`PROXY_RESPONSE`. The options supported are:

1. FULL - proxy the full response back,
2. HTTP_CODE_HEADERS - only return the HTTP status code and headers,
3. HTTP_CODE - return the HTTP status code only.
4. 200 - simply return a default 200 status code to completely obfuscate the
   response from the target system.

The initial value is set to proxy the full response.
