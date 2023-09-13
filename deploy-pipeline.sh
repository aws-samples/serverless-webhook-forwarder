#!/usr/bin/env bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0

set -e

mkdir -p \
  ./lib/authoriser/dist \
  ./lib/layer/dist \
  ./lib/rotate-credentials/dist \
  ./lib/webhook-forwarder/dist

touch \
  ./lib/authoriser/dist/index.js \
  ./lib/layer/dist/tailscale-layer.zip \
  ./lib/rotate-credentials/dist/index.js \
  ./lib/webhook-forwarder/dist/index.js

npm ci
npx cdk deploy
