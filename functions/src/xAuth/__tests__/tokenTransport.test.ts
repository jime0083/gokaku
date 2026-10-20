import { ReadableStream } from 'node:stream/web';
import {
  requestTokens,
  TOKEN_RESPONSE_MAX_BYTES,
  TOKEN_TIMEOUT_MS,
  type TokenFetch,
  type TokenGrant,
} from '../tokenTransport';

const FAILURE = 'X OAuth token request failed';
const PRIVATE = 'PRIVATE_DO_NOT_EXPOSE';
const credentials = {
  clientId: 'id :+é&',
  clientSecret: 'secret:/? +雪',
};
const scope = 'tweet.read tweet.write users.read offline.access';
const verifier = 'v'.repeat(43);
const exchange: Extract<
  TokenGrant,
  { grantType: 'authorization_code' }
> = {
  grantType: 'authorization_code',
  code: 'code +&=雪',
  redirectUri: 'https://example.test/cb?next=a+b&x=%2F',
  codeVerifier: verifier,
};
const refresh: TokenGrant = {
  grantType: 'refresh_token',
  refreshToken: 'old +/=&雪',
  grantedScope: scope,
};

function valid(): Record<string, unknown> {
  return {
    access_token: 'ACCESS_PRIVATE',
    token_type: 'bearer',
    expires_in: 7200,
    refresh_token: 'REFRESH_PRIVATE',
    scope,
  };
}

function without(field: string): Record<string, unknown> {
  const value = valid();
  delete value[field];
  return value;
}

function response(value: unknown = valid(), status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function mockFetch(value = response()): jest.MockedFunction<TokenFetch> {
  return jest.fn().mockResolvedValue(value);
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
  expect(error.stack).not.toContain(PRIVATE);
  expect(error.stack).not.toContain(credentials.clientId);
  expect(error.stack).not.toContain(credentials.clientSecret);
  expect(error.stack).not.toContain(exchange.code);
  expect(error.stack).not.toContain('ACCESS_PRIVATE');
  expect(error.stack).not.toContain('REFRESH_PRIVATE');
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
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

describe('server-only X OAuth token transport', () => {
  it('encodes each Basic credential before colon/base64 and sends exact exchange fields', async () => {
    const fetch = mockFetch();
    const result = await requestTokens(fetch, credentials, exchange);

    expect(fetch).toHaveBeenCalledTimes(1);
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
      `&code_verifier=${verifier}`,
    );
    expect(init.body.get('redirect_uri')).toBe(exchange.redirectUri);
    expect(init.body.get('code_verifier')).toBe(verifier);
    expect(result).toEqual({
      accessToken: 'ACCESS_PRIVATE',
      tokenType: 'Bearer',
      expiresIn: 7200,
      refreshToken: 'REFRESH_PRIVATE',
      scope,
    });
  });

  it('encodes refresh request and adopts rotated refresh token and returned scope', async () => {
    const returnedScope = `${scope} follows.read`;
    const fetch = mockFetch(response({
      ...valid(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
      scope: returnedScope,
    }));
    const result = await requestTokens(fetch, credentials, refresh);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body.toString()).toBe(
      'grant_type=refresh_token&refresh_token=old+%2B%2F%3D%26%E9%9B%AA',
    );
    expect(result.refreshToken).toBe('rotated');
    expect(result.scope).toBe(returnedScope);
  });

  it('retains old refresh token only when omitted and inherits explicit prior scope when omitted', async () => {
    const value = without('refresh_token');
    delete value.scope;
    const result = await requestTokens(mockFetch(response(value)), credentials, refresh);
    expect(result.refreshToken).toBe(refresh.refreshToken);
    expect(result.scope).toBe(scope);
  });

  it('allows refresh token retention independently of returned scope', async () => {
    const result = await requestTokens(
      mockFetch(response(without('refresh_token'))), credentials, refresh,
    );
    expect(result.refreshToken).toBe(refresh.refreshToken);
  });

  it('accepts reordered scopes and positive safe integer expiry boundaries', async () => {
    const returnedScope = 'offline.access users.read tweet.write tweet.read extra';
    for (const expiresIn of [1, Number.MAX_SAFE_INTEGER]) {
      const result = await requestTokens(mockFetch(response({
        ...valid(), scope: returnedScope, expires_in: expiresIn,
      })), credentials, exchange);
      expect(result.expiresIn).toBe(expiresIn);
      expect(result.scope).toBe(returnedScope);
    }
  });

  it.each([
    ['access missing', without('access_token')],
    ['access empty', { ...valid(), access_token: '' }],
    ['access whitespace', { ...valid(), access_token: ' ' }],
    ['access wrong type', { ...valid(), access_token: 1 }],
    ['type missing', without('token_type')],
    ['type wrong', { ...valid(), token_type: 'MAC' }],
    ['type padded', { ...valid(), token_type: ' Bearer' }],
    ['type numeric', { ...valid(), token_type: 1 }],
    ['scope missing', without('scope')],
    ['scope null', { ...valid(), scope: null }],
    ['scope numeric', { ...valid(), scope: 1 }],
    ['scope empty', { ...valid(), scope: '' }],
    ['scope prefix', { ...valid(), scope: `${scope.replace('tweet.write', 'tweet.write.extra')}` }],
    ['scope tabs', { ...valid(), scope: scope.replace(' ', '\t') }],
    ['scope invalid token', { ...valid(), scope: `${scope} invalid"scope` }],
    ['refresh missing', without('refresh_token')],
    ['refresh empty', { ...valid(), refresh_token: '' }],
    ['refresh null', { ...valid(), refresh_token: null }],
    ['refresh wrong type', { ...valid(), refresh_token: [] }],
    ['null payload', null],
    ['array payload', [valid()]],
    ['scalar payload', PRIVATE],
  ])('rejects invalid exchange response: %s', async (_label, value) => {
    await expectFailure(requestTokens(mockFetch(response(value)), credentials, exchange));
  });

  it.each(scope.split(' '))('rejects omission of required scope %s', async (missing) => {
    const value = {
      ...valid(),
      scope: scope.split(' ').filter((item) => item !== missing).join(' '),
    };
    await expectFailure(requestTokens(mockFetch(response(value)), credentials, exchange));
  });

  it.each([undefined, null, 0, -1, 0.5, '7200', true, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expiry %s', async (expiresIn) => {
      await expectFailure(requestTokens(mockFetch(response({
        ...valid(), expires_in: expiresIn,
      })), credentials, exchange));
    },
  );

  it.each([null, '', ' ', 0, false, [], {}])(
    'does not retain old refresh token when invalid value was supplied: %j',
    async (refreshToken) => {
      await expectFailure(requestTokens(mockFetch(response({
        ...valid(), refresh_token: refreshToken,
      })), credentials, refresh));
    },
  );

  it.each([null, '', 1, 'tweet.read', `${scope}\n`])(
    'rejects supplied invalid refresh scope: %j', async (returnedScope) => {
      await expectFailure(requestTokens(mockFetch(response({
        ...valid(), scope: returnedScope,
      })), credentials, refresh));
    },
  );

  it.each(['', 'tweet.read', `${scope}\t`, null, undefined])(
    'requires valid explicit prior granted scope before refresh: %j', async (prior) => {
      const fetch = mockFetch();
      await expectFailure(requestTokens(fetch, credentials, {
        ...refresh, grantedScope: prior,
      } as unknown as TokenGrant));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { clientId: '', clientSecret: 'secret' },
    { clientId: 'id', clientSecret: '' },
    { clientId: '\ud800', clientSecret: 'secret' },
  ])('rejects invalid credentials without sending them', async (input) => {
    const fetch = mockFetch();
    await expectFailure(requestTokens(fetch, input, exchange));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['code', 'redirectUri', 'codeVerifier'])(
    'rejects empty exchange input %s before fetch', async (field) => {
      const fetch = mockFetch();
      await expectFailure(requestTokens(fetch, credentials, {
        ...exchange, [field]: '',
      }));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid prior refresh token and unknown grant before fetch', async () => {
    const fetch = mockFetch();
    for (const grant of [
      { ...refresh, refreshToken: '' },
      { grantType: 'client_credentials' },
    ]) {
      await expectFailure(requestTokens(fetch, credentials, grant as TokenGrant));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([201, 302, 400, 401, 429, 500])(
    'rejects HTTP %s without reading or leaking the error body', async (status) => {
      const cancel = jest.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetch = mockFetch(new Response(body, { status }));
      await expectFailure(requestTokens(fetch, credentials, exchange));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it.each([`{"error":"${PRIVATE}"`, '', '<html>private</html>'])(
    'rejects malformed JSON without exposing its contents', async (text) => {
      await expectFailure(requestTokens(
        mockFetch(new Response(text)), credentials, exchange,
      ));
    },
  );

  it('rejects missing body', async () => {
    await expectFailure(requestTokens(
      mockFetch(new Response(null)), credentials, exchange,
    ));
  });

  it('sanitizes synchronous fetch exceptions and rejected promises', async () => {
    const synchronous: TokenFetch = () => { throw new Error(PRIVATE); };
    const asynchronous: TokenFetch = async () => { throw new Error(PRIVATE); };
    for (const fetch of [synchronous, asynchronous]) {
      await expectFailure(requestTokens(fetch, credentials, exchange));
    }
  });

  it('sanitizes body stream errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(PRIVATE)); },
    });
    await expectFailure(requestTokens(mockFetch(new Response(body)), credentials, exchange));
    expect(body.locked).toBe(false);
  });

  it('bounds stalled fetch even when injected fetch ignores AbortSignal', async () => {
    const fetch: jest.MockedFunction<TokenFetch> = jest.fn<
      ReturnType<TokenFetch>, Parameters<TokenFetch>
    >(
      () => new Promise<Response>(() => undefined),
    );
    const failure = expectFailure(requestTokens(fetch, credentials, exchange));
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS);
    await failure;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('cancels a response arriving after timeout', async () => {
    let resolve!: (value: Response) => void;
    const fetch: TokenFetch = () => new Promise<Response>((done) => { resolve = done; });
    const failure = expectFailure(requestTokens(fetch, credentials, exchange));
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS);
    await failure;
    const cancel = jest.fn();
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('uses one deadline across headers and stalled body; cancellation cannot delay rejection', async () => {
    let resolve!: (value: Response) => void;
    const fetch: TokenFetch = () => new Promise<Response>((done) => { resolve = done; });
    const failure = expectFailure(requestTokens(fetch, credentials, exchange));
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS - 1);
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    resolve(new Response(body));
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1);
    await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('accepts exactly the byte limit and decodes UTF-8 across chunk boundaries', async () => {
    const value = { ...valid(), access_token: '令牌' };
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
    const result = await requestTokens(mockFetch(new Response(body)), credentials, exchange);
    expect(result.accessToken).toBe('令牌');
    expect(body.locked).toBe(false);
  });

  it.each(['single', 'streamed'])(
    'rejects excessive %s response bytes and cancels reading', async (mode) => {
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
      await expectFailure(requestTokens(mockFetch(new Response(body)), credentials, exchange));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it('rejects invalid UTF-8 instead of replacing bytes inside a token', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat([
          Buffer.from('{"access_token":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]));
        controller.close();
      },
    });
    await expectFailure(requestTokens(mockFetch(new Response(body)), credentials, exchange));
  });
});
