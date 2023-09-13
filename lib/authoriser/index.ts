// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewayRequestSimpleAuthorizerHandlerV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'authoriser' });

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, mask] = cidr.split('/');

  if (!range || !mask) {
    throw new Error('Invalid CIDR range.');
  }

  const ipParts = ip.split('.');
  const rangeParts = range.split('.');

  if (ipParts.length !== 4 || rangeParts.length !== 4) {
    throw new Error('Invalid IP address or CIDR range.');
  }

  const ipBinary = ipParts
    .map((part) => parseInt(part, 10).toString(2).padStart(8, '0'))
    .join('');

  const rangeBinary = rangeParts
    .map((part: string) => parseInt(part, 10).toString(2).padStart(8, '0'))
    .join('');

  const subnetMask = parseInt(mask, 10);

  for (let i = 0; i < subnetMask; i += 1) {
    if (ipBinary[i] !== rangeBinary[i]) {
      return false;
    }
  }

  return true;
}

function isCidrFormatValid(cidrRange: string): boolean {
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  return cidrRegex.test(cidrRange);
}

export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> => {
  const authorisedCidr = process.env.AUTHD_SOURCE_CIDR ?? 'not-set';
  const { sourceIp } = event.requestContext.http;

  if (isCidrFormatValid(authorisedCidr) === false) {
    logger.error(
      'The AUTHD_SOURCE_CIDR environment variable is not correct. '
      + 'Please make sure it matches a valid IPv4 CIDR range. '
      + 'For example: 127.0.0.1/32 would only allow 127.0.0.1. '
      + `Currently configured AUTHD_SOURCE_CIDR: '${authorisedCidr}'`,
    );
    return {
      isAuthorized: false,
    };
  }

  const isAuthorized: boolean = ipInCidr(sourceIp, authorisedCidr);
  logger.info(
    `Received request from ${sourceIp}, matching it against ${authorisedCidr} `
    + ` results in ${isAuthorized ? 'authorized' : 'denied'}`,
  );
  return {
    isAuthorized,
  };
};

export default {
  handler,
};
