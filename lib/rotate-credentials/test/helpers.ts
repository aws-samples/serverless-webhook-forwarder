// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

export function cloneObject(input: object): object {
  return JSON.parse(JSON.stringify(input));
}

export function getDateInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().replace(/\.\d\d\dZ/, 'Z');
}

export function setupFetchResolvedMock(
  template: object,
  overrides: object = {},
  statusCode = 200,
): void {
  global.fetch = jest.fn(
    () => Promise.resolve(
      {
        json: () => Promise.resolve({
          ...cloneObject(template),
          ...cloneObject(overrides),
        }),
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
      } as any,
    ),
  );
}

export function setupFetchRejectsMock(error: any): void {
  global.fetch = jest.fn().mockImplementationOnce(
    () => new Promise((_, reject) => {
      reject(error);
    }),
  ) as any;
}
