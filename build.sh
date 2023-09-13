#!/usr/bin/env bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0

set -ex

function buildLayer() {
  echo "Building Tailscale Lambda Layer..."
  mkdir -p cdk.out
  cd lib/layer
  ./build-with-docker.sh
  cp ./dist/tailscale-layer.zip ../../cdk.out/tailscale-layer.zip
  cd ../..
  echo "Tailscale Lambda Layer built successfully"
}

function buildWebhookForwader() {
  echo "Building Webhook Forwarder Lambda..."
  cd lib/webhook-forwarder
  npm run build
  npm run lint
  cd ../..
  echo "Webhook Forwarder Lambda built successfully"
}

function buildAuthoriser() {
  echo "Building Custom Authoriser Function Lambda..."
  cd lib/authoriser
  npm run build
  npm run lint
  cd ../..
  echo "Lambda Authoriser built successfully"
}

function buildRotateCredentials() {
  echo "Building Custom Authoriser Function Lambda..."
  cd lib/rotate-credentials
  npm run build
  npm run lint
  cd ../..
  echo "Rotate Credentials Lambda built successfully"
}

echo "Running build.sh"
npm ci

if command -v yum >/dev/null; then
  buildLayer
else
  echo "Skipping layer build, this requires Amazon Linux"
fi

buildWebhookForwader

buildAuthoriser

buildRotateCredentials

echo "All done in build.sh"
