// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import http from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  APIGatewayProxyEventV2,
} from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';

interface Response {
  readonly statusCode: number;
  readonly headers?: http.OutgoingHttpHeaders;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

const logger = new Logger({ serviceName: 'webhookForwarder' });

async function proxyHttpRequest(
  options: http.RequestOptions,
  body: string | undefined,
  proxyResponse: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = http.request(options, (res: http.IncomingMessage) => {
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        if (proxyResponse === 'FULL') {
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body: responseBody.toString('base64'),
            isBase64Encoded: true,
          });
        } else if (proxyResponse === 'HTTP_CODE_HEADERS') {
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
          });
        } else if (proxyResponse === 'HTTP_CODE') {
          resolve({
            statusCode: res.statusCode || 500,
          });
        } else {
          resolve({
            statusCode: 200,
          });
        }
      });

      res.on('error', (error: Error): void => {
        logger.error('Error receiving response:', error);
        reject(error);
      });
    });

    request.on('error', (error: Error): void => {
      logger.error('Error sending request:', error);
      reject(error);
    });

    if (body != null) {
      request.write(body);
    }
    request.end();
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<Response> => {
  const socksProxyAgent = new SocksProxyAgent('socks://localhost:1055');
  const proxyResponse = (process.env.PROXY_RESPONSE ?? '').toUpperCase();

  const response = await proxyHttpRequest(
    {
      hostname: process.env.TS_TARGET ?? 'localhost',
      path: event.requestContext.http.path,
      port: process.env.TS_PORT ?? '80',
      agent: socksProxyAgent,
      headers: event.headers,
      method: event.requestContext.http.method,
    },
    event.body ?? '',
    proxyResponse,
  );

  return response;
};

export default {
  handler,
};
