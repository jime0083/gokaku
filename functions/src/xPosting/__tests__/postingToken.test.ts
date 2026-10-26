import { Timestamp } from 'firebase-admin/firestore';
import type { ActiveSnapshot, ActiveTokenStore } from '../../xAuth/activeTokenStore';
import { decrypt, encrypt } from '../../xAuth/crypto';
import * as transport from '../../xAuth/tokenTransport';
import type {
  TokenCredentials,
  TokenFetch,
  TokenOAuthError,
  TokenResult,
} from '../../xAuth/tokenTransport';
import { createPostingTokenProvider } from '../postingToken';

/**
 * formal7-3b internal: tests-first artifact; not executed by the author.
 * Main applies this file and confirms RED before requesting source.
 * No Emulator, environment lookup, global fetch, production credentials or writes.
 * Results use the existing transport convention: a `kind` discriminant.
 * ready is strictly server-internal; it is never logged or made callable here.
 */
const NOW = Date.UTC(2026, 9, 26);
const UID = 'posting_token_fixture';
const REVISION = 7;
const CANDIDATE = 'candidate_fixture';
const KEY = Buffer.alloc(32, 17).toString('base64');
const SCOPE = 'tweet.read tweet.write users.read offline.access';
const PRIVATE = 'PRIVATE_POSTING_TOKEN_FIXTURE';
const ACCESS = 'synthetic_cached_access';
const REFRESH = 'synthetic_cached_refresh';
const NEW_ACCESS = 'synthetic_rotated_access';
const NEW_REFRESH = 'synthetic_rotated_refresh';
const PERSISTED_ACCESS = 'synthetic_receipt_access';
const CREDENTIALS: TokenCredentials = {
  clientId: 'synthetic_client_id',
  clientSecret: 'synthetic_client_secret',
};
const UNKNOWN = { kind: 'relink_required', reason: 'unknown_refresh' };

type Dependencies = Parameters<typeof createPostingTokenProvider>[0];
type Control = 'idle' | 'inflight' | 'saved' | 'released' | 'blocked';

function snapshot(patch: Partial<ActiveSnapshot> = {}): ActiveSnapshot {
  return {
    uid: UID,
    linkRevision: REVISION,
    candidateId: CANDIDATE,
    xUserId: '12345',
    encryptedAccessToken: encrypt(ACCESS, KEY, { uid: UID, purpose: 'accessToken' }),
    encryptedRefreshToken: encrypt(REFRESH, KEY, { uid: UID, purpose: 'refreshToken' }),
    scope: SCOPE,
    expiresAt: Timestamp.fromMillis(NOW + 60_000),
    ...patch,
  };
}

function providerBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: NEW_ACCESS,
    refresh_token: NEW_REFRESH,
    token_type: 'bearer',
    expires_in: 3600,
    scope: SCOPE,
    ...patch,
  };
}

function response(body: unknown = providerBody(), status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ready(accessToken = ACCESS) {
  return { kind: 'ready', accessToken, linkRevision: REVISION, candidateId: CANDIDATE };
}

function assertSafe(value: unknown): void {
  const serialized = String(JSON.stringify(value));
  for (const secret of [
    PRIVATE, ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH, PERSISTED_ACCESS,
    KEY, CREDENTIALS.clientId, CREDENTIALS.clientSecret,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function genericFailure(operation: () => unknown): Promise<Error> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message.trim().length).toBeGreaterThan(0);
  expect(error.cause).toBeUndefined();
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
  assertSafe({ message: error.message, stack: error.stack });
  return error;
}

function harness(initial: ActiveSnapshot | null = snapshot()) {
  let current = initial;
  let control: Control = 'idle';
  let saved: ActiveSnapshot | undefined;
  let claimSequence = 0;
  let clock = NOW;
  const events: string[] = [];

  const read = jest.fn<ReturnType<ActiveTokenStore['read']>, Parameters<ActiveTokenStore['read']>>()
    .mockImplementation(async () => {
      events.push('read');
      return current === null ? null : { ...current };
    });
  const claimRefresh = jest.fn<ReturnType<ActiveTokenStore['claimRefresh']>, Parameters<ActiveTokenStore['claimRefresh']>>()
    .mockImplementation(async () => {
      events.push('claim');
      if (control === 'blocked') return 'blocked';
      if (control === 'inflight') return 'busy';
      control = 'inflight';
      return 'claimed';
    });
  const commit = (expected: ActiveSnapshot, tokens: TokenResult): void => {
    current = {
      ...expected,
      encryptedAccessToken: encrypt(tokens.accessToken, KEY, {
        uid: UID, purpose: 'accessToken',
      }),
      encryptedRefreshToken: encrypt(tokens.refreshToken, KEY, {
        uid: UID, purpose: 'refreshToken',
      }),
      scope: tokens.scope,
      expiresAt: Timestamp.fromMillis(clock + tokens.expiresIn * 1000),
    };
    saved = current;
    control = 'saved';
  };
  const saveRefresh = jest.fn<ReturnType<ActiveTokenStore['saveRefresh']>, Parameters<ActiveTokenStore['saveRefresh']>>()
    .mockImplementation(async (_uid, expected, _claimId, tokens) => {
      events.push('save');
      if (control === 'saved') return 'already-saved';
      commit(expected, tokens);
      return 'saved';
    });
  const blockRefresh = jest.fn<ReturnType<ActiveTokenStore['blockRefresh']>, Parameters<ActiveTokenStore['blockRefresh']>>()
    .mockImplementation(async () => {
      events.push('block');
      control = 'blocked';
    });
  const releaseRefresh = jest.fn<ReturnType<ActiveTokenStore['releaseRefresh']>, Parameters<ActiveTokenStore['releaseRefresh']>>()
    .mockImplementation(async () => {
      events.push('release');
      control = 'released';
    });
  const fetch = jest.fn<ReturnType<TokenFetch>, Parameters<TokenFetch>>()
    .mockImplementation(async () => {
      events.push('http');
      return response();
    });
  const now = jest.fn<number, []>().mockImplementation(() => clock);
  const newClaimId = jest.fn<string, []>()
    .mockImplementation(() => `claim_${++claimSequence}`);
  const store: ActiveTokenStore = {
    read, claimRefresh, saveRefresh, blockRefresh, releaseRefresh,
  };
  const dependencies: Dependencies = {
    store, fetch, credentials: CREDENTIALS, encryptionKey: KEY, now, newClaimId,
  };
  return {
    read, claimRefresh, saveRefresh, blockRefresh, releaseRefresh,
    fetch, now, newClaimId, dependencies, events, commit,
    provider: (patch: Partial<Dependencies> = {}) =>
      createPostingTokenProvider({ ...dependencies, ...patch }),
    current: () => current,
    receipt: () => saved,
    replace: (value: ActiveSnapshot | null) => { current = value; },
    setControl: (value: Control) => { control = value; },
    setTime: (value: number) => { clock = value; },
  };
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

describe('postingToken: cached credentials and generation guards', () => {
  it('claims even a valid cache, releases without HTTP, then reads before ready', async () => {
    const h = harness();
    const initial = h.current();
    await expect(h.provider().acquire(UID, REVISION)).resolves.toStrictEqual(ready());
    expect(h.claimRefresh).toHaveBeenCalledWith(UID, initial, 'claim_1', 30_000);
    expect(h.releaseRefresh).toHaveBeenCalledWith(UID, initial, 'claim_1');
    expect(h.events).toEqual(['read', 'claim', 'release', 'read']);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
    expect(h.blockRefresh).not.toHaveBeenCalled();
  });

  it.each(['busy', 'blocked'] as const)('honors %s before using valid cached access', async (state) => {
    const h = harness();
    h.setControl(state === 'busy' ? 'inflight' : 'blocked');
    const result = await h.provider().acquire(UID, REVISION);
    expect(result).toStrictEqual(state === 'busy'
      ? { kind: 'busy' }
      : { kind: 'relink_required', reason: 'blocked' });
    assertSafe(result);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
    expect(h.blockRefresh).not.toHaveBeenCalled();
  });

  it('reports initially unlinked without claiming or requesting', async () => {
    const h = harness(null);
    await expect(h.provider().acquire(UID, REVISION)).resolves.toStrictEqual({
      kind: 'relink_required', reason: 'unlinked',
    });
    expect(h.claimRefresh).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unexpected initial root revision before claiming', async () => {
    const h = harness(snapshot({ linkRevision: REVISION + 1 }));
    await expect(h.provider().acquire(UID, REVISION)).resolves.toStrictEqual({ kind: 'link_changed' });
    expect(h.claimRefresh).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(['revision', 'candidate', 'unlinked'] as const)('detects %s change during cached release', async (change) => {
    const h = harness();
    h.releaseRefresh.mockImplementationOnce(async () => {
      h.replace(change === 'unlinked' ? null : snapshot(change === 'revision'
        ? { linkRevision: REVISION + 1 }
        : { candidateId: 'replacement_candidate', xUserId: '67890' }));
    });
    await expect(h.provider().acquire(UID, REVISION)).resolves.toStrictEqual({ kind: 'link_changed' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('detects a generation change when claim CAS throws, with no HTTP', async () => {
    const h = harness();
    h.claimRefresh.mockImplementationOnce(async () => {
      h.replace(snapshot({ linkRevision: REVISION + 1, candidateId: 'new_candidate' }));
      throw new Error(PRIVATE);
    });
    await expect(h.provider().acquire(UID, REVISION)).resolves.toStrictEqual({ kind: 'link_changed' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
  });
});

describe('postingToken: single refresh and authoritative persisted credentials', () => {
  it.each([
    { offset: 1, force: false, http: false },
    { offset: 0, force: false, http: true },
    { offset: -1, force: false, http: true },
    { offset: 60_000, force: true, http: true },
  ])('uses strict expiry offset=$offset force=$force', async ({ offset, force, http }) => {
    const h = harness(snapshot({ expiresAt: Timestamp.fromMillis(NOW + offset) }));
    await expect(h.provider().acquire(UID, REVISION, force)).resolves.toStrictEqual(
      ready(http ? NEW_ACCESS : ACCESS),
    );
    expect(h.fetch).toHaveBeenCalledTimes(http ? 1 : 0);
    expect(h.saveRefresh).toHaveBeenCalledTimes(http ? 1 : 0);
    expect(h.releaseRefresh).toHaveBeenCalledTimes(http ? 0 : 1);
    expect(h.claimRefresh).toHaveBeenCalledTimes(1);
  });

  it('decrypts refresh AAD and connects the existing refresh grant exactly once', async () => {
    const h = harness();
    const initial = h.current();
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(ready(NEW_ACCESS));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = h.fetch.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    expect(request.body.toString()).toBe(new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: REFRESH,
    }).toString());
    expect(h.saveRefresh).toHaveBeenCalledWith(UID, initial, 'claim_1', {
      accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH,
      tokenType: 'Bearer', expiresIn: 3600, scope: SCOPE,
    });
    expect(h.events).toEqual(['read', 'claim', 'http', 'save', 'read']);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(h.blockRefresh).not.toHaveBeenCalled();
    const persisted = h.current() as ActiveSnapshot;
    expect(decrypt(persisted.encryptedRefreshToken, KEY, {
      uid: UID, purpose: 'refreshToken',
    })).toBe(NEW_REFRESH);
  });

  it('preserves omitted refresh token and the actual previously granted scope', async () => {
    const priorScope = SCOPE + ' follows.read';
    const h = harness(snapshot({ scope: priorScope }));
    h.fetch.mockResolvedValueOnce(response({
      access_token: NEW_ACCESS, token_type: 'bearer', expires_in: 3600,
    }));
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(ready(NEW_ACCESS));
    expect(h.saveRefresh.mock.calls[0][3]).toStrictEqual({
      accessToken: NEW_ACCESS, refreshToken: REFRESH,
      tokenType: 'Bearer', expiresIn: 3600, scope: priorScope,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['saved', 'already-saved'] as const)('uses reloaded current access after %s, never receipt input', async (status) => {
    const h = harness();
    h.saveRefresh.mockImplementationOnce(async (_uid, expected, _claimId, tokens) => {
      h.commit(expected, { ...tokens, accessToken: PERSISTED_ACCESS });
      return status;
    });
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(ready(PERSISTED_ACCESS));
    expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.blockRefresh).not.toHaveBeenCalled();
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it('recovers throw-after-commit using persisted data and at most one identical DB replay', async () => {
    const h = harness();
    let committed: ActiveSnapshot | undefined;
    h.saveRefresh.mockImplementationOnce(async (_uid, expected, _claimId, tokens) => {
      h.commit(expected, { ...tokens, accessToken: PERSISTED_ACCESS });
      committed = h.receipt();
      throw new Error(PRIVATE);
    });
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(ready(PERSISTED_ACCESS));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.saveRefresh.mock.calls.length).toBeLessThanOrEqual(2);
    if (h.saveRefresh.mock.calls.length === 2) {
      expect(h.saveRefresh.mock.calls[1]).toEqual(h.saveRefresh.mock.calls[0]);
    }
    expect(h.current()).toBe(committed);
    expect(h.receipt()).toBe(committed);
    expect(h.blockRefresh).not.toHaveBeenCalled();
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it('returns unknown after repeated DB save failure without another HTTP attempt', async () => {
    const h = harness();
    h.saveRefresh.mockRejectedValue(new Error(PRIVATE));
    const result = await h.provider().acquire(UID, REVISION, true);
    expect(result).toStrictEqual(UNKNOWN);
    assertSafe(result);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.saveRefresh.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.saveRefresh.mock.calls.length).toBeLessThanOrEqual(2);
    if (h.saveRefresh.mock.calls.length === 2) {
      expect(h.saveRefresh.mock.calls[1]).toEqual(h.saveRefresh.mock.calls[0]);
    }
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it('does not overwrite a committed receipt when all subsequent reads fail', async () => {
    const h = harness();
    h.read.mockImplementation(async () => {
      if (h.receipt() !== undefined) throw new Error(PRIVATE);
      return h.current();
    });
    const result = await h.provider().acquire(UID, REVISION, true);
    expect(result).toStrictEqual(UNKNOWN);
    assertSafe(result);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.saveRefresh).toHaveBeenCalledTimes(1);
    expect(h.current()).toBe(h.receipt());
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it.each(['revision', 'candidate', 'unlinked'] as const)('never returns access after %s changes during save', async (change) => {
    const h = harness();
    h.saveRefresh.mockImplementationOnce(async () => {
      h.replace(change === 'unlinked' ? null : snapshot(change === 'revision'
        ? { linkRevision: REVISION + 1, candidateId: 'new_candidate' }
        : { candidateId: 'new_candidate', xUserId: '67890' }));
      throw new Error(PRIVATE);
    });
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual({ kind: 'link_changed' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it('detects a new link between acknowledged save and final read', async () => {
    const h = harness();
    h.saveRefresh.mockImplementationOnce(async () => {
      h.replace(snapshot({ linkRevision: REVISION + 1, candidateId: 'new_candidate' }));
      return 'saved';
    });
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual({ kind: 'link_changed' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1])('never returns persisted access expired by offset %s', async (offset) => {
    const h = harness();
    h.saveRefresh.mockImplementationOnce(async (_uid, expected, _claimId, tokens) => {
      h.commit(expected, tokens);
      h.setTime(NOW + tokens.expiresIn * 1000 - offset);
      return 'saved';
    });
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(UNKNOWN);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not refresh again if cached access expires while the claim is released', async () => {
    const h = harness(snapshot({ expiresAt: Timestamp.fromMillis(NOW + 1) }));
    h.releaseRefresh.mockImplementationOnce(async () => { h.setTime(NOW + 1); });
    const result = await h.provider().acquire(UID, REVISION);
    expect(result).toStrictEqual(UNKNOWN);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.claimRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('postingToken: conservative outcomes, blocking and definite refusal', () => {
  it.each([
    { name: 'network rejection', body: null, status: 0 },
    { name: 'malformed success', body: { access_token: PRIVATE }, status: 200 },
    { name: 'neutral 400', body: { error: PRIVATE }, status: 400 },
    { name: 'neutral 401', body: { error: PRIVATE }, status: 401 },
    { name: 'neutral 500', body: { message: PRIVATE }, status: 500 },
    { name: 'neutral 503', body: { message: PRIVATE }, status: 503 },
  ])('blocks $name and never repeats refresh for the same generation', async ({ body, status }) => {
    const h = harness();
    const initial = h.current();
    if (status === 0) h.fetch.mockRejectedValueOnce(new Error(PRIVATE));
    else h.fetch.mockResolvedValueOnce(response(body, status));
    const provider = h.provider();
    const result = await provider.acquire(UID, REVISION, true);
    expect(result).toStrictEqual(UNKNOWN);
    assertSafe(result);
    expect(h.blockRefresh).toHaveBeenCalledWith(UID, initial, 'claim_1');
    expect(h.blockRefresh).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
    await expect(provider.acquire(UID, REVISION)).resolves.toStrictEqual({
      kind: 'relink_required', reason: 'blocked',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('blocks a thrown transport exception instead of retrying HTTP', async () => {
    const h = harness();
    jest.spyOn(transport, 'requestTokenOutcome').mockRejectedValueOnce(new Error(PRIVATE));
    await expect(h.provider().acquire(UID, REVISION, true)).resolves.toStrictEqual(UNKNOWN);
    expect(transport.requestTokenOutcome).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.blockRefresh).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
  });

  it('blocks transport timeout with no hidden retry timer', async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(() => new Promise<Awaited<ReturnType<TokenFetch>>>(() => undefined));
    const pending = h.provider().acquire(UID, REVISION, true);
    await jest.advanceTimersByTimeAsync(transport.TOKEN_TIMEOUT_MS);
    await expect(pending).resolves.toStrictEqual(UNKNOWN);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.blockRefresh).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('blocks invalid_grant and returns only the fixed relink reason', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ error: 'invalid_grant', error_description: PRIVATE }, 400));
    const result = await h.provider().acquire(UID, REVISION, true);
    expect(result).toStrictEqual({ kind: 'relink_required', reason: 'invalid_grant' });
    assertSafe(result);
    expect(h.blockRefresh).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  const refusals: { status: number; error: TokenOAuthError }[] = [
    { status: 401, error: 'invalid_client' },
    { status: 400, error: 'unauthorized_client' },
    { status: 400, error: 'invalid_request' },
    { status: 400, error: 'unsupported_grant_type' },
    { status: 400, error: 'invalid_scope' },
    { status: 403, error: 'access_denied' },
    { status: 500, error: 'server_error' },
    { status: 503, error: 'temporarily_unavailable' },
  ];

  it.each(refusals)('releases explicit OAuth refusal $error/$status without retry', async ({ status, error }) => {
    const h = harness();
    const initial = h.current();
    h.fetch.mockResolvedValueOnce(response({ error, error_description: PRIVATE }, status));
    const result = await h.provider().acquire(UID, REVISION, true);
    expect(result).toStrictEqual({ kind: 'rejected', status, oauthError: error });
    assertSafe(result);
    expect(h.releaseRefresh).toHaveBeenCalledWith(UID, initial, 'claim_1');
    expect(h.releaseRefresh).toHaveBeenCalledTimes(1);
    expect(h.blockRefresh).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('releases neutral HTTP 429 with no provider text or retry metadata', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ message: PRIVATE, retry_after: 300 }, 429));
    const result = await h.provider().acquire(UID, REVISION, true);
    expect(result).toStrictEqual({ kind: 'rejected', status: 429 });
    assertSafe(result);
    expect(h.releaseRefresh).toHaveBeenCalledTimes(1);
    expect(h.blockRefresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed block cannot expose access, raw errors or authorize more HTTP', async () => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error(PRIVATE));
    h.blockRefresh.mockRejectedValueOnce(new Error(PRIVATE));
    // The contract permits a sanitized generic exception or unknown_refresh.
    let result: unknown;
    try {
      result = await h.provider().acquire(UID, REVISION, true);
    } catch (error) {
      const safe = await genericFailure(() => { throw error; });
      result = { message: safe.message };
    }
    if (!(result !== null && typeof result === 'object' && 'message' in result)) {
      expect(result).toStrictEqual(UNKNOWN);
    }
    assertSafe(result);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.blockRefresh).toHaveBeenCalledTimes(1);
    expect(h.releaseRefresh).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
  });
});

describe('postingToken: safe local failures and invalid input', () => {
  it('uses one fixed generic exception without cause for initial store, crypto and clock failures', async () => {
    const store = harness();
    store.read.mockRejectedValueOnce(new Error(PRIVATE));
    const crypto = harness(snapshot({
      encryptedAccessToken: encrypt(PRIVATE, KEY, { uid: 'other_uid', purpose: 'accessToken' }),
    }));
    const clock = harness();
    clock.now.mockImplementation(() => { throw new Error(PRIVATE); });
    const errors = [
      await genericFailure(() => store.provider().acquire(UID, REVISION)),
      await genericFailure(() => crypto.provider().acquire(UID, REVISION)),
      await genericFailure(() => clock.provider().acquire(UID, REVISION)),
    ];
    expect(new Set(errors.map((error) => error.message)).size).toBe(1);
    for (const h of [store, crypto, clock]) expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects refresh ciphertext bound to the wrong purpose without HTTP', async () => {
    const h = harness(snapshot({
      encryptedRefreshToken: encrypt(PRIVATE, KEY, { uid: UID, purpose: 'accessToken' }),
    }));
    await genericFailure(() => h.provider().acquire(UID, REVISION, true));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saveRefresh).not.toHaveBeenCalled();
  });

  it('sanitizes cached release failure and never returns cached access', async () => {
    const h = harness();
    h.releaseRefresh.mockRejectedValueOnce(new Error(PRIVATE));
    await genericFailure(() => h.provider().acquire(UID, REVISION));
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '../other', '__reserved__', '\ud800', 'a'.repeat(129)])('rejects unsafe UID %j without HTTP', async (uid) => {
    const h = harness();
    await genericFailure(() => h.provider().acquire(uid, REVISION));
    expect(h.claimRefresh).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe revision %s without HTTP', async (revision) => {
    const h = harness();
    await genericFailure(() => h.provider().acquire(UID, revision));
    expect(h.claimRefresh).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity])('rejects invalid clock %s without HTTP', async (time) => {
    const h = harness();
    h.setTime(time);
    await genericFailure(() => h.provider().acquire(UID, REVISION, true));
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(['', '../claim', '__reserved__'])('rejects unsafe generated claim %j without HTTP', async (claimId) => {
    const h = harness();
    h.newClaimId.mockReturnValueOnce(claimId);
    await genericFailure(() => h.provider().acquire(UID, REVISION, true));
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
