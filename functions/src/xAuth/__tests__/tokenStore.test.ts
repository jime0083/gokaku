import { randomBytes } from 'node:crypto';
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';

import { decrypt } from '../crypto';
import { createTokenStore, type StageTokenInput } from '../tokenStore';

type Data = Record<string, unknown>;

const UID = 'token-store-unit';
const USER = `users/${UID}`;
const TOKEN = `xTokens/${UID}`;
const NOW = Date.UTC(2026, 9, 20);
const KEY = randomBytes(32).toString('base64');
const FAILURE = 'X auth token storage failed';

function input(): StageTokenInput {
  return {
    uid: UID,
    candidateId: 'candidate_1-safe',
    tokens: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      tokenType: 'Bearer',
      expiresIn: 60,
      scope: 'tweet.read tweet.write users.read offline.access',
    },
  };
}

function copy<T>(value: T): T {
  if (value instanceof Timestamp) return value;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copy(item)]),
    ) as T;
  }
  return value;
}

/** Isolated transaction fake: version conflicts, staged writes and rollback. */
function fixture(key = KEY) {
  const rows = new Map<string, Data>();
  const versions = new Map<string, number>();
  const reads: string[] = [];
  const committed: string[] = [];
  let hook: (() => void) | undefined;
  let rejectCommit = false;
  let attempts = 0;
  let time = NOW;

  function seed(path: string, data?: Data): void {
    if (data === undefined) rows.delete(path);
    else rows.set(path, copy(data));
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }

  const db = {
    doc: jest.fn((path: string) => ({ path })),
    runTransaction: jest.fn(async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        attempts += 1;
        const observed = new Map<string, number>();
        const pending: { path: string; data: Data; create: boolean }[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            if (pending.length > 0) throw new Error('read after write');
            reads.push(ref.path);
            observed.set(ref.path, versions.get(ref.path) ?? 0);
            const data = copy(rows.get(ref.path));
            return {
              exists: data !== undefined,
              data: () => copy(data),
              get: (field: string) => copy(data?.[field]),
            };
          },
          create: (ref: { path: string }, data: Data) => {
            pending.push({ path: ref.path, data: copy(data), create: true });
            return tx;
          },
          update: (ref: { path: string }, data: Data) => {
            pending.push({ path: ref.path, data: copy(data), create: false });
            return tx;
          },
        };
        const result = await callback(tx as unknown as Transaction);
        const beforeCommit = hook;
        hook = undefined;
        beforeCommit?.();
        if ([...observed].some(
          ([path, version]) => (versions.get(path) ?? 0) !== version,
        )) continue;
        if (rejectCommit) throw new Error('private provider/backend detail');
        for (const write of pending) {
          if (rows.has(write.path) === write.create) {
            throw new Error('precondition failed');
          }
        }
        for (const write of pending) {
          seed(
            write.path,
            write.create ? write.data : { ...rows.get(write.path), ...write.data },
          );
          committed.push(write.path);
        }
        return result;
      }
      throw new Error('conflict exhausted');
    }),
  };
  seed(USER, { xLinked: false, xPostEnabled: false });
  const now = jest.fn(() => time);
  const store = createTokenStore({
    firestore: db as unknown as Firestore,
    now,
    encryptionKey: key,
  });
  return {
    db, store, now, seed, reads, committed,
    read: (path = TOKEN) => copy(rows.get(path)),
    clock: (value: number) => { time = value; },
    conflict: (value: () => void) => { hook = value; },
    failCommit: () => { rejectCommit = true; },
    get attempts() { return attempts; },
  };
}

async function failure(operation: Promise<unknown>): Promise<void> {
  const error: unknown = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(FAILURE);
  expect((error as Error).cause).toBeUndefined();
  expect(Object.keys(error as Error)).toEqual([]);
}

describe('tokenStore.stage', () => {
  it('creates only encrypted pending credentials and exact provider metadata', async () => {
    const f = fixture();
    const original = input();
    const value = {
      ...original,
      tokens: { ...original.tokens, scope: `${original.tokens.scope} extra.scope` },
    };
    await expect(f.store.stage(value)).resolves.toBeUndefined();
    const pending = f.read()!.pendingLink as Data;
    expect(Object.keys(f.read()!)).toEqual(['pendingLink']);
    expect(Object.keys(pending).sort()).toEqual([
      'candidateId', 'encryptedAccessToken', 'encryptedRefreshToken',
      'expiresAt', 'scope',
    ]);
    expect(pending).toMatchObject({
      candidateId: value.candidateId,
      expiresAt: Timestamp.fromMillis(NOW + 60000),
      scope: value.tokens.scope,
    });
    const access = pending.encryptedAccessToken as string;
    const refresh = pending.encryptedRefreshToken as string;
    expect(decrypt(access, KEY, { uid: UID, purpose: 'accessToken' }))
      .toBe(value.tokens.accessToken);
    expect(decrypt(refresh, KEY, { uid: UID, purpose: 'refreshToken' }))
      .toBe(value.tokens.refreshToken);
    expect(() => decrypt(access, KEY, {
      uid: 'other-user', purpose: 'accessToken',
    })).toThrow();
    expect(() => decrypt(access, KEY, {
      uid: UID, purpose: 'refreshToken',
    })).toThrow();
    expect(() => decrypt(refresh, KEY, {
      uid: UID, purpose: 'accessToken',
    })).toThrow();
    expect(JSON.stringify(f.read())).not.toContain(value.tokens.accessToken);
    expect(JSON.stringify(f.read())).not.toContain(value.tokens.refreshToken);
    expect(f.read(USER)).toEqual({ xLinked: false, xPostEnabled: false });
    expect(f.reads).toEqual([USER, TOKEN]);
    expect(f.committed).toEqual([TOKEN]);
  });

  it('preserves active credentials, states and user flags; replaces the pending map', async () => {
    const f = fixture();
    const original = {
      encryptedAccessToken: 'active-access-envelope',
      encryptedRefreshToken: 'active-refresh-envelope',
      expiresAt: Timestamp.fromMillis(NOW + 1000),
      scope: 'active-scope',
      oauthStates: { other: { encryptedVerifier: 'existing-envelope' } },
    };
    f.seed(USER, { xLinked: true, xPostEnabled: true });
    f.seed(TOKEN, { ...original, pendingLink: { obsolete: true } });
    await f.store.stage(input());
    expect(f.read()).toEqual({
      ...original,
      pendingLink: expect.objectContaining({ candidateId: 'candidate_1-safe' }),
    });
    expect(f.read()!.pendingLink).not.toHaveProperty('obsolete');
    expect(f.read(USER)).toEqual({ xLinked: true, xPostEnabled: true });
    expect(f.committed).toEqual([TOKEN]);
  });

  it.each(['missing', 'deleting'])('blocks a %s account before writes', async (state) => {
    const f = fixture();
    f.seed(USER, state === 'missing' ? undefined : { deletionInProgress: true });
    await failure(f.store.stage(input()));
    expect(f.reads).toEqual([USER]);
    expect(f.committed).toEqual([]);
    expect(f.read()).toBeUndefined();
  });

  it('rechecks the account on retry and never commits after deletion starts', async () => {
    const f = fixture();
    f.conflict(() => f.seed(USER, { deletionInProgress: true }));
    await failure(f.store.stage(input()));
    expect(f.attempts).toBe(2);
    expect(f.reads.filter((path) => path === USER)).toHaveLength(2);
    expect(f.committed).toEqual([]);
    expect(f.read()).toBeUndefined();
  });

  it('does not extend provider expiry when a retry uses a later clock', async () => {
    const f = fixture();
    f.conflict(() => {
      f.clock(NOW + 10000);
      f.seed(TOKEN, { oauthStates: { concurrent: true } });
    });
    await f.store.stage(input());
    expect(f.attempts).toBe(2);
    expect(f.now).toHaveBeenCalledTimes(3);
    expect(f.read()).toMatchObject({
      oauthStates: { concurrent: true },
      pendingLink: { expiresAt: Timestamp.fromMillis(NOW + 60000) },
    });
    expect(f.committed).toEqual([TOKEN]);
  });

  it('rejects expiry reached during retry without committing', async () => {
    const f = fixture();
    f.conflict(() => {
      f.clock(NOW + 60000);
      f.seed(USER, { xLinked: false, xPostEnabled: false });
    });
    await failure(f.store.stage(input()));
    expect(f.attempts).toBe(2);
    expect(f.committed).toEqual([]);
    expect(f.read()).toBeUndefined();
  });

  it.each(['', '.', '..', 'a/b', '__reserved__', 'a'.repeat(129), '\ud800'])(
    'rejects unsafe uid %p before resolving document paths',
    async (uid) => {
      const f = fixture();
      await failure(f.store.stage({ ...input(), uid }));
      expect(f.db.doc).not.toHaveBeenCalled();
      expect(f.committed).toEqual([]);
    },
  );

  it.each(['', ' ', '../candidate', 'a.b', 'a/b', '\n', 'a'.repeat(1501)])(
    'rejects unsafe candidate id %p',
    async (candidateId) => {
      const f = fixture();
      await failure(f.store.stage({ ...input(), candidateId }));
      expect(f.db.runTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { accessToken: '' }, { accessToken: ' ' }, { accessToken: '\ud800' },
    { refreshToken: '' }, { refreshToken: ' ' }, { refreshToken: '\ud800' },
    { tokenType: 'bearer' }, { tokenType: 'Basic' },
    { scope: '' },
    { scope: 'tweet.read tweet.write users.read' },
    { scope: 'tweet.read tweet.write users.read offline.access.extra' },
    { scope: 'tweet.read  tweet.write users.read offline.access' },
    { scope: 'tweet.read tweet.write users.read offline.access\n' },
    { expiresIn: 0 }, { expiresIn: -1 }, { expiresIn: 0.5 },
    { expiresIn: NaN }, { expiresIn: Infinity },
    { expiresIn: Number.MAX_SAFE_INTEGER },
    { expiresIn: null },
  ])('rejects invalid provider result %p', async (patch) => {
    const f = fixture();
    const value = input();
    await failure(f.store.stage({
      ...value,
      tokens: { ...value.tokens, ...patch } as unknown as StageTokenInput['tokens'],
    }));
    expect(f.db.runTransaction).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
  });

  it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER, -62135596800001])(
    'rejects invalid or out-of-Firestore-range clock %p',
    async (time) => {
      const f = fixture();
      f.clock(time);
      await failure(f.store.stage(input()));
      expect(f.committed).toEqual([]);
    },
  );

  it('accepts Firestore upper bound and rejects expiry beyond it', async () => {
    const f = fixture();
    f.clock(253402300799999 - 60000);
    await f.store.stage(input());
    expect((f.read()!.pendingLink as Data).expiresAt)
      .toEqual(Timestamp.fromMillis(253402300799999));
    const beyond = fixture();
    beyond.clock(253402300799999 - 60000 + 1);
    await failure(beyond.store.stage(input()));
    expect(beyond.committed).toEqual([]);
  });

  it('sanitizes encryption failure before any transaction', async () => {
    const f = fixture('invalid-key');
    await failure(f.store.stage(input()));
    expect(f.db.runTransaction).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
  });

  it('sanitizes commit failure and leaves existing data untouched', async () => {
    const f = fixture();
    const original = { oauthStates: { retained: true }, active: 'unchanged' };
    f.seed(TOKEN, original);
    f.failCommit();
    await failure(f.store.stage(input()));
    expect(f.read()).toEqual(original);
    expect(f.read(USER)).toEqual({ xLinked: false, xPostEnabled: false });
    expect(f.committed).toEqual([]);
  });
});
