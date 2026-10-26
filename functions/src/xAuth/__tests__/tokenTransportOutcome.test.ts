import { ReadableStream } from 'node:stream/web';
import {
  requestTokenOutcome,
  requestTokens,
  TOKEN_RESPONSE_MAX_BYTES,
  TOKEN_TIMEOUT_MS,
  type TokenFetch,
  type TokenGrant,
} from '../tokenTransport';

const FAILURE = 'X OAuth token request failed';
const PRIVATE = 'PRIVATE_OUTCOME_FIXTURE';
const credentials = {
  clientId: 'id :+é&',
  clientSecret: 'secret:/? +雪',
};
const scope = 'tweet.read tweet.write users.read offline.access';
const exchange: Extract<TokenGrant, { grantType: 'authorization_code' }> = {
  grantType: 'authorization_code',
  code: 'code +&=雪',
  redirectUri: 'https://example.test/cb?next=a+b&x=%2F',
  codeVerifier: 'v'.repeat(43),
};
const refresh: Extract<TokenGrant, { grantType: 'refresh_token' }> = {
  grantType: 'refresh_token',
  refreshToken: 'OLD_REFRESH_FIXTURE',
  grantedScope: scope,
};

function valid(): Record<string, unknown> {
  return {
    access_token: 'ACCESS_FIXTURE',
    token_type: 'bearer',
    expires_in: 7200,
    refresh_token: 'REFRESH_FIXTURE',
    scope,
  };
}

function tokens() {
  return {
    accessToken: 'ACCESS_FIXTURE',
    tokenType: 'Bearer',
    expiresIn: 7200,
    refreshToken: 'REFRESH_FIXTURE',
    scope,
  };
}

function response(value: unknown = valid(), status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function mockFetch(value: Awaited<ReturnType<TokenFetch>>): jest.MockedFunction<TokenFetch> {
  return jest.fn().mockResolvedValue(value);
}

function byteBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function expectOutcome(
  fetch: jest.MockedFunction<TokenFetch>,
  expected: unknown,
  grant: TokenGrant = refresh,
): Promise<void> {
  const result = await requestTokenOutcome(fetch, credentials, grant);
  expect(result).toStrictEqual(expected);
  expect(fetch).toHaveBeenCalledTimes(1);
  if (result.kind !== 'tokens') {
    const serialized = JSON.stringify(result);
    for (const secret of [
      PRIVATE,
      credentials.clientId,
      credentials.clientSecret,
      exchange.code,
      refresh.refreshToken,
      'ACCESS_FIXTURE',
      'REFRESH_FIXTURE',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  }
}

async function expectFailure(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message).toBe(FAILURE);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
  for (const secret of [
    PRIVATE,
    credentials.clientId,
    credentials.clientSecret,
    exchange.code,
    refresh.refreshToken,
    'ACCESS_FIXTURE',
    'REFRESH_FIXTURE',
  ]) {
    expect(error.stack).not.toContain(secret);
  }
}

let logs: jest.SpyInstance[];

beforeEach(() => {
  jest.useFakeTimers();
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined),
  );
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

describe('safe X OAuth token outcomes (7-3b internal unit)', () => {
  it('returns tokens and preserves the exchange endpoint, encoding and redirect policy', async () => {
    const fetch = mockFetch(response());
    await expectOutcome(fetch, { kind: 'tokens', tokens: tokens() }, exchange);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    expect(init.headers).toEqual({
      Authorization: `Basic ${Buffer.from(
        'id+%3A%2B%C3%A9%26:secret%3A%2F%3F+%2B%E9%9B%AA',
        'utf8',
      ).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(init.body.toString()).toBe(
      'grant_type=authorization_code&code=code+%2B%26%3D%E9%9B%AA' +
      '&redirect_uri=https%3A%2F%2Fexample.test%2Fcb%3Fnext%3Da%2Bb%26x%3D%252F' +
      `&code_verifier=${exchange.codeVerifier}`,
    );
  });

  it('sends only refresh grant fields and adopts rotated tokens and explicit scopes', async () => {
    const grantedScope = 'offline.access users.read tweet.write tweet.read follows.read';
    const fetch = mockFetch(response({
      ...valid(), token_type: 'Bearer', refresh_token: 'ROTATED_FIXTURE', scope: grantedScope,
    }));
    await expectOutcome(fetch, {
      kind: 'tokens',
      tokens: { ...tokens(), refreshToken: 'ROTATED_FIXTURE', scope: grantedScope },
    });
    expect(Array.from(fetch.mock.calls[0][1].body.entries())).toEqual([
      ['grant_type', 'refresh_token'],
      ['refresh_token', refresh.refreshToken],
    ]);
  });

  it('falls back independently only for omitted refresh token and scope', async () => {
    for (const omitted of [
      ['refresh_token'], ['scope'], ['refresh_token', 'scope'],
    ]) {
      const value = valid();
      for (const field of omitted) delete value[field];
      await expectOutcome(mockFetch(response(value)), {
        kind: 'tokens',
        tokens: {
          ...tokens(),
          refreshToken: omitted.includes('refresh_token')
            ? refresh.refreshToken : 'REFRESH_FIXTURE',
        },
      });
    }
  });

  it('classifies invalid HTTP 200 JSON, shapes and scopes as invalid_response', async () => {
    const missingRefresh = valid();
    delete missingRefresh.refresh_token;
    const missingScope = valid();
    delete missingScope.scope;
    const fixtures: { value: unknown; grant: TokenGrant }[] = [
      { value: null, grant: refresh },
      { value: [valid()], grant: refresh },
      { value: PRIVATE, grant: refresh },
      { value: { ...valid(), access_token: '' }, grant: refresh },
      { value: { ...valid(), token_type: 'MAC' }, grant: refresh },
      { value: { ...valid(), expires_in: 0 }, grant: refresh },
      { value: { ...valid(), expires_in: 0.5 }, grant: refresh },
      { value: { ...valid(), refresh_token: null }, grant: refresh },
      { value: { ...valid(), scope: null }, grant: refresh },
      { value: { ...valid(), scope: 'tweet.read' }, grant: refresh },
      { value: { ...valid(), scope: `${scope}\t` }, grant: refresh },
      { value: missingRefresh, grant: exchange },
      { value: missingScope, grant: exchange },
      { value: { error: 'invalid_grant' }, grant: refresh },
    ];
    for (const { value, grant } of fixtures) {
      await expectOutcome(mockFetch(response(value)), {
        kind: 'unknown', reason: 'invalid_response',
      }, grant);
    }
    for (const text of ['', '{', `<html>${PRIVATE}</html>`]) {
      await expectOutcome(mockFetch(new Response(text)), {
        kind: 'unknown', reason: 'invalid_response',
      });
    }
    await expectOutcome(mockFetch(new Response(null)), {
      kind: 'unknown', reason: 'invalid_response',
    });
  });

  it('returns only allowlisted OAuth errors and the HTTP status', async () => {
    const errors = [
      'invalid_grant', 'invalid_client', 'unauthorized_client',
      'invalid_request', 'unsupported_grant_type', 'invalid_scope',
      'access_denied', 'server_error', 'temporarily_unavailable',
    ];
    for (const error of errors) {
      const status = error === 'server_error' ? 500
        : error === 'temporarily_unavailable' ? 503 : 400;
      await expectOutcome(mockFetch(response({
        error,
        error_description: PRIVATE,
        error_uri: `https://example.test/${PRIVATE}`,
        access_token: 'ACCESS_FIXTURE',
        refresh_token: 'REFRESH_FIXTURE',
        cause: PRIVATE,
      }, status)), { kind: 'oauth_error', status, error });
    }
  });

  it('keeps unrecognized or malformed OAuth error fields neutral', async () => {
    const values: unknown[] = [
      { error: PRIVATE },
      { error: 'INVALID_GRANT' },
      { error: ' invalid_grant' },
      { error: 'invalid_grant ' },
      { error: 'invalid_grant\n' },
      { error: ['invalid_grant'] },
      { error: { code: 'invalid_grant' } },
      { error: null },
      { error: 1 },
      { error: 'toString' },
      { error: '__proto__' },
      [{ error: 'invalid_grant' }],
      null,
      { error_description: 'invalid_grant' },
      valid(),
    ];
    for (const value of values) {
      await expectOutcome(mockFetch(response(value, 400)), {
        kind: 'http_error', status: 400,
      });
    }
  });

  it('keeps non-200 responses neutral when bounded OAuth JSON is unavailable', async () => {
    for (const status of [201, 204, 302, 400, 401, 403, 429, 500, 503, 599]) {
      const bodies = status === 204 ? [null] : [
        null,
        '',
        `{\"error\":\"invalid_grant\",\"private\":\"${PRIVATE}\"`,
        `<html>${PRIVATE}</html>`,
        JSON.stringify({ error: 'invalid_grant' }) +
          ' '.repeat(TOKEN_RESPONSE_MAX_BYTES),
        new Uint8Array([0xff]),
      ];
      for (const body of bodies) {
        await expectOutcome(mockFetch(new Response(body, { status })), {
          kind: 'http_error', status,
        });
      }
    }
  });

  it('classifies invalid HTTP statuses as invalid_response rather than OAuth errors', async () => {
    for (const status of [0, 99, 600, -1, 400.5, NaN, Infinity, '400', undefined]) {
      const body = byteBody(Buffer.from(JSON.stringify({ error: 'invalid_grant' })));
      const malformed = { status, body } as unknown as Awaited<ReturnType<TokenFetch>>;
      await expectOutcome(mockFetch(malformed), {
        kind: 'unknown', reason: 'invalid_response',
      });
      expect(body.locked).toBe(false);
    }
  });

  it('classifies synchronous fetch throws and rejected fetches as network without retrying', async () => {
    const synchronous: jest.MockedFunction<TokenFetch> = jest.fn<
      ReturnType<TokenFetch>, Parameters<TokenFetch>
    >(() => {
      throw new Error(PRIVATE);
    });
    const asynchronous: jest.MockedFunction<TokenFetch> = jest.fn()
      .mockRejectedValue(new Error(PRIVATE));
    for (const fetch of [synchronous, asynchronous]) {
      await expectOutcome(fetch, { kind: 'unknown', reason: 'network' });
    }
  });

  it('classifies body read failures as network even after non-200 headers', async () => {
    for (const status of [200, 400, 429, 503]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error(PRIVATE)); },
      });
      await expectOutcome(mockFetch(new Response(body, { status })), {
        kind: 'unknown', reason: 'network',
      });
      expect(body.locked).toBe(false);
    }
  });

  it('times out stalled fetch exactly at the deadline and aborts without retrying', async () => {
    const fetch: jest.MockedFunction<TokenFetch> = jest.fn<
      ReturnType<TokenFetch>, Parameters<TokenFetch>
    >(() => new Promise<Response>(() => undefined));
    let settled = false;
    const operation = requestTokenOutcome(fetch, credentials, refresh).then((result) => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(operation).resolves.toStrictEqual({ kind: 'unknown', reason: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('cancels a late response without reading or changing the timeout outcome', async () => {
    let resolve!: (value: Response) => void;
    const fetch: jest.MockedFunction<TokenFetch> = jest.fn<
      ReturnType<TokenFetch>, Parameters<TokenFetch>
    >(() => new Promise<Response>((done) => { resolve = done; }));
    const operation = requestTokenOutcome(fetch, credentials, refresh);
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS);
    await expect(operation).resolves.toStrictEqual({ kind: 'unknown', reason: 'timeout' });
    const cancel = jest.fn();
    const pull = jest.fn();
    const body = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
    resolve(new Response(body));
    await jest.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses one deadline for headers and body and does not await stalled cancellation', async () => {
    for (const status of [200, 400]) {
      let resolve!: (value: Response) => void;
      const fetch: jest.MockedFunction<TokenFetch> = jest.fn<
        ReturnType<TokenFetch>, Parameters<TokenFetch>
      >(() => new Promise<Response>((done) => { resolve = done; }));
      const operation = requestTokenOutcome(fetch, credentials, refresh);
      await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS - 1);
      const cancel = jest.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      resolve(new Response(body, { status }));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1);
      await expect(operation).resolves.toStrictEqual({ kind: 'unknown', reason: 'timeout' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    }
  });

  it('accepts exactly 64KB and decodes UTF-8 split across chunks for success and OAuth errors', async () => {
    for (const status of [200, 400]) {
      const value = status === 200
        ? { ...valid(), access_token: '令牌' }
        : { error: 'invalid_grant', error_description: '令牌' };
      const json = JSON.stringify(value);
      const bytes = Buffer.from(
        json + ' '.repeat(TOKEN_RESPONSE_MAX_BYTES - Buffer.byteLength(json)),
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 7) {
            controller.enqueue(bytes.subarray(offset, offset + 7));
          }
          controller.close();
        },
      });
      await expectOutcome(mockFetch(new Response(body, { status })), status === 200
        ? { kind: 'tokens', tokens: { ...tokens(), accessToken: '令牌' } }
        : { kind: 'oauth_error', status, error: 'invalid_grant' });
      expect(body.locked).toBe(false);
    }
  });

  it('bounds single and streamed oversized bodies and discards cleanup exceptions', async () => {
    for (const status of [200, 400]) {
      for (const mode of ['single', 'streamed']) {
        const cancel = jest.fn(() => { throw new Error(PRIVATE); });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === 'single') {
              controller.enqueue(new Uint8Array(TOKEN_RESPONSE_MAX_BYTES + 1));
            } else {
              controller.enqueue(new Uint8Array(TOKEN_RESPONSE_MAX_BYTES));
              controller.enqueue(new Uint8Array(1));
            }
          },
          cancel,
        });
        await expectOutcome(mockFetch(new Response(body, { status })), status === 200
          ? { kind: 'unknown', reason: 'invalid_response' }
          : { kind: 'http_error', status });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      }
    }
  });

  it('rejects malformed UTF-8 in HTTP 200 without replacing bytes inside tokens', async () => {
    const body = byteBody(Buffer.concat([
      Buffer.from('{\"access_token\":\"'),
      Buffer.from([0xff]),
      Buffer.from('\"}'),
    ]));
    await expectOutcome(mockFetch(new Response(body)), {
      kind: 'unknown', reason: 'invalid_response',
    });
    expect(body.locked).toBe(false);
  });

  it('preserves the legacy success return without an outcome wrapper', async () => {
    for (const grant of [exchange, refresh]) {
      const fetch = mockFetch(response());
      await expect(requestTokens(fetch, credentials, grant)).resolves.toStrictEqual(tokens());
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves the legacy generic Error for every non-token outcome category', async () => {
    const fixtures = [
      () => mockFetch(response({ error: 'invalid_grant', error_description: PRIVATE }, 400)),
      () => mockFetch(response({ error: PRIVATE }, 429)),
      () => mockFetch(new Response('{')),
      () => {
        const fetch: jest.MockedFunction<TokenFetch> = jest.fn()
          .mockRejectedValue(new Error(PRIVATE));
        return fetch;
      },
    ];
    for (const fixture of fixtures) {
      const fetch = fixture();
      await expectFailure(requestTokens(fetch, credentials, refresh));
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const stalled: jest.MockedFunction<TokenFetch> = jest.fn<
      ReturnType<TokenFetch>, Parameters<TokenFetch>
    >(() => new Promise<Response>(() => undefined));
    const failure = expectFailure(requestTokens(stalled, credentials, refresh));
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS);
    await failure;
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('preserves legacy non-200 cancellation without reading the response body', async () => {
    for (const status of [201, 302, 400, 401, 429, 500]) {
      const cancel = jest.fn(() => { throw new Error(PRIVATE); });
      const pull = jest.fn(() => { throw new Error(PRIVATE); });
      const body = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
      const fetch = mockFetch(new Response(body, { status }));
      await expectFailure(requestTokens(fetch, credentials, refresh));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    }
  });
});
