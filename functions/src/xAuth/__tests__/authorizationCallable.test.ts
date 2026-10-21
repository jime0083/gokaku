import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { ensureAdminApp } from '../../firebaseAdmin';
import {
  createProductionAuthorizationFlow,
  handleAuthorizationRequest,
} from '../authorizationCallable';
import type { AuthorizationFlow } from '../authorizationFlow';
import type { CandidateFlow } from '../candidateFlow';
import { createCandidateStore } from '../candidateStore';
import {
  AuthorizationConfigError,
  X_OAUTH_CLIENT_ID,
  X_OAUTH_CLIENT_SECRET,
  X_TOKEN_ENCRYPTION_KEY,
  X_OAUTH_REDIRECT_URI,
  X_OAUTH_STATE_TTL_SECONDS,
} from '../config';
import { createStateStore } from '../stateStore';
import { createTokenStore } from '../tokenStore';

jest.mock('firebase-functions/params', () => {
  const define = (name: string) => ({ name, value: jest.fn() });
  return { defineSecret: jest.fn(define), defineString: jest.fn(define),
    defineInt: jest.fn(define) };
});
jest.mock('firebase-functions/v2/https', () => ({
  ...jest.requireActual('firebase-functions/v2/https'),
  onCall: jest.fn((_options, handler) => handler),
}));
jest.mock('../../firebaseAdmin', () => ({ ensureAdminApp: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  ...jest.requireActual('firebase-admin/firestore'),
  getFirestore: jest.fn(),
}));
jest.mock('../stateStore', () => ({ createStateStore: jest.fn() }));
jest.mock('../tokenStore', () => ({ createTokenStore: jest.fn() }));
jest.mock('../candidateStore', () => ({ createCandidateStore: jest.fn() }));

const registration = jest.mocked(onCall).mock.calls.slice();
const UID = 'callable-user';
const REDIRECT = 'https://example.test/callback?next=a+b&path=%2F';
const PRIVATE = 'PRIVATE_PROVIDER_TOKEN_SECRET';
const params = [X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET,
  X_TOKEN_ENCRYPTION_KEY, X_OAUTH_REDIRECT_URI, X_OAUTH_STATE_TTL_SECONDS];

function request(data: unknown, uid: unknown = UID) {
  return {
    data,
    auth: uid === undefined ? undefined : { uid },
  } as Pick<CallableRequest<unknown>, 'auth' | 'data'>;
}

function fixture() {
  const flow: jest.Mocked<AuthorizationFlow> = {
    begin: jest.fn().mockResolvedValue('https://example.test/authorize'),
    complete: jest.fn().mockResolvedValue({ candidateId: 'candidate', token: PRIVATE }),
  };
  const factory = jest.fn(async () => flow);
  return { flow, factory };
}

async function failure(operation: Promise<unknown>, code: string, message: string) {
  const error: unknown = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect(error).toMatchObject({ code, message, details: undefined });
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  expect((error as Error).stack).not.toContain(PRIVATE);
  expect(JSON.stringify(error)).not.toContain(PRIVATE);
}

let logs: jest.SpyInstance[];
let network: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(X_OAUTH_CLIENT_ID.value).mockReturnValue('synthetic-client');
  jest.mocked(X_OAUTH_CLIENT_SECRET.value).mockReturnValue('synthetic-secret');
  jest.mocked(X_TOKEN_ENCRYPTION_KEY.value)
    .mockReturnValue(Buffer.alloc(32, 7).toString('base64'));
  jest.spyOn(X_OAUTH_REDIRECT_URI, 'value').mockReturnValue(REDIRECT);
  jest.spyOn(X_OAUTH_STATE_TTL_SECONDS, 'value').mockReturnValue(123);
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined));
  network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(PRIVATE));
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});

it('registers one regional callable with bound secrets, without import-time reads', () => {
  for (const param of params) expect(param.value).not.toHaveBeenCalled();
  expect(registration).toHaveLength(1);
  expect(registration[0][0]).toEqual({
    region: 'asia-northeast1',
    secrets: [X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, X_TOKEN_ENCRYPTION_KEY],
  });
});

it.each(['', ' ', '.', '..', '__reserved__', 'other/user', 'a'.repeat(129),
  '\n', '\ud800', null, 42])('rejects unsafe authenticated UID %j before dependencies', async (uid) => {
  const f = fixture();
  await failure(handleAuthorizationRequest(request({ action: 'begin' }, uid), f.factory),
    'unauthenticated', 'ログインが必要です');
  expect(f.factory).not.toHaveBeenCalled();
  for (const param of params) expect(param.value).not.toHaveBeenCalled();
});

it('rejects missing authentication before even examining payload', async () => {
  const f = fixture();
  const req = { data: null, auth: undefined };
  await failure(handleAuthorizationRequest(req, f.factory),
    'unauthenticated', 'ログインが必要です');
  expect(f.factory).not.toHaveBeenCalled();
});

it.each([undefined, null, [], new Date(), 'begin', {}, { action: 'confirm' },
  { action: 'begin', uid: UID }, { action: 'begin', token: PRIVATE },
  { action: 'begin', candidateId: 'chosen' }, { action: 'begin', state: 'extra' },
  { action: 'complete', state: 'state' },
  { action: 'complete', code: 'code' },
  { action: 'complete', state: 'state', code: 'code', redirectUri: REDIRECT },
  Object.create({ action: 'begin' }),
  Object.defineProperty({ action: 'begin' }, 'token', { value: PRIVATE }),
  { action: 'begin', [Symbol('extra')]: true },
  Object.defineProperty({}, 'action', { get: () => { throw new Error(PRIVATE); } }),
])('rejects malformed/extra payload %j before factory', async (data) => {
  const f = fixture();
  await failure(handleAuthorizationRequest(request(data), f.factory),
    'invalid-argument', 'Invalid X authorization request');
  expect(f.factory).not.toHaveBeenCalled();
});

it.each(['state', 'code'] as const)('validates the entire %s boundary before factory', async (field) => {
  for (const value of [undefined, null, 1, '', ' ', '\n', 'a\u007fb',
    '\ud800', '\udc00', 'a'.repeat(4097)]) {
    const f = fixture();
    await failure(handleAuthorizationRequest(request({
      action: 'complete', state: 'state', code: 'code', [field]: value,
    }), f.factory), 'invalid-argument', 'Invalid X authorization request');
    expect(f.factory).not.toHaveBeenCalled();
  }
});

it('returns only minimal results and preserves exact callback values', async () => {
  const f = fixture();
  expect(await handleAuthorizationRequest(request({ action: 'begin' }), f.factory))
    .toEqual({ authorizationUrl: 'https://example.test/authorize' });
  const input = { state: 'a'.repeat(4096), code: ' code +&=雪 ' };
  expect(await handleAuthorizationRequest(request({
    action: 'complete', ...input,
  }), f.factory)).toEqual({ candidateId: 'candidate' });
  expect(f.flow.begin).toHaveBeenCalledWith(UID);
  expect(f.flow.complete).toHaveBeenCalledWith(UID, input);
  expect(network).not.toHaveBeenCalled();
});

it.each(['begin', 'complete'] as const)('sanitizes %s flow errors, including HttpsErrors', async (action) => {
  const f = fixture();
  f.flow[action].mockRejectedValue(new HttpsError('invalid-argument', PRIVATE, { token: PRIVATE }));
  await failure(handleAuthorizationRequest(request(action === 'begin'
    ? { action } : { action, state: 'state', code: 'code' }), f.factory),
  'internal', 'X authorization failed');
});

it('sanitizes configuration and unexpected factory failures separately', async () => {
  const factory = jest.fn<Promise<AuthorizationFlow>, []>()
    .mockRejectedValueOnce(new AuthorizationConfigError())
    .mockRejectedValueOnce(new Error(PRIVATE));
  await failure(handleAuthorizationRequest(request({ action: 'begin' }), factory),
    'failed-precondition', 'X authorization is not configured');
  await failure(handleAuthorizationRequest(request({ action: 'begin' }), factory),
    'internal', 'X authorization failed');
});

function wire() {
  const start = jest.fn().mockResolvedValue(undefined);
  const consume = jest.fn().mockImplementation(async () => start.mock.calls[0][0].pkceVerifier);
  const stage = jest.fn().mockResolvedValue(undefined);
  jest.mocked(createStateStore).mockReturnValue({ start, consume });
  jest.mocked(createTokenStore).mockReturnValue({ stage });
  return { start, consume, stage };
}

it('wires real flow to stores, one clock/key, exact redirect and mocked global fetch', async () => {
  const f = wire();
  network.mockResolvedValue(new Response(JSON.stringify({
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
    token_type: 'bearer', expires_in: 7200,
    scope: 'tweet.read tweet.write users.read offline.access',
  })));
  const begin = await handleAuthorizationRequest(request({ action: 'begin' }),
    createProductionAuthorizationFlow);
  const url = new URL((begin as { authorizationUrl: string }).authorizationUrl);
  expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  expect(ensureAdminApp).toHaveBeenCalledTimes(1);
  expect(getFirestore).toHaveBeenCalledTimes(1);
  const stateDeps = jest.mocked(createStateStore).mock.calls[0][0];
  const tokenDeps = jest.mocked(createTokenStore).mock.calls[0][0];
  expect(stateDeps).toBe(tokenDeps);
  expect(stateDeps.encryptionKey).toBe(Buffer.alloc(32, 7).toString('base64'));
  const result = await handleAuthorizationRequest(request({
    action: 'complete', state: url.searchParams.get('state'), code: 'code +&雪',
  }), createProductionAuthorizationFlow);
  expect(result).toEqual({ candidateId: f.stage.mock.calls[0][0].candidateId });
  expect(Object.keys(result)).toEqual(['candidateId']);
  expect(f.consume).toHaveBeenCalledWith({
    uid: UID, state: url.searchParams.get('state'), expectedRedirectUri: REDIRECT,
  });
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][1].body.get('redirect_uri')).toBe(REDIRECT);
  expect(f.stage.mock.calls[0][0].uid).toBe(UID);
});

it.each(['mismatch', 'exchange'])('sanitizes real-flow %s with no staged candidate', async (point) => {
  const f = wire();
  await handleAuthorizationRequest(request({ action: 'begin' }), createProductionAuthorizationFlow);
  if (point === 'mismatch') f.consume.mockRejectedValue(new Error(PRIVATE));
  await failure(handleAuthorizationRequest(request({
    action: 'complete', state: 'wrong-state', code: 'code',
  }), createProductionAuthorizationFlow), 'internal', 'X authorization failed');
  expect(network).toHaveBeenCalledTimes(point === 'mismatch' ? 0 : 1);
  expect(f.stage).not.toHaveBeenCalled();
});

it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER,
  Math.floor(Number.MAX_SAFE_INTEGER / 1000), 253402300800])(
  'rejects invalid/unsafe/out-of-Firestore-range TTL %s before Admin',
  async (seconds) => {
    jest.mocked(X_OAUTH_STATE_TTL_SECONDS.value).mockReturnValue(seconds);
    await failure(handleAuthorizationRequest(request({ action: 'begin' }),
      createProductionAuthorizationFlow),
    'failed-precondition', 'X authorization is not configured');
    expect(ensureAdminApp).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

it.each(params)('rejects absent configuration before Admin', async (param) => {
  jest.mocked(param.value as () => unknown).mockReturnValue(undefined);
  await failure(handleAuthorizationRequest(request({ action: 'begin' }),
    createProductionAuthorizationFlow),
  'failed-precondition', 'X authorization is not configured');
  expect(ensureAdminApp).not.toHaveBeenCalled();
});

it.each(['bad', Buffer.alloc(31).toString('base64'),
  Buffer.alloc(32).toString('base64').replace(/=$/, ''),
  Buffer.alloc(32).toString('base64').replace(/A=$/, 'B=')])(
  'rejects malformed/noncanonical encryption key before Admin', async (key) => {
    jest.mocked(X_TOKEN_ENCRYPTION_KEY.value).mockReturnValue(key);
    await failure(handleAuthorizationRequest(request({ action: 'begin' }),
      createProductionAuthorizationFlow),
    'failed-precondition', 'X authorization is not configured');
    expect(ensureAdminApp).not.toHaveBeenCalled();
  });

it.each(['', '/relative', ' https://example.test/cb', 'https://user:pass@example.test/cb',
  'https://example.test/cb#fragment', 'https://example.test/\n'])(
  'rejects invalid configured redirect before Admin', async (redirect) => {
    jest.mocked(X_OAUTH_REDIRECT_URI.value).mockReturnValue(redirect);
    await failure(handleAuthorizationRequest(request({ action: 'begin' }),
      createProductionAuthorizationFlow),
    'failed-precondition', 'X authorization is not configured');
    expect(ensureAdminApp).not.toHaveBeenCalled();
  });

it('sanitizes a throwing parameter reader', async () => {
  jest.mocked(X_OAUTH_CLIENT_ID.value).mockImplementationOnce(() => { throw new Error(PRIVATE); });
  await failure(handleAuthorizationRequest(request({ action: 'begin' }),
    createProductionAuthorizationFlow),
  'failed-precondition', 'X authorization is not configured');
  expect(ensureAdminApp).not.toHaveBeenCalled();
});

// Evaluate only this module with a synthetic process and SDK. No real env values.
function isolatedConfig() {
  const source = readFileSync(require.resolve('../config'), 'utf8');
  const declarations = {
    defineSecret: jest.fn((name: string) => ({ name, value: jest.fn() })),
    defineString: jest.fn(),
    defineInt: jest.fn(),
  };
  const reads = { environment: 0, values: 0 };
  const syntheticEnvironment = new Proxy({}, {
    get: () => { reads.values += 1; return undefined; },
  });
  const syntheticProcess = Object.defineProperty({}, 'env', {
    get: () => { reads.environment += 1; return syntheticEnvironment; },
  });
  const exported = {};
  runInNewContext(transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, {
    exports: exported,
    process: syntheticProcess,
    require: (name: string) => {
      if (name !== 'firebase-functions/params') throw new Error('Unexpected module');
      return declarations;
    },
  });
  return {
    config: exported as typeof import('../config'),
    declarations,
    reads,
  };
}

it('imports config with only three secret declarations and no value/environment reads', () => {
  const f = isolatedConfig();
  expect(f.declarations.defineSecret.mock.calls).toEqual([
    ['X_OAUTH_CLIENT_ID'], ['X_OAUTH_CLIENT_SECRET'], ['X_TOKEN_ENCRYPTION_KEY'],
  ]);
  expect(f.declarations.defineString).not.toHaveBeenCalled();
  expect(f.declarations.defineInt).not.toHaveBeenCalled();
  for (const result of f.declarations.defineSecret.mock.results) {
    expect(result.value.value).not.toHaveBeenCalled();
  }
  expect(f.reads).toEqual({ environment: 0, values: 0 });
});

it('reads only the requested synthetic runtime setting and preserves exact redirect', () => {
  const f = isolatedConfig();
  const reader = jest.fn((name: string) =>
    name === 'X_OAUTH_REDIRECT_URI' ? REDIRECT : '123');
  expect(f.config.X_OAUTH_REDIRECT_URI.value(reader)).toBe(REDIRECT);
  expect(f.config.X_OAUTH_STATE_TTL_SECONDS.value(reader)).toBe(123);
  expect(reader.mock.calls).toEqual([
    ['X_OAUTH_REDIRECT_URI'], ['X_OAUTH_STATE_TTL_SECONDS'],
  ]);
  expect(f.reads).toEqual({ environment: 0, values: 0 });
});

it.each([undefined, '', ' ', '0', '-1', '1.5', '1e3', '1x', ' 123',
  '123 ', '+123', 'Infinity', 'NaN', '9007199254740992'])(
  'rejects missing or invalid synthetic runtime TTL %j with fixed config failure', (raw) => {
    const f = isolatedConfig();
    expect(() => f.config.X_OAUTH_STATE_TTL_SECONDS.value(() => raw))
      .toThrow('X authorization is not configured');
    expect(f.reads).toEqual({ environment: 0, values: 0 });
  });

it('rejects missing synthetic runtime redirect with fixed config failure', () => {
  const f = isolatedConfig();
  expect(() => f.config.X_OAUTH_REDIRECT_URI.value(() => undefined))
    .toThrow('X authorization is not configured');
  expect(f.reads).toEqual({ environment: 0, values: 0 });
});

function candidateFixture() {
  const candidate = {
    candidateId: 'candidate_1-test',
    profile: { id: '123', username: 'tester', profileImageUrl: null },
    expiresAt: 123456789,
  };
  const flow: jest.Mocked<CandidateFlow> = {
    getPending: jest.fn().mockResolvedValue({
      ...candidate,
      encryptedAccessToken: PRIVATE,
      encryptedRefreshToken: PRIVATE,
      profile: { ...candidate.profile, token: PRIVATE },
    }),
    confirm: jest.fn().mockResolvedValue({ token: PRIVATE }),
    discard: jest.fn().mockResolvedValue({ token: PRIVATE }),
  };
  return { candidate, flow, factory: jest.fn(async () => flow) };
}

describe('candidate callable actions', () => {
  const actions = [
    { action: 'pending' },
    { action: 'confirm', candidateId: 'candidate_1-test', postEnabled: true },
    { action: 'discard', candidateId: 'candidate_1-test' },
  ];

  it('returns only public pending fields, including null', async () => {
    const auth = fixture();
    const f = candidateFixture();
    expect(await handleAuthorizationRequest(
      request(actions[0]), auth.factory, f.factory,
    )).toEqual({ pending: f.candidate });
    expect(f.flow.getPending).toHaveBeenCalledWith(UID);
    f.flow.getPending.mockResolvedValueOnce(null);
    expect(await handleAuthorizationRequest(
      request(actions[0]), auth.factory, f.factory,
    )).toEqual({ pending: null });
    expect(auth.factory).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([true, false])('passes exact consent %s and returns only ok', async (postEnabled) => {
    const auth = fixture();
    const f = candidateFixture();
    expect(await handleAuthorizationRequest(request({
      action: 'confirm', candidateId: f.candidate.candidateId, postEnabled,
    }), auth.factory, f.factory)).toEqual({ ok: true });
    expect(f.flow.confirm).toHaveBeenCalledWith(
      UID, f.candidate.candidateId, postEnabled,
    );
    expect(f.flow.getPending).not.toHaveBeenCalled();
    expect(auth.factory).not.toHaveBeenCalled();
  });

  it('discards with authenticated UID and returns only ok', async () => {
    const auth = fixture();
    const f = candidateFixture();
    expect(await handleAuthorizationRequest(
      request(actions[2]), auth.factory, f.factory,
    )).toEqual({ ok: true });
    expect(f.flow.discard).toHaveBeenCalledWith(UID, f.candidate.candidateId);
    expect(auth.factory).not.toHaveBeenCalled();
  });

  it.each(actions)('authenticates before inspecting candidate payload %j', async (data) => {
    const auth = fixture();
    const f = candidateFixture();
    const req = { auth: undefined, get data(): unknown { throw new Error(PRIVATE); } };
    await failure(handleAuthorizationRequest(req, auth.factory, f.factory),
      'unauthenticated', 'ログインが必要です');
    expect(auth.factory).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    await failure(handleAuthorizationRequest(
      request(data, 'other/user'), auth.factory, f.factory,
    ), 'unauthenticated', 'ログインが必要です');
    expect(f.factory).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects all extra candidate fields before factories %j', async (data) => {
    const auth = fixture();
    const f = candidateFixture();
    const getter = jest.fn(() => PRIVATE);
    const payloads = [
      ...['uid', 'profile', 'username', 'token', 'postEnabledExtra'].map(
        (key) => ({ ...data, [key]: PRIVATE }),
      ),
      Object.defineProperty({ ...data }, 'hidden', { value: PRIVATE }),
      { ...data, [Symbol('hidden')]: PRIVATE },
      Object.defineProperty({ ...data }, 'profile', { get: getter }),
      Object.create(data),
    ];
    for (const payload of payloads) {
      await failure(handleAuthorizationRequest(
        request(payload), auth.factory, f.factory,
      ), 'invalid-argument', 'Invalid X authorization request');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(auth.factory).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    for (const param of params) expect(param.value).not.toHaveBeenCalled();
  });

  it.each(['confirm', 'discard'])('rejects unsafe candidate IDs for %s before factories', async (action) => {
    const auth = fixture();
    const f = candidateFixture();
    for (const candidateId of [
      undefined, null, 1, '', ' ', '.', '..', '__reserved__', 'a/b',
      'a b', 'a\n', 'a\u007f', '\ud800', '雪', 'a'.repeat(1501),
    ]) {
      await failure(handleAuthorizationRequest(request({
        action, candidateId, ...(action === 'confirm' ? { postEnabled: false } : {}),
      }), auth.factory, f.factory),
      'invalid-argument', 'Invalid X authorization request');
    }
    expect(auth.factory).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it.each<'confirm' | 'discard'>(['confirm', 'discard'])('accepts the exact candidate ID length boundary for %s', async (action) => {
    const auth = fixture();
    const f = candidateFixture();
    const candidateId = 'a'.repeat(1500);
    expect(await handleAuthorizationRequest(request({
      action, candidateId, ...(action === 'confirm' ? { postEnabled: false } : {}),
    }), auth.factory, f.factory)).toEqual({ ok: true });
    expect(f.flow[action]).toHaveBeenCalledWith(
      UID, candidateId, ...(action === 'confirm' ? [false] : []),
    );
  });

  it.each([undefined, null, 0, 1, '', 'false', {}, []])(
    'rejects nonboolean consent %j before factories', async (postEnabled) => {
      const auth = fixture();
      const f = candidateFixture();
      await failure(handleAuthorizationRequest(request({
        action: 'confirm', candidateId: 'candidate', postEnabled,
      }), auth.factory, f.factory),
      'invalid-argument', 'Invalid X authorization request');
      expect(auth.factory).not.toHaveBeenCalled();
      expect(f.factory).not.toHaveBeenCalled();
    },
  );

  it.each([
    { action: 'pending', candidateId: 'candidate' },
    { action: 'pending', postEnabled: true },
    { action: 'confirm', candidateId: 'candidate' },
    { action: 'discard' },
    { action: 'discard', candidateId: 'candidate', postEnabled: false },
    { action: 'other' },
  ])('rejects missing/wrong action fields %j before factories', async (data) => {
    const auth = fixture();
    const f = candidateFixture();
    await failure(handleAuthorizationRequest(
      request(data), auth.factory, f.factory,
    ), 'invalid-argument', 'Invalid X authorization request');
    expect(auth.factory).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('keeps candidate factory lazy for begin and complete', async () => {
    const auth = fixture();
    const f = candidateFixture();
    await handleAuthorizationRequest(request({ action: 'begin' }), auth.factory, f.factory);
    await handleAuthorizationRequest(request({
      action: 'complete', state: 'state', code: 'code',
    }), auth.factory, f.factory);
    expect(f.factory).not.toHaveBeenCalled();
    expect(createCandidateStore).not.toHaveBeenCalled();
  });

  it.each(actions)('redacts candidate operation and factory errors %j', async (data) => {
    const auth = fixture();
    const f = candidateFixture();
    const secretError = new HttpsError('permission-denied', PRIVATE, { token: PRIVATE });
    f.flow.getPending.mockRejectedValue(secretError);
    f.flow.confirm.mockRejectedValue(secretError);
    f.flow.discard.mockRejectedValue(secretError);
    await failure(handleAuthorizationRequest(
      request(data), auth.factory, f.factory,
    ), 'internal', 'X authorization failed');
    f.factory.mockRejectedValueOnce(new AuthorizationConfigError());
    await failure(handleAuthorizationRequest(
      request(data), auth.factory, f.factory,
    ), 'failed-precondition', 'X authorization is not configured');
    f.factory.mockRejectedValueOnce(secretError);
    await failure(handleAuthorizationRequest(
      request(data), auth.factory, f.factory,
    ), 'internal', 'X authorization failed');
    expect(auth.factory).not.toHaveBeenCalled();
  });

  it('lazily wires the default candidate flow to the production store', async () => {
    const auth = fixture();
    const get = jest.fn().mockResolvedValue(null);
    jest.mocked(createCandidateStore).mockReturnValue({
      get, attachProfile: jest.fn(), confirm: jest.fn(), discard: jest.fn(),
    });
    expect(await handleAuthorizationRequest(
      request({ action: 'pending' }), auth.factory,
    )).toEqual({ pending: null });
    expect(get).toHaveBeenCalledWith(UID);
    expect(ensureAdminApp).toHaveBeenCalledTimes(1);
    expect(getFirestore).toHaveBeenCalledTimes(1);
    const deps = jest.mocked(createCandidateStore).mock.calls[0][0];
    expect(deps.encryptionKey).toBe(Buffer.alloc(32, 7).toString('base64'));
    expect(Number.isSafeInteger(deps.now())).toBe(true);
    expect(auth.factory).not.toHaveBeenCalled();
    expect(createStateStore).not.toHaveBeenCalled();
    expect(createTokenStore).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
