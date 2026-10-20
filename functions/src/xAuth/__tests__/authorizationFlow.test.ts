import { createPkceChallenge } from '../crypto';
import {
  createAuthorizationFlow,
  type AuthorizationFlowDeps,
} from '../authorizationFlow';
import type { StateStore } from '../stateStore';
import type { TokenFetch } from '../tokenTransport';

const FAILURE = 'X authorization flow failed';
const UID = 'flow-test-user';
const REDIRECT = 'https://example.test/callback?next=a+b&path=%2F';
const SCOPE = 'tweet.read tweet.write users.read offline.access';
const PRIVATE = 'PRIVATE_PROVIDER_ERROR';
const CODE = 'code +&=雪';

function fixture() {
  const order: string[] = [];
  const start: jest.MockedFunction<StateStore['start']> =
    jest.fn().mockResolvedValue(undefined);
  const consume: jest.MockedFunction<StateStore['consume']> =
    jest.fn().mockImplementation(async () => {
      order.push('consume');
      return start.mock.calls[0][0].pkceVerifier;
    });
  const fetch: jest.MockedFunction<TokenFetch> =
    jest.fn().mockImplementation(async () => {
      order.push('fetch');
      return new Response(JSON.stringify({
        access_token: 'ACCESS_PRIVATE',
        refresh_token: 'REFRESH_PRIVATE',
        token_type: 'bearer',
        expires_in: 7200,
        scope: SCOPE,
      }));
    });
  const stage: jest.MockedFunction<AuthorizationFlowDeps['stage']> =
    jest.fn().mockImplementation(async () => {
      order.push('stage');
    });
  const deps: AuthorizationFlowDeps = {
    stateStore: { start, consume },
    fetch,
    credentials: {
      clientId: 'client+id',
      clientSecret: 'SECRET_PRIVATE',
    },
    redirectUri: REDIRECT,
    stateTtlMs: 123456,
    now: () => 1800000000000,
    stage,
  };
  return { deps, start, consume, fetch, stage, order };
}

async function failure(operation: Promise<unknown>) {
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
  for (const privateValue of [
    PRIVATE, CODE, 'ACCESS_PRIVATE', 'REFRESH_PRIVATE', 'SECRET_PRIVATE',
  ]) {
    expect(error.stack).not.toContain(privateValue);
  }
}

let logs: jest.SpyInstance[];

beforeEach(() => {
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined),
  );
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});

it('persists real random state/PKCE and returns only the exact authorization URL', async () => {
  const f = fixture();
  const flow = createAuthorizationFlow(f.deps);
  const first = await flow.begin(UID);
  const second = await flow.begin(UID);
  const saved = f.start.mock.calls[0][0];
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(saved).toEqual({
    uid: UID,
    state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    pkceVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    redirectUri: REDIRECT,
    expiresAt: 1800000123456,
  });
  const url = new URL(first);
  expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
  expect([...url.searchParams.entries()]).toEqual([
    ['response_type', 'code'],
    ['client_id', 'client+id'],
    ['redirect_uri', REDIRECT],
    ['scope', SCOPE],
    ['state', saved.state],
    ['code_challenge', createPkceChallenge(saved.pkceVerifier)],
    ['code_challenge_method', 'S256'],
  ]);
  expect(first).not.toContain(saved.pkceVerifier);
  expect(first).not.toContain('SECRET_PRIVATE');
  expect(second).not.toBe(first);
  expect(f.start.mock.calls[1][0].pkceVerifier).not.toBe(saved.pkceVerifier);
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});

it('awaits state persistence before returning the URL', async () => {
  const f = fixture();
  let release!: () => void;
  f.start.mockImplementation(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  let returned = false;
  const pending = createAuthorizationFlow(f.deps).begin(UID).then((url) => {
    returned = true;
    return url;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  release();
  expect(typeof await pending).toBe('string');
});

it('consumes exact UID/state/redirect before HTTP and stages before returning only candidateId', async () => {
  const f = fixture();
  const flow = createAuthorizationFlow(f.deps);
  const url = new URL(await flow.begin(UID));
  const state = url.searchParams.get('state')!;
  const verifier = f.start.mock.calls[0][0].pkceVerifier;

  let releaseConsume!: () => void;
  f.consume.mockImplementation(() => {
    f.order.push('consume');
    return new Promise<string>((resolve) => {
      releaseConsume = () => resolve(verifier);
    });
  });
  let releaseStage!: () => void;
  f.stage.mockImplementation(() => {
    f.order.push('stage');
    return new Promise<void>((resolve) => { releaseStage = resolve; });
  });

  let finished = false;
  const pending = flow.complete(UID, { state, code: CODE }).then((result) => {
    finished = true;
    return result;
  });
  expect(f.consume).toHaveBeenCalledWith({
    uid: UID, state, expectedRedirectUri: REDIRECT,
  });
  expect(f.fetch).not.toHaveBeenCalled();
  releaseConsume();
  // Wait for the actual stage invocation, without timers or network.
  while (f.stage.mock.calls.length === 0) await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.order).toEqual(['consume', 'fetch', 'stage']);

  expect(f.fetch).toHaveBeenCalledTimes(1);
  const [endpoint, request] = f.fetch.mock.calls[0];
  expect(endpoint).toBe('https://api.x.com/2/oauth2/token');
  expect(request).toEqual({
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(
        'client%2Bid:SECRET_PRIVATE',
      ).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: expect.any(URLSearchParams),
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  expect([...request.body.entries()]).toEqual([
    ['grant_type', 'authorization_code'],
    ['code', CODE],
    ['redirect_uri', REDIRECT],
    ['code_verifier', verifier],
  ]);

  const staged = f.stage.mock.calls[0][0];
  expect(staged).toEqual({
    uid: UID,
    candidateId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    tokens: {
      accessToken: 'ACCESS_PRIVATE',
      refreshToken: 'REFRESH_PRIVATE',
      tokenType: 'Bearer',
      expiresIn: 7200,
      scope: SCOPE,
    },
  });
  releaseStage();
  expect(await pending).toEqual({ candidateId: staged.candidateId });
  expect(f.stage).toHaveBeenCalledTimes(1);
});

it.each(['start', 'consume', 'fetch', 'stage'] as const)(
  'sanitizes %s failure and stops subsequent operations',
  async (point) => {
    const f = fixture();
    const flow = createAuthorizationFlow(f.deps);
    if (point === 'start') {
      f.start.mockRejectedValue(new Error(PRIVATE));
      await failure(flow.begin(UID));
      expect(f.consume).not.toHaveBeenCalled();
    } else {
      await flow.begin(UID);
      const state = f.start.mock.calls[0][0].state;
      if (point === 'consume') f.consume.mockRejectedValue(new Error(PRIVATE));
      if (point === 'fetch') f.fetch.mockRejectedValue(new Error(PRIVATE));
      if (point === 'stage') f.stage.mockRejectedValue(new Error(PRIVATE));
      await failure(flow.complete(UID, { state, code: CODE }));
    }
    expect(f.fetch).toHaveBeenCalledTimes(
      point === 'fetch' || point === 'stage' ? 1 : 0,
    );
    expect(f.stage).toHaveBeenCalledTimes(point === 'stage' ? 1 : 0);
  },
);

it('passes mismatched state unchanged to the bound store and never exchanges on rejection', async () => {
  const f = fixture();
  const flow = createAuthorizationFlow(f.deps);
  await flow.begin(UID);
  f.consume.mockRejectedValue(new Error(PRIVATE));
  await failure(flow.complete('another-user', { state: 'wrong-state', code: CODE }));
  expect(f.consume).toHaveBeenCalledWith({
    uid: 'another-user',
    state: 'wrong-state',
    expectedRedirectUri: REDIRECT,
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});

it('rejects a malformed consumed verifier before HTTP', async () => {
  const f = fixture();
  f.consume.mockResolvedValue('invalid');
  await failure(createAuthorizationFlow(f.deps).complete(
    UID, { state: 'state', code: CODE },
  ));
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});

it.each([
  '', ' ', '.', '..', '__reserved__', 'users/other',
  'a\nb', '\ud800', 'a'.repeat(129), null, 12,
])('rejects unsafe UID %j before dependencies', async (uid) => {
  const f = fixture();
  const flow = createAuthorizationFlow(f.deps);
  await failure(flow.begin(uid as string));
  await failure(flow.complete(uid as string, { state: 'state', code: CODE }));
  expect(f.start).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});

it.each(['state', 'code'] as const)('bounds and validates %s before consuming', async (field) => {
  for (const value of ['', ' ', '\n', '\ud800', 'a'.repeat(4097), null, 12]) {
    const f = fixture();
    await failure(createAuthorizationFlow(f.deps).complete(UID, {
      state: 'state',
      code: CODE,
      [field]: value,
    } as { state: string; code: string }));
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.stage).not.toHaveBeenCalled();
  }
});

it('rejects missing callback input without consuming', async () => {
  const f = fixture();
  await failure(createAuthorizationFlow(f.deps).complete(
    UID, undefined as unknown as { state: string; code: string },
  ));
  expect(f.consume).not.toHaveBeenCalled();
});

it.each([
  { redirectUri: '' },
  { redirectUri: ' https://example.test/cb' },
  { redirectUri: 'https://example.test/cb\n' },
  { redirectUri: '/relative' },
  { redirectUri: 'https://user:password@example.test/cb' },
  { redirectUri: 'https://example.test/cb#fragment' },
  { credentials: { clientId: '', clientSecret: 'secret' } },
  { credentials: { clientId: ' padded ', clientSecret: 'secret' } },
  { credentials: { clientId: '\ud800', clientSecret: 'secret' } },
  { credentials: { clientId: 'id', clientSecret: '' } },
  { stateTtlMs: undefined },
  { stateTtlMs: 0 },
  { stateTtlMs: -1 },
  { stateTtlMs: 0.5 },
  { stateTtlMs: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid explicit configuration %j', (change) => {
  const f = fixture();
  expect(() => createAuthorizationFlow({
    ...f.deps, ...change,
  } as AuthorizationFlowDeps)).toThrow(FAILURE);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
});

it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])(
  'rejects invalid current time/unsafe expiry %s before persistence', async (now) => {
    const f = fixture();
    await failure(createAuthorizationFlow({
      ...f.deps, now: () => now,
    }).begin(UID));
    expect(f.start).not.toHaveBeenCalled();
  },
);

it('sanitizes clock failure before persistence', async () => {
  const f = fixture();
  await failure(createAuthorizationFlow({
    ...f.deps,
    now: () => { throw new Error(PRIVATE); },
  }).begin(UID));
  expect(f.start).not.toHaveBeenCalled();
});

it('captures exact configuration so later caller mutation cannot alter redirect binding', async () => {
  const f = fixture();
  const config = { ...f.deps, credentials: { ...f.deps.credentials } };
  const flow = createAuthorizationFlow(config);
  config.redirectUri = 'https://other.test/cb';
  config.credentials.clientId = 'changed';
  const url = new URL(await flow.begin(UID));
  expect(url.searchParams.get('client_id')).toBe('client+id');
  expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  await flow.complete(UID, { state: 'state', code: CODE });
  expect(f.consume.mock.calls[0][0].expectedRedirectUri).toBe(REDIRECT);
  expect(f.fetch.mock.calls[0][1].body.get('redirect_uri')).toBe(REDIRECT);
});
