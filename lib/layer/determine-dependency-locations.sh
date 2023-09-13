#!/usr/bin/env bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0

DISTRO_NAME="$(grep -oP '(?<=^NAME=).+' < /etc/os-release | tr -d '"')"
if [[ "$DISTRO_NAME" != "Amazon Linux" ]]; then
  echo "This script requires Amazon Linux, at the moment it is detected as: ${DISTRO_NAME}"
  exit 2
fi

IS_AMAZON_LINUX_2=0
AMAZON_LINUX_VERSION="$(grep -oP '(?<=^VERSION=).+' < /etc/os-release | tr -d '"')"
if [[ "$AMAZON_LINUX_VERSION" == "2" ]]; then
  IS_AMAZON_LINUX_2=1
fi

DRY_RUN=0
if [ "$1" = "--dry-run" ] || [ "$2" = "--dry-run" ]; then
    DRY_RUN=1
fi

DEFAULT_LOCK_FILE="./dependency-version.lock.sh"
if [ "Z$LOCK_FILE" == "Z" ]; then
  LOCK_FILE=$DEFAULT_LOCK_FILE
fi

function update_repos {
  echo "Installing Yum utils..."
  if [[ "$IS_AMAZON_LINUX_2" == "1" ]]; then
    sudo yum install -y yum-utils
  else
    sudo dnf install 'dnf-command(config-manager) -y'
  fi

  echo "Add Tailscale repo"
  TAILSCALE_REPO_URL="https://pkgs.tailscale.com/stable/amazon-linux/${AMAZON_LINUX_VERSION}/tailscale.repo"
  if [[ "$IS_AMAZON_LINUX_2" == "1" ]]; then
    sudo yum-config-manager -y --add-repo "$TAILSCALE_REPO_URL"
  else
    sudo dnf config-manager -y --add-repo "$TAILSCALE_REPO_URL"
  fi

  echo "Update Yum's index and GPG keys"
  if [[ "$IS_AMAZON_LINUX_2" == "1" ]]; then
    sudo yum update --downloadonly -y
  else
    sudo dnf update --downloadonly -y
  fi
}

function create_new_lock_file {
  if [ "$DRY_RUN" = "0" ]; then
    echo "#!/usr/bin/env bash" > $LOCK_FILE
  fi
}

function write_to_lock_file {
  new_line=$1
  if [ "$DRY_RUN" = "0" ]; then
    echo "${new_line}" >> $LOCK_FILE
  fi
}

function query_repo {
  if [[ "$IS_AMAZON_LINUX_2" == "1" ]]; then
    echo "$(repoquery --location "$1" --archlist x86_64)"
  else
    echo "$(dnf repoquery --location "$1" --archlist x86_64 --latest-limit=1)"
  fi
}

function get_tailscale_url {
  echo "Retrieve the latest version of Tailscale to use and determine the"
  echo "RPM location..."
  export TAILSCALE_RPM_URL="$(query_repo tailscale)"
  write_to_lock_file "export TAILSCALE_RPM_URL=\"${TAILSCALE_RPM_URL}\""
  echo "Resolved it to: ${TAILSCALE_RPM_URL}"
}

function get_curl_url {
  echo "Retrieve the latest version of Curl to use and determine the"
  echo "RPM location..."
  LATEST_CURL_VERSION_TAG="$(curl -L -s https://api.github.com/repos/moparisthebest/static-curl/releases/latest | jq -r ".tag_name")"
  export CURL_RPM_URL="https://github.com/moparisthebest/static-curl/releases/download/${LATEST_CURL_VERSION_TAG}/curl-amd64"
  write_to_lock_file "export CURL_RPM_URL=\"${CURL_RPM_URL}\""
  echo "Resolved it to: ${CURL_RPM_URL}"
}

function get_jq_url {
  echo "Get jq URL to download"
  LATEST_JS_VERSION_TAG="$(curl -L -s https://api.github.com/repos/stedolan/jq/releases/latest | jq -r ".tag_name")"
  export JQ_RPM_URL="https://github.com/stedolan/jq/releases/download/${LATEST_JS_VERSION_TAG}/jq-linux64"
  write_to_lock_file "export JQ_RPM_URL=\"${JQ_RPM_URL}\""
  echo "Resolved it to: ${JQ_RPM_URL}"
}

function get_openssl_url {
  echo "Get openssl URL to download"
  export OPENSSL_RPM_URL="$(query_repo openssl)"
  write_to_lock_file "export OPENSSL_RPM_URL=\"${OPENSSL_RPM_URL}\""
  echo "Resolved it to: ${OPENSSL_RPM_URL}"
}

function main {
  if [[ "${IN_DOCKER}" != "YES" ]]; then
    update_repos
  fi

  create_new_lock_file

  echo "Determining latest dependency versions to use..."
  get_tailscale_url
  get_curl_url
  get_jq_url
  get_openssl_url
  echo  "Done."
  echo ""
  echo "Final result written to $LOCK_FILE:"
  cat "$LOCK_FILE"
  chmod +x "$LOCK_FILE"
  echo ""
}

set -ex
main
