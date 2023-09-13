#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Significantly modified version of original file here:
# https://github.com/aws-samples/aws-lambda-extensions/blob/main/custom-runtime-extension-demo/extensionssrc/extensions/extension1.sh

set -euo pipefail

OWN_FILENAME="$(basename "$0")"
LAMBDA_EXTENSION_NAME="$OWN_FILENAME" # (external) extension name has to match the filename
TMPOWN_FILENAME="$(basename -s .sh "$0")"
TMPFILE="/tmp/${TMPOWN_FILENAME}.dat"
touch "${TMPFILE}"
SEC_TAILSCALE_AUTH_KEY=""
TS_STATUS_FILE="/tmp/tsup"

# We now define some functions to be called later in the extension code

extecho () {
  echo "[${LAMBDA_EXTENSION_NAME}] $1"
}

# Graceful Shutdown
_term() {
  extecho "Received SIGTERM"
  # forward SIGTERM to child procs and exit
  kill -TERM "$PID" 2>/dev/null
  extecho "Exiting"
  exit 0
}

forward_sigterm_and_wait() {
  trap _term SIGTERM
  wait "$PID"
  trap - SIGTERM
}

# Extension stage 1: Initialization
# To run any extension processes that need to start before the runtime
# initializes, run them before the /register
extecho "Initialization"

# First we get the TS Auth key from Secrets Manager via an AWS Sigv4 request:

SERVICE="secretsmanager"
ENDPOINT="${SERVICE}.${AWS_REGION}.amazonaws.com"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATESTAMP="$(date -u +%Y%m%d)"
REQUEST_PAYLOAD="{\"SecretId\": \"$SECRET_NAME\"}"
API_ACTION=GetSecretValue

# Create the Signed request - see https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html for details on each step below.
# Please note we only do this manually to reduce the size of the lambda extension; for most use cases the AWS CLI or SDKs offer a much better solution.

# Step 1: Create canonical request

# Hash the payload - we need to output a binary and then convert to hex to avoid the stdin prefix. We add -c 256 to to extend to 256 octets per line to handle the length of the SHA256 checksum.
HASHED_REQUEST_PAYLOAD="$(echo -en "$REQUEST_PAYLOAD" | openssl dgst -sha256 -hex | sed 's/^.* //')"

# Create the canconical request string - not sure why line break is needed after headers?
CANONICAL_REQUEST="POST
/

content-type:application/x-amz-json-1.1
host:$ENDPOINT
x-amz-date:$TIMESTAMP
x-amz-security-token:$AWS_SESSION_TOKEN
x-amz-target:$SERVICE.$API_ACTION

content-type;host;x-amz-date;x-amz-security-token;x-amz-target
$HASHED_REQUEST_PAYLOAD"

# Step 2: Create a hash of the canonical request
HASHED_CANONICAL_REQUEST="$(echo -en "$CANONICAL_REQUEST" | openssl dgst -sha256 -hex | sed 's/^.* //')"

# Step 3: Create a String to Sign
STRING_TO_SIGN="AWS4-HMAC-SHA256\n$TIMESTAMP\n$DATESTAMP/$AWS_REGION/$SERVICE/aws4_request\n$HASHED_CANONICAL_REQUEST"

# Step 4: Calculate the signature. Note we need to convert the kSecret to a hex value, so we first write a simple
# bash function to convert ascii string to hex

string_to_hex() {
    local str="${1:-""}"
    local fmt="%x"
    local chr
    local -i i
    for i in `seq 0 "$((${#str}-1))"`; do
        chr="${str:i:1}"
        printf  "${fmt}" "'${chr}"
    done
}

kSecret="$(string_to_hex "AWS4$AWS_SECRET_ACCESS_KEY")"
kDate="$(echo -n "$DATESTAMP" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:${kSecret}" | sed 's/^.* //')"
kRegion="$(echo -n "$AWS_REGION" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:${kDate}" | sed 's/^.* //')"
kService="$(echo -n "$SERVICE" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:${kRegion}" | sed 's/^.* //')"
kSigning="$(echo -n "aws4_request" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:${kService}" | sed 's/^.* //')"
SIGNATURE="$(echo -en "$STRING_TO_SIGN" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:${kSigning}" | sed 's/^.* //')"

# Step 5: Add the signature to the request

export CURL_CA_BUNDLE=/opt/ssl/ca-bundle.trust.crt

AUTH_HEADER="Authorization: AWS4-HMAC-SHA256 Credential=$AWS_ACCESS_KEY_ID/$DATESTAMP/$AWS_REGION/$SERVICE/aws4_request,SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target,Signature=$SIGNATURE"

RESPONSE=$(curl -X POST \
  -H "accept:application/json" \
  -H "Accept-Encoding: identity" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -H "Host:$ENDPOINT" \
  -H "X-Amz-Date:$TIMESTAMP" \
  -H "X-Amz-Target:secretsmanager.GetSecretValue" \
  -H "X-Amz-Security-Token:$AWS_SESSION_TOKEN" \
  -d "$REQUEST_PAYLOAD" \
  "https://${ENDPOINT}" \
  )

# Finally we use jq to extract the secret value from the JSON response
SEC_TAILSCALE_AUTH_KEY="$(echo "$RESPONSE" | jq -r '.SecretString | fromjson | .key')"

# Start Tailscale - we use the bash script modified for the extension directory
# structure from the Tailscale documentation here.  Note these provide symbolic link from /tmp/ to the /var/run, /var/cache,
# /var/run and /var/task directories whereas here we explicitly defin the socket as /tmp/tailscale.sock - note that --socket
# is a flag for Tailscale, not of the 'up' sub-command
# https://tailscale.com/kb/1112/userspace-networking/ and https://tailscale.com/kb/1113/aws-lambda/
extecho "Starting Tailscale init process"
/opt/bin/tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --socket=/tmp/tailscale.sock --state /tmp/tailscale &
/opt/bin/tailscale --socket=/tmp/tailscale.sock up --authkey="$SEC_TAILSCALE_AUTH_KEY" --shields-up --hostname=aws-lambda-webhook-forwarder
extecho "Tailscale started"
ALL_PROXY=socks5://localhost:1055/
NO_PROXY=$AWS_LAMBDA_RUNTIME_API
extecho "Setup Tailscale as SOCKS5 server on port 1055 in the background"

# Run a while loop to check tailscale status and wait for it to be 'up' before continuing with the script.

MAX_ATTEMPTS=20
ATTEMPT=1
SLEEP=0.1

# Check if Tailscale is running
while [[ $(tailscale status) == *"stopped"* && $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  sleep "$SLEEP"
  extecho "Tailscale not up, waiting for $SLEEP seconds"
  ((attempt++))
done

if [[ $ATTEMPT -eq $MAX_ATTEMPTS ]]; then
  extecho "Warning: Tailscale did not reach a running state within the allowed attempts.  Continuing anyway"
else
  extecho "Tailscale has started. Continuing with the script..."
fi

# Extension stage 2: Registration
# The extension registration also signals to Lambda to start initializing
# the runtime.  Note, once initialised, we only do anything on a shutdown event with this extension.
HEADERS="$(mktemp)"
extecho "Registering at http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/register"
/opt/bin/curl -sS -LD "$HEADERS" \
  -X POST "http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/register" \
  -H "Lambda-Extension-Name: ${LAMBDA_EXTENSION_NAME}" \
  -d "{ \"events\": [\"SHUTDOWN\"] }" \
  -o "$TMPFILE"

RESPONSE="$(<$TMPFILE)"
HEADINFO="$(<$HEADERS)"
# Extract Extension ID from response headers
EXTENSION_ID="$(grep -Fi Lambda-Extension-Identifier "$HEADERS" | tr -d '[:space:]' | cut -d: -f2)"
extecho "Registration response: ${RESPONSE} with EXTENSION_ID ${EXTENSION_ID}"

# Extension stage 3: Event processing
# Continuous loop to wait for events from Extensions API
while true; do
  extecho "Waiting for event. Get /next event from http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/event/next"

  # Get an event. The HTTP request will block until one is received
  curl -sS -L \
    --noproxy '*' \
    -XGET "http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/event/next" \
    --header "Lambda-Extension-Identifier: ${EXTENSION_ID}" \
    > $TMPFILE &
  PID=$!
  forward_sigterm_and_wait

  EVENT_DATA="$(<$TMPFILE)"
  if [[ $EVENT_DATA == *"SHUTDOWN"* ]]; then
    /opt/bin/tailscale logout
    extecho "Received SHUTDOWN event. Exiting." 1>&2;
    exit 0 # Exit if we receive a SHUTDOWN event
  fi

  extecho "Received event: ${EVENT_DATA}"
  sleep 0.2

done
