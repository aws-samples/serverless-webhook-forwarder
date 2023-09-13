#!/usr/bin/env bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0

# Abort on error
set -e

CURRENT_UID=$(id -u)
CURRENT_GID=$(id -g)

echo "Building container..."
docker build \
  --build-arg="USER_UID=${CURRENT_UID}" \
  --build-arg="USER_GID=${CURRENT_GID}" \
  -t lambda-layer-builder .
echo "Container is ready."

echo "Creating target dist directory"
mkdir -p dist

if [[ ! -e ./dependency-version.lock.sh ]]; then
  echo "Dependency version lock file does not exist yet"
  echo "Creating dependency version lock file so it can be written to"
  touch ./dependency-version.lock.sh
fi

if [[ "${REBUILD_DEPENDENCY_VERSION_LOCK}" == "YES" ]]; then
  echo "Rebuilding dependency version lock file as requested."
  mv ./dependency-version.lock.sh ./dependency-version-old.lock.sh
  touch ./dependency-version.lock.sh
fi

current_dir=$(pwd)
echo "Build layer with docker..."
docker run --rm \
  -v "/etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt:/etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt:ro" \
  -v "${current_dir}/dependency-version.lock.sh:/tmp/layer/dependency-version.lock.sh" \
  -v "${current_dir}/dist:/tmp/layer/dist" \
  lambda-layer-builder

if [[ "${REBUILD_DEPENDENCY_VERSION_LOCK}" == "YES" ]]; then
  echo "Result of rebuilding dependency version lock file as requested."
  echo "File: ./lib/layer/dependency-version.lock.sh"
  echo "------- BEGIN FILE CONTENT -------"
  cat ./dependency-version.lock.sh
  echo "------- END FILE CONTENT ---------"
fi
