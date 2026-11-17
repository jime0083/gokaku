import { info } from 'firebase-functions/logger';
import {
  runXRequest,
  recordProfileResource,
  type XOperation,
  type XUsageEvent,
  type XUsageLogger,
} from '../xUsage';

jest.mock('firebase-functions/logger', () => ({ info: jest.fn() }));

/**
 * 8-3 common logging: TEST FIRST artifact; implementation intentionally absent.
 * Proposed interface for subsequent integration:
 *   XOperation = 'post_create' | 'profile_read' | 'token_exchange' | 'token_refresh'
 *   XUsageLogger = (event: XUsageEvent) => void
 *   runXRequest<T>(operation: XOperation, request: () => Promise<T>, logger?: XUsageLogger): Promise<T>
 *   recordProfileResource(logger?: XUsageLogger): void
 * recordProfileResource is called once AFTER validation of one returned resource.
 * It accepts no profile, identifier, resource count, or request metadata.
 * XUsageEvent is the fixed schema asserted below; no arbitrary fields.
 * Pricing metadata below is supplied by the task, not independently verified here.
 * RED/check execution belongs to main; no tests/typecheck/lint were run here.
 * Run from repository root:
 * ./node_modules/.bin/jest --config functions/jest.config.js --runInBand --runTestsByPath functions/src/__tests__/xUsage.test.ts
 * Review/security: verify exact schema, attempt count, unchanged promise/error,
 * isolated logger failures, and request/resource estimate separation.
 */

const OPERATIONS = [
  'post_create', 'profile_read', 'token_exchange', 'token_refresh',
] as const satisfies readonly XOperation[];

const PRICING = {
  currency: 'USD',
  pricingSource: 'https://docs.x.com/x-api/getting-started/pricing',
  pricingCheckedOn: '2026-10-31',
  estimateKind: 'reference_only',
} as const;

function requestEvent(operation: XOperation) {
  const post = operation === 'post_create';
  return {
    event: 'x_api_usage',
    operation,
    measurement: 'request',
    requestCount: 1,
    validatedResourceCount: 0,
    estimatedCostMicroUsd: post ? 15_000 : null,
    costEstimateBasis: post ? 'per_request' : 'unestimated',
    unestimatedReason: post
      ? null
      : operation === 'profile_read'
        ? 'validated_resource_not_counted'
        : 'unknown_unit_price',
    ...PRICING,
  };
}

function resourceEvent() {
  return {
    event: 'x_api_usage',
    operation: 'profile_read',
    measurement: 'validated_resource',
    requestCount: 0,
    validatedResourceCount: 1,
    estimatedCostMicroUsd: 10_000,
    costEstimateBasis: 'per_validated_resource_before_dedup',
    unestimatedReason: null,
    ...PRICING,
  };
}

function capture() {
  return jest.fn<ReturnType<XUsageLogger>, Parameters<XUsageLogger>>();
}

beforeEach(() => {
  jest.mocked(info).mockReset();
});

it.each(OPERATIONS)('starts %s exactly once and preserves the promise and returned object', async (operation) => {
  const value = Object.freeze({ fixture: 'same-object' });
  const original = Promise.resolve(value);
  const request = jest.fn(() => original);
  const logger = capture();

  const result = runXRequest(operation, request, logger);

  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith();
  expect(result).toBe(original);
  expect(logger.mock.calls).toEqual([[requestEvent(operation)]]);
  expect(await result).toBe(value);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalled();
});

it('records an actual start while pending, without waiting, settling, or counting completion', async () => {
  let resolve!: (value: object) => void;
  const original = new Promise<object>((done) => { resolve = done; });
  const order: string[] = [];
  const logger = capture().mockImplementation(() => { order.push('logged'); });
  const request = jest.fn(() => {
    order.push('started');
    return original;
  });
  const result = runXRequest('post_create', request, logger);
  let settled = false;
  const observed = result.then(() => { settled = true; });

  try {
    expect(result).toBe(original);
    expect(order).toEqual(['started', 'logged']);
    expect(logger.mock.calls).toEqual([[requestEvent('post_create')]]);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledTimes(1);
  } finally {
    resolve({});
    await observed;
  }
  expect(logger).toHaveBeenCalledTimes(1);
});

it.each(OPERATIONS)('counts a rejected %s attempt once and preserves the original rejection', async (operation) => {
  const error = Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), {
    uid: 'SYNTHETIC_UID', status: 401, body: 'SYNTHETIC_BODY',
  });
  const original = Promise.reject(error);
  const request = jest.fn(() => original);
  const logger = capture();
  const result = runXRequest(operation, request, logger);

  expect(result).toBe(original);
  await expect(result).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger.mock.calls).toEqual([[requestEvent(operation)]]);
});

it('preserves a synchronous request throw and still counts its invocation once', () => {
  const error = new Error('SYNTHETIC_SYNC_ERROR');
  const request = jest.fn((): Promise<never> => { throw error; });
  const logger = capture();
  let caught: unknown;
  try {
    runXRequest('post_create', request, logger);
  } catch (value) {
    caught = value;
  }
  expect(caught).toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger.mock.calls).toEqual([[requestEvent('post_create')]]);
});

it('isolates logger throws without changing a successful request or its promise', async () => {
  const value = {};
  const original = Promise.resolve(value);
  const request = jest.fn(() => original);
  const logger = capture().mockImplementation(() => {
    throw new Error('SYNTHETIC_LOGGER_ERROR');
  });
  const result = runXRequest('post_create', request, logger);

  expect(result).toBe(original);
  expect(await result).toBe(value);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalled();
});

it('isolates logger throws while preserving a rejected request', async () => {
  const error = new Error('SYNTHETIC_REQUEST_ERROR');
  const original = Promise.reject(error);
  const request = jest.fn(() => original);
  const logger = capture().mockImplementation(() => { throw new Error('logger'); });
  const result = runXRequest('token_refresh', request, logger);

  expect(result).toBe(original);
  await expect(result).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger).toHaveBeenCalledTimes(1);
});

it('isolates logger throws while preserving a synchronous request throw', () => {
  const error = new Error('SYNTHETIC_REQUEST_ERROR');
  const request = jest.fn((): Promise<never> => { throw error; });
  const logger = capture().mockImplementation(() => { throw new Error('logger'); });
  let caught: unknown;
  try {
    runXRequest('token_exchange', request, logger);
  } catch (value) {
    caught = value;
  }
  expect(caught).toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logger).toHaveBeenCalledTimes(1);
});

it('keeps profile request counts separate from explicitly validated resource costs', async () => {
  const logger = capture();
  const profile = { id: 'SYNTHETIC_ID', username: 'synthetic' };
  await runXRequest('profile_read', () => Promise.resolve(profile), logger);

  // HTTP completion itself does not prove a validated resource was returned.
  expect(logger.mock.calls).toEqual([[requestEvent('profile_read')]]);
  recordProfileResource(logger);
  expect(logger.mock.calls).toEqual([
    [requestEvent('profile_read')], [resourceEvent()],
  ]);
});

it('counts each explicitly validated resource once without inventing requests or deduplication', () => {
  const logger = capture();
  recordProfileResource(logger);
  recordProfileResource(logger);
  expect(logger.mock.calls).toEqual([[resourceEvent()], [resourceEvent()]]);
});

it.each(['token_exchange', 'token_refresh'] as const)('marks %s pricing unknown rather than free', async (operation) => {
  const logger = capture();
  await runXRequest(operation, () => Promise.resolve(undefined), logger);
  expect(logger.mock.calls).toEqual([[requestEvent(operation)]]);
  expect(logger.mock.calls[0][0].estimatedCostMicroUsd).toBeNull();
  expect(logger.mock.calls[0][0].unestimatedReason).toBe('unknown_unit_price');
});

it('uses firebase-functions/logger.info by default for both event types', async () => {
  const value = {};
  expect(await runXRequest('post_create', () => Promise.resolve(value))).toBe(value);
  recordProfileResource();
  expect(jest.mocked(info).mock.calls).toEqual([
    [requestEvent('post_create')], [resourceEvent()],
  ]);
});

it('isolates default logger failures for request and resource events', async () => {
  jest.mocked(info).mockImplementation(() => { throw new Error('logger'); });
  const value = {};
  const original = Promise.resolve(value);
  const result = runXRequest('profile_read', () => original);
  expect(result).toBe(original);
  expect(await result).toBe(value);
  expect(() => recordProfileResource()).not.toThrow();
  expect(info).toHaveBeenCalledTimes(2);
});

it('isolates an injected resource logger failure without fallback or retry', () => {
  const logger = capture().mockImplementation(() => { throw new Error('logger'); });
  expect(() => recordProfileResource(logger)).not.toThrow();
  expect(logger.mock.calls).toEqual([[resourceEvent()]]);
  expect(info).not.toHaveBeenCalled();
});

it('never observes or serializes request/response secrets or raw failures', async () => {
  const logger = capture();
  const inspect = jest.fn(() => { throw new Error('must not inspect'); });
  const privateValue = Object.defineProperties({}, {
    uid: { get: inspect, enumerable: true },
    headers: { get: inspect, enumerable: true },
    body: { get: inspect, enumerable: true },
    status: { get: inspect, enumerable: true },
    toJSON: { value: inspect },
  });
  const url = 'https://synthetic.invalid/?code=SYNTHETIC_CODE';
  const headers = { Authorization: 'Bearer SYNTHETIC_TOKEN' };
  const body = 'SYNTHETIC_POST_BODY';
  const request = jest.fn(() => {
    // Sensitive context belongs exclusively to the request closure.
    void url;
    void headers;
    void body;
    return Promise.resolve(privateValue);
  });
  expect(await runXRequest('post_create', request, logger)).toBe(privateValue);
  await expect(runXRequest(
    'token_refresh', () => Promise.reject(privateValue), logger,
  )).rejects.toBe(privateValue);
  recordProfileResource(logger);

  expect(inspect).not.toHaveBeenCalled();
  expect(logger.mock.calls).toEqual([
    [requestEvent('post_create')],
    [requestEvent('token_refresh')],
    [resourceEvent()],
  ]);
  const serialized = JSON.stringify(logger.mock.calls);
  for (const secret of [url, headers.Authorization, body, 'SYNTHETIC_CODE']) {
    expect(serialized).not.toContain(secret);
  }
});

it('emits only fixed schema fields with finite safe integer counts and estimates', async () => {
  const logger = capture();
  for (const operation of OPERATIONS) {
    await runXRequest(operation, () => Promise.resolve(null), logger);
  }
  recordProfileResource(logger);

  const expected = [
    ...OPERATIONS.map((operation) => [requestEvent(operation)]),
    [resourceEvent()],
  ];
  expect(logger.mock.calls).toEqual(expected);
  for (const [event] of logger.mock.calls) {
    const typed: XUsageEvent = event;
    expect(Object.keys(typed).sort()).toEqual(Object.keys(resourceEvent()).sort());
    for (const value of Object.values(typed)) {
      if (typeof value === 'number') {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  }
});
