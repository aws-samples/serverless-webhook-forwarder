#!/usr/bin/env bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0

DISTRO_NAME="$(grep -oP '(?<=^NAME=).+' < /etc/os-release | tr -d '"')"
DISTRO_VERSION="$(grep -oP '(?<=^VERSION=).+' < /etc/os-release | tr -d '"')"
DISTRO_TITLE="${DISTRO_NAME} ${DISTRO_VERSION}"
TAILSCALE_RPM_PATH="/tmp/tailscale.rpm"
#CURL_RPM_PATH="/tmp/curl.rpm"
#JQ_RPM_PATH="/tmp/jq.rpm"
OPENSSL_RPM_PATH="/tmp/openssl.rpm"
PWD_PATH="$(pwd)"
START_PATH="${WORKDIR:=$PWD_PATH}"
DIST_LAYER_PATH="${START_PATH}/dist/layer"
CURL_RPM_PATH="${DIST_LAYER_PATH}/tmp_extracts/usr/bin/curl"
JQ_RPM_PATH="${DIST_LAYER_PATH}/tmp_extracts/usr/bin/jq"
DIST_LAYER_ZIP_NAME="tailscale-layer.zip"
DIST_LAYER_ASSET_PATH="${START_PATH}/dist/${DIST_LAYER_ZIP_NAME}"

function get_dependency_locations {
  if [[ ! -x ./dependency-version.lock.sh ]]; then
    echo "Couldn't use the dependency location lock file as it doesn't exist"
    echo "or it is not executable."
    echo ""
    echo "Please note: Do not use the latest versions in a build pipeline, "
    echo "as this might lead to issues that are hard to reproduce."
    echo ""
    echo "Determining dependency locations on the fly, using latest:"
    source ./determine-dependency-locations.sh
  else
    source ./dependency-version.lock.sh
  fi

  if [[ "Z${TAILSCALE_RPM_URL}" == "Z" ]]; then
    echo "Something went wrong, dependency locations could not be determined."
    exit 1
  fi
}

function download_tailscale {
  echo "Downloading latest Tailscale image for ${DISTRO_TITLE}"
  curl -L -s "${TAILSCALE_RPM_URL}" -o "${TAILSCALE_RPM_PATH}" > /dev/null 2>&1
}

function download_curl {
  echo "Downloading latest curl image for ${DISTRO_TITLE}"
  curl -L -s "${CURL_RPM_URL}" -o "${CURL_RPM_PATH}" > /dev/null 2>&1
  chmod +x "${CURL_RPM_PATH}"
}

function download_jq {
  echo "Downloading latest jq image for ${DISTRO_TITLE}"
  curl -L -s "${JQ_RPM_URL}" -o "${JQ_RPM_PATH}" > /dev/null 2>&1
  chmod +x "${JQ_RPM_PATH}"
}

function download_openssl {
  echo "Downloading latest openssl image for ${DISTRO_TITLE}"
  curl -L -s "${OPENSSL_RPM_URL}" -o "${OPENSSL_RPM_PATH}" > /dev/null 2>&1
}

function create_dist_dirs {
  echo "Creating dist directories"
  mkdir -p "${DIST_LAYER_PATH}/tmp_extracts/usr/bin"
  mkdir -p "${DIST_LAYER_PATH}/extensions"
  mkdir -p "${DIST_LAYER_PATH}/bin"
  mkdir -p "${DIST_LAYER_PATH}/ssl"
}

function extract_package {
  rpm_to_extract=$1
  cd "${DIST_LAYER_PATH}/tmp_extracts"
  echo "Extracting ${rpm_to_extract} package"
  rpm2cpio "${rpm_to_extract}" | cpio -idmv --no-absolute-filenames
  cd "${START_PATH}"
}

function copy_CA_truststore {
  echo "Copying CA trust bundle from CodeBuild image"
  cp /etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt "${DIST_LAYER_PATH}/ssl/ca-bundle.trust.crt"
}

function copy_layer_prereqs {
  echo "Copying Lambda Layer prereqs"
  cp -r "${START_PATH}/tsextension.sh" "${DIST_LAYER_PATH}/extensions"
  chmod 555 "${DIST_LAYER_PATH}/extensions/tsextension.sh"
}

function copy_bins_to_layer {
  ls -la "${DIST_LAYER_PATH}/tmp_extracts/usr/bin"
  cp -r "${DIST_LAYER_PATH}/tmp_extracts/usr/bin/"{tailscale,curl,jq,openssl} "${DIST_LAYER_PATH}/bin"
  cp -r "${DIST_LAYER_PATH}/tmp_extracts/usr/sbin/tailscaled" "${DIST_LAYER_PATH}/bin"
}

function cleanup {
  rm -r "${DIST_LAYER_PATH}/tmp_extracts"
}

function build_layer_asset {
  cd "${DIST_LAYER_PATH}"

  echo "Zipping Lambda Layer"
  zip -r "../${DIST_LAYER_ZIP_NAME}" ./bin ./extensions ./ssl

  cd "${START_PATH}"
}

function main {
  get_dependency_locations

  create_dist_dirs

  download_tailscale
  download_curl
  download_jq
  download_openssl

  # Uses the RPM Paths to extract
  extract_package "$TAILSCALE_RPM_PATH"
  extract_package "$OPENSSL_RPM_PATH"

  copy_CA_truststore

  copy_layer_prereqs

  copy_bins_to_layer

  cleanup

  build_layer_asset
}

set -ex
echo "Building..."
main
echo "Done."
