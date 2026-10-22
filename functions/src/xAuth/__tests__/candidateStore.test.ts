import { randomBytes } from 'node:crypto';
import {
  FieldValue, Timestamp, type Firestore, type Transaction,
} from 'firebase-admin/firestore';

import { createCandidateStore, type CandidateProfile } from '../candidateStore';
import { encrypt } from '../crypto';

type Data = Record<string, unknown>;
const UID = 'candidate-unit';
const USER = 'users/' + UID;
const TOKEN = 'xTokens/' + UID;
const ID = 'candidate_1';
const NOW = Date.UTC(2026, 9, 20);
const KEY = randomBytes(32).toString('base64');
const FAILURE = 'X auth candidate operation failed';
const PROFILE: CandidateProfile = {
  id: '123456', username: 'fixture_user',
  profileImageUrl: 'https://pbs.twimg.com/profile_images/fixture.jpg',
};

function copy<T>(value: T): T {
  if (value instanceof Timestamp || value instanceof FieldValue) return value;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copy(item)]),
    ) as T;
  }
  return value;
}

function pending(overrides: Data = {}): Data {
  return {
    candidateId: ID,
    encryptedAccessToken: encrypt('fixture-access', KEY, { uid: UID, purpose: 'accessToken' }),
    encryptedRefreshToken: encrypt('fixture-refresh', KEY, { uid: UID, purpose: 'refreshToken' }),
    expiresAt: Timestamp.fromMillis(NOW + 60000),
    scope: 'tweet.read tweet.write users.read offline.access extra.scope',
    ...overrides,
  };
}

/** Snapshot isolation, staged atomic writes, preconditions and version retries. */
function fixture(key = KEY) {
  const rows = new Map<string, Data>();
  const versions = new Map<string, number>();
  const committed: string[] = [];
  let hook: (() => void) | undefined;
  let rejectCommit = false;
  let attempts = 0;
  let time = NOW;
  const deletion = FieldValue.delete();

  function seed(path: string, data?: Data): void {
    if (data === undefined) rows.delete(path);
    else rows.set(path, copy(data));
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }
  function read(path = TOKEN): Data | undefined { return copy(rows.get(path)); }

  const db = {
    doc: jest.fn((path: string) => ({ path })),
    runTransaction: jest.fn(async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        attempts += 1;
        const observed = new Map<string, number>();
        const snapshot = new Map([...rows].map(([path, data]) => [path, copy(data)]));
        const snapshotVersions = new Map(versions);
        const writes: { path: string; data: Data; create?: boolean }[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            if (writes.length) throw new Error('read after write');
            observed.set(ref.path, snapshotVersions.get(ref.path) ?? 0);
            const data = snapshot.get(ref.path);
            return {
              exists: data !== undefined,
              data: () => copy(data),
              get: (field: string) => copy(data?.[field]),
            };
          },
          update: (ref: { path: string }, data: Data) => {
            writes.push({ path: ref.path, data: copy(data) });
            return tx;
          },
          create: (ref: { path: string }, data: Data) => {
            writes.push({ path: ref.path, data: copy(data), create: true });
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
        if (rejectCommit) throw new Error('private backend detail');
        // Validate all preconditions before applying ANY write.
        for (const write of writes) {
          if (write.create) {
            if (rows.has(write.path)) throw new Error('occupied create target');
          } else if (!rows.has(write.path)) {
            throw new Error('missing update target');
          }
        }
        const staged = new Map<string, Data>();
        for (const write of writes) {
          const next = { ...(staged.get(write.path) ?? read(write.path)) };
          for (const [field, value] of Object.entries(write.data)) {
            if (value instanceof FieldValue && value.isEqual(deletion)) delete next[field];
            else if (field.startsWith('judgementRevisions.')) {
              const stream = field.slice('judgementRevisions.'.length);
              next.judgementRevisions = {
                ...(next.judgementRevisions as Data), [stream]: copy(value),
              };
            } else next[field] = copy(value);
          }
          staged.set(write.path, next);
        }
        for (const [path, data] of staged) {
          seed(path, data);
          committed.push(path);
        }
        return result;
      }
      throw new Error('conflict exhausted');
    }),
  };

  seed(USER, {
    xLinked: false, xPostEnabled: false, xUsername: 'old_user',
    subscriptionActive: true, deletionInProgress: false, unrelated: { keep: true },
  });
  seed(TOKEN, {
    encryptedAccessToken: 'old-access', encryptedRefreshToken: 'old-refresh',
    expiresAt: Timestamp.fromMillis(NOW - 1), scope: 'old-scope', xUserId: 'old-id',
    oauthStates: { state: { untouched: true } }, unrelated: { keep: true },
    pendingLink: pending(),
  });
  const now = jest.fn(() => time);
  const store = createCandidateStore({
    firestore: db as unknown as Firestore, now, encryptionKey: key,
  });
  function patch(data: Data): void { seed(TOKEN, { ...read(), ...data }); }
  return {
    store, db, now, read, seed, patch, committed,
    clock: (value: number) => { time = value; },
    conflict: (value: () => void) => { hook = value; },
    failCommit: () => { rejectCommit = true; },
    get attempts() { return attempts; },
  };
}

type Fixture = ReturnType<typeof fixture>;
function access(f: Fixture): string {
  return (f.read()?.pendingLink as Data | undefined)?.encryptedAccessToken as string;
}
async function attach(f: Fixture): Promise<void> {
  await f.store.attachProfile(UID, ID, access(f), PROFILE);
}
async function failure(operation: Promise<unknown>): Promise<void> {
  const error: unknown = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(FAILURE);
  expect((error as Error).cause).toBeUndefined();
  expect(Object.keys(error as Error)).toEqual([]);
}

describe('candidateStore internal get and validation', () => {
  it('returns only server envelopes and canonical provider expiry without writes', async () => {
    const f = fixture();
    const stored = f.read()!.pendingLink as Data;
    const result = await f.store.get(UID);
    expect(result).toEqual(stored);
    expect(JSON.stringify(result)).not.toContain('fixture-access');
    expect(JSON.stringify(result)).not.toContain('fixture-refresh');
    expect(f.committed).toEqual([]);
    expect(f.now).toHaveBeenCalledTimes(1);
  });

  it.each(['missing-token', 'missing-pending', 'expired', 'boundary'])(
    'returns null for %s, preserving storage', async (state) => {
      const f = fixture();
      if (state === 'missing-token') f.seed(TOKEN);
      if (state === 'missing-pending') {
        const data = f.read()!;
        delete data.pendingLink;
        f.seed(TOKEN, data);
      }
      if (state === 'expired') f.clock(NOW + 60001);
      if (state === 'boundary') f.clock(NOW + 60000);
      const before = f.read();
      await expect(f.store.get(UID)).resolves.toBeNull();
      expect(f.read()).toEqual(before);
      expect(f.committed).toEqual([]);
    },
  );

  const badCandidates: [string, () => unknown][] = [
    ['null', () => null],
    ['array', () => []],
    ['identity', () => pending({ candidateId: '../bad' })],
    ['numeric expiry', () => pending({ expiresAt: NOW + 60000 })],
    ['date expiry', () => pending({ expiresAt: new Date(NOW + 60000) })],
    ['submillisecond expiry', () => pending({ expiresAt: new Timestamp(100, 1) })],
    ['missing scope', () => pending({ scope: 'tweet.read users.read offline.access' })],
    ['scope substring', () => pending({ scope: 'tweet.read tweet.write.extra users.read offline.access' })],
    ['scope formatting', () => pending({ scope: 'tweet.read  tweet.write users.read offline.access' })],
    ['access envelope', () => pending({ encryptedAccessToken: 'broken' })],
    ['refresh envelope', () => pending({ encryptedRefreshToken: 'broken' })],
    ['foreign UID', () => pending({
      encryptedAccessToken: encrypt('private', KEY, { uid: 'another', purpose: 'accessToken' }),
    })],
    ['wrong purpose', () => pending({
      encryptedAccessToken: encrypt('private', KEY, { uid: UID, purpose: 'refreshToken' }),
    })],
    ['foreign refresh UID', () => pending({
      encryptedRefreshToken: encrypt('private', KEY, { uid: 'another', purpose: 'refreshToken' }),
    })],
    ['blank plaintext', () => pending({
      encryptedAccessToken: encrypt(' ', KEY, { uid: UID, purpose: 'accessToken' }),
    })],
    ['profile shape', () => pending({ profile: null })],
  ];
  it.each(badCandidates)('rejects malformed %s without wiping', async (_name, make) => {
    const f = fixture();
    f.patch({ pendingLink: make() });
    const before = f.read();
    await failure(f.store.get(UID));
    await failure(f.store.attachProfile(UID, ID, access(f), PROFILE));
    await failure(f.store.confirm(UID, ID, true));
    expect(f.read()).toEqual(before);
    expect(f.committed).toEqual([]);
  });

  it('rejects a wrong injected encryption key', async () => {
    const f = fixture(randomBytes(32).toString('base64'));
    await failure(f.store.get(UID));
    await failure(attach(f));
    await failure(f.store.confirm(UID, ID, false));
    expect(f.committed).toEqual([]);
  });

  it.each([NaN, Infinity, NOW + 0.5, 253402300800000])(
    'rejects invalid injected time %s', async (time) => {
      const f = fixture();
      f.clock(time);
      await failure(f.store.get(UID));
      await failure(attach(f));
      await failure(f.store.confirm(UID, ID, false));
      expect(f.committed).toEqual([]);
    },
  );
});

describe('candidateStore attachProfile', () => {
  it('attaches only minimal trusted fields and preserves all other data', async () => {
    const f = fixture();
    const before = f.read()!;
    const user = f.read(USER);
    await f.store.attachProfile(UID, ID, access(f), { ...PROFILE, extra: 'drop' } as CandidateProfile);
    expect(f.read()).toEqual({
      ...before, pendingLink: { ...before.pendingLink as Data, profile: PROFILE },
    });
    expect(f.read(USER)).toEqual(user);
    expect((await f.store.get(UID))?.profile).toEqual(PROFILE);
  });

  it.each([true, false])('stores, resumes and confirms null image with permission %s', async (postEnabled) => {
    const f = fixture();
    const withoutImage: CandidateProfile = { ...PROFILE, profileImageUrl: null };
    const before = f.read()!;
    const user = f.read(USER)!;
    await f.store.attachProfile(UID, ID, access(f), withoutImage);
    expect(f.read()).toEqual({
      ...before, pendingLink: { ...before.pendingLink as Data, profile: withoutImage },
    });
    const resumed = await f.store.get(UID);
    expect(resumed?.profile).toEqual(withoutImage);
    expect(resumed?.profile?.profileImageUrl).toBeNull();
    await f.store.confirm(UID, ID, postEnabled);
    expect(f.read()!.xUserId).toBe(PROFILE.id);
    expect(f.read()!.pendingLink).toBeUndefined();
    expect(f.read()!.oauthStates).toEqual(before.oauthStates);
    expect(f.read()!.unrelated).toEqual(before.unrelated);
    const credentials = before.pendingLink as Data;
    for (const field of [
      'encryptedAccessToken', 'encryptedRefreshToken', 'expiresAt', 'scope',
    ]) expect(f.read()![field]).toEqual(credentials[field]);
    expect(f.read(USER)).toEqual({
      ...user, xLinked: true, xUsername: PROFILE.username, xPostEnabled: postEnabled,
    });
  });

  it('accepts the transport username boundary and case-insensitive HTTPS prefix', async () => {
    const f = fixture();
    const value: CandidateProfile = {
      ...PROFILE, username: 'x'.repeat(15),
      profileImageUrl: 'HTTPS://images.example.test/avatar.jpg?size=normal',
    };
    await f.store.attachProfile(UID, ID, access(f), value);
    expect((await f.store.get(UID))?.profile).toEqual(value);
  });

  it.each([
    null, [], {}, { ...PROFILE, id: 123 }, { ...PROFILE, id: 'x' },
    { ...PROFILE, username: '@user' }, { ...PROFILE, username: ' ' },
    { ...PROFILE, username: 'x'.repeat(16) },
    { ...PROFILE, profileImageUrl: undefined },
    { ...PROFILE, profileImageUrl: 42 },
    { ...PROFILE, profileImageUrl: 'javascript:alert(1)' },
    { ...PROFILE, profileImageUrl: 'data:image/png;base64,AA==' },
    { ...PROFILE, profileImageUrl: 'http://example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: '//example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https://user:pass@example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https://@example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a.jpg#fragment' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a.jpg#' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a\u0000b.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a\u007fb.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a\u0085b.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a\u009fb.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/a b.jpg' },
    { ...PROFILE, profileImageUrl: 'https://example.com/\ud800' },
    { ...PROFILE, profileImageUrl: 'https:example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https:///example.com/a.jpg#' },
    { ...PROFILE, profileImageUrl: 'https://' },
    { ...PROFILE, profileImageUrl: ' https://example.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https://exam\nple.com/a.jpg' },
    { ...PROFILE, profileImageUrl: 'https:\\example.com/a.jpg' },
  ])('rejects unsafe profile %# with no writes', async (value) => {
    const f = fixture();
    const before = f.read();
    await failure(f.store.attachProfile(UID, ID, access(f), value as CandidateProfile));
    expect(f.read()).toEqual(before);
    f.patch({ pendingLink: pending({ profile: value }) });
    const malformed = f.read();
    await failure(f.store.get(UID));
    await failure(f.store.confirm(UID, ID, false));
    expect(f.read()).toEqual(malformed);
    expect(f.committed).toEqual([]);
  });

  it.each(['id', 'access', 'expiry'])('rejects stale %s before attachment', async (change) => {
    const f = fixture();
    const expected = access(f);
    if (change === 'id') f.patch({ pendingLink: pending({ candidateId: 'replacement' }) });
    if (change === 'access') f.patch({ pendingLink: pending() });
    if (change === 'expiry') f.clock(NOW + 60000);
    const before = f.read();
    await failure(f.store.attachProfile(UID, ID, expected, PROFILE));
    expect(f.read()).toEqual(before);
    expect(f.committed).toEqual([]);
  });

  it('copies input before an await so later mutations cannot change stored profile', async () => {
    const f = fixture();
    const value = { ...PROFILE };
    const operation = f.store.attachProfile(UID, ID, access(f), value);
    value.id = '999';
    value.username = 'changed';
    await operation;
    expect((f.read()!.pendingLink as Data).profile).toEqual(PROFILE);
  });
});

describe('candidateStore atomic confirmation and receipts', () => {
  it.each([true, false])('confirms with postEnabled=%s atomically', async (postEnabled) => {
    const f = fixture();
    await attach(f);
    const before = f.read()!;
    const user = f.read(USER)!;
    const candidate = before.pendingLink as Data;
    f.committed.length = 0;
    await expect(f.store.confirm(UID, ID, postEnabled)).resolves.toBeUndefined();
    const expected: Data = {
      ...before,
      encryptedAccessToken: candidate.encryptedAccessToken,
      encryptedRefreshToken: candidate.encryptedRefreshToken,
      expiresAt: candidate.expiresAt, scope: candidate.scope, xUserId: PROFILE.id,
      confirmedLink: { candidateId: ID, postEnabled },
    };
    delete expected.pendingLink;
    expect(f.read()).toEqual(expected);
    expect(f.read(USER)).toEqual({
      ...user, xLinked: true, xUsername: PROFILE.username, xPostEnabled: postEnabled,
    });
    expect(f.committed.sort()).toEqual([TOKEN, USER].sort());
    await expect(f.store.get(UID)).resolves.toBeNull();
  });

  it.each([true, false])('receipt retry %s never rewrites later user flags or pending', async (enabled) => {
    const f = fixture();
    await attach(f);
    await f.store.confirm(UID, ID, enabled);
    f.seed(USER, { ...f.read(USER), xLinked: false, xPostEnabled: !enabled, xUsername: 'later' });
    f.patch({ pendingLink: pending({ candidateId: 'new_candidate' }) });
    f.clock(NOW + 60000);
    const token = f.read();
    const user = f.read(USER);
    f.committed.length = 0;
    await expect(f.store.confirm(UID, ID, enabled)).resolves.toBeUndefined();
    await failure(f.store.confirm(UID, ID, !enabled));
    await failure(f.store.confirm(UID, 'unknown_candidate', enabled));
    expect(f.read()).toEqual(token);
    expect(f.read(USER)).toEqual(user);
    expect(f.committed).toEqual([]);
  });

  it('can confirm a new pending candidate after a previous receipt', async () => {
    const f = fixture();
    f.patch({ confirmedLink: { candidateId: 'previous', postEnabled: true } });
    await attach(f);
    await f.store.confirm(UID, ID, false);
    expect(f.read()!.confirmedLink).toEqual({ candidateId: ID, postEnabled: false });
  });

  it.each(['missing-profile', 'expired', 'wrong-id', 'wrong-bool', 'malformed-receipt'])(
    'rejects %s without partial updates', async (state) => {
      const f = fixture();
      if (state !== 'missing-profile') await attach(f);
      if (state === 'expired') f.clock(NOW + 60000);
      if (state === 'malformed-receipt') f.patch({ confirmedLink: { candidateId: ID } });
      const token = f.read();
      const user = f.read(USER);
      f.committed.length = 0;
      await failure(f.store.confirm(
        UID, state === 'wrong-id' ? 'other' : ID,
        state === 'wrong-bool' ? 'false' as unknown as boolean : false,
      ));
      expect(f.read()).toEqual(token);
      expect(f.read(USER)).toEqual(user);
      expect(f.committed).toEqual([]);
    },
  );

  it('rolls back BOTH documents when commit fails and sanitizes backend errors', async () => {
    const f = fixture();
    await attach(f);
    const token = f.read();
    const user = f.read(USER);
    f.committed.length = 0;
    f.failCommit();
    await failure(f.store.confirm(UID, ID, true));
    expect(f.read()).toEqual(token);
    expect(f.read(USER)).toEqual(user);
    expect(f.committed).toEqual([]);
  });
});

describe('candidateStore discard and universal account/path guards', () => {
  it('discards only the matching pending map, including expired or damaged credentials', async () => {
    const f = fixture();
    f.patch({
      pendingLink: { candidateId: ID, encryptedAccessToken: 'damaged' },
      confirmedLink: { candidateId: 'previous', postEnabled: false },
    });
    const before = f.read()!;
    const user = f.read(USER);
    await f.store.discard(UID, ID);
    delete before.pendingLink;
    expect(f.read()).toEqual(before);
    expect(f.read(USER)).toEqual(user);
  });

  it('rejects a mismatched candidate without deleting anything', async () => {
    const f = fixture();
    const before = f.read();
    const user = f.read(USER);
    await failure(f.store.discard(UID, 'other'));
    expect(f.read()).toEqual(before);
    expect(f.read(USER)).toEqual(user);
    expect(f.committed).toEqual([]);
  });

  it('retries a successful discard without rewriting active credentials or user flags', async () => {
    const f = fixture();
    await f.store.discard(UID, ID);
    f.patch({
      encryptedAccessToken: 'later-active-access',
      encryptedRefreshToken: 'later-active-refresh',
      confirmedLink: { candidateId: 'later-confirmed', postEnabled: true },
    });
    f.seed(USER, {
      ...f.read(USER), xLinked: true, xUsername: 'later_user', xPostEnabled: true,
    });
    const token = f.read();
    const user = f.read(USER);
    f.committed.length = 0;
    await expect(f.store.discard(UID, ID)).resolves.toBeUndefined();
    expect(f.read()).toEqual(token);
    expect(f.read(USER)).toEqual(user);
    expect(f.committed).toEqual([]);
  });

  it.each(['missing-token', 'missing-pending'])(
    'discard is a no-op for %s under a writable parent', async (state) => {
      const f = fixture();
      if (state === 'missing-token') f.seed(TOKEN);
      else {
        const data = f.read()!;
        delete data.pendingLink;
        f.seed(TOKEN, data);
      }
      const token = f.read();
      const user = f.read(USER);
      await expect(f.store.discard(UID, ID)).resolves.toBeUndefined();
      await expect(f.store.discard(UID, ID)).resolves.toBeUndefined();
      expect(f.read()).toEqual(token);
      expect(f.read(USER)).toEqual(user);
      expect(f.committed).toEqual([]);
    },
  );

  it.each([null, [], {}, { candidateId: null }, { candidateId: '../bad' }])(
    'discard fails closed for malformed pending %#', async (value) => {
      const f = fixture();
      f.patch({ pendingLink: value });
      const token = f.read();
      const user = f.read(USER);
      await failure(f.store.discard(UID, ID));
      expect(f.read()).toEqual(token);
      expect(f.read(USER)).toEqual(user);
      expect(f.committed).toEqual([]);
    },
  );

  const methods = ['get', 'attach', 'confirm', 'discard'] as const;
  function call(f: Fixture, method: typeof methods[number], uid = UID, id = ID) {
    if (method === 'get') return f.store.get(uid);
    if (method === 'attach') return f.store.attachProfile(uid, id, access(f), PROFILE);
    if (method === 'confirm') return f.store.confirm(uid, id, true);
    return f.store.discard(uid, id);
  }

  it.each(methods)('%s rejects missing/deleting parents for every storage state', async (method) => {
    for (const state of ['missing', 'deleting'] as const) {
      for (const tokenState of ['pending', 'missing-token', 'missing-pending', 'receipt']) {
        const f = fixture();
        const expectedAccess = access(f);
        if (tokenState === 'missing-token') f.seed(TOKEN);
        if (tokenState === 'missing-pending') {
          const data = f.read()!;
          delete data.pendingLink;
          f.seed(TOKEN, data);
        }
        if (tokenState === 'receipt') {
          f.patch({ confirmedLink: { candidateId: ID, postEnabled: true } });
        }
        if (state === 'missing') f.seed(USER);
        else f.seed(USER, { ...f.read(USER), deletionInProgress: true });
        const before = f.read();
        // Keep attach input valid even when the stored candidate is absent.
        const operation = method === 'attach'
          ? f.store.attachProfile(UID, ID, expectedAccess, PROFILE)
          : call(f, method);
        await failure(operation);
        expect(f.read()).toEqual(before);
        expect(f.committed).toEqual([]);
      }
    }
  });

  it.each(methods)('%s rejects invalid UID before any document lookup', async (method) => {
    for (const uid of ['', ' ', '../other', '.', '..', '__reserved__', 'x'.repeat(129), '\ud800']) {
      const f = fixture();
      await failure(call(f, method, uid));
      expect(f.db.doc).not.toHaveBeenCalled();
      expect(f.committed).toEqual([]);
    }
  });

  it.each(['attach', 'confirm', 'discard'] as const)(
    '%s rejects invalid candidate identity before reads', async (method) => {
      for (const id of ['', ' ', '../bad', '__reserved__', 'x'.repeat(1501), '\ud800']) {
        const f = fixture();
        await failure(call(f, method, UID, id));
        expect(f.db.doc).not.toHaveBeenCalled();
      }
    },
  );

  it.each(methods)('%s rechecks parent on a deletion race', async (method) => {
    const f = fixture();
    await attach(f);
    f.committed.length = 0;
    const before = f.read();
    const attempts = f.attempts;
    f.conflict(() => f.seed(USER, { ...f.read(USER), deletionInProgress: true }));
    await failure(call(f, method));
    expect(f.attempts - attempts).toBe(2);
    expect(f.read()).toEqual(before);
    expect(f.committed).toEqual([]);
  });

  it.each(['attach', 'confirm', 'discard'] as const)(
    '%s cannot act on a concurrently replaced candidate', async (method) => {
      const f = fixture();
      await attach(f);
      const replacement = pending({ candidateId: 'replacement' });
      f.committed.length = 0;
      const user = f.read(USER);
      f.conflict(() => f.patch({ pendingLink: replacement }));
      await failure(call(f, method));
      expect(f.read()!.pendingLink).toEqual(replacement);
      expect(f.read(USER)).toEqual(user);
      expect(f.committed).toEqual([]);
    },
  );

  it('attach rejects access replacement even when candidate ID is unchanged', async () => {
    const f = fixture();
    const expected = access(f);
    const replacement = pending();
    f.conflict(() => f.patch({ pendingLink: replacement }));
    await failure(f.store.attachProfile(UID, ID, expected, PROFILE));
    expect(f.read()!.pendingLink).toEqual(replacement);
    expect(f.committed).toEqual([]);
  });

  it.each(['get', 'attach', 'confirm'] as const)(
    '%s uses fresh time after transaction conflict', async (method) => {
      const f = fixture();
      await attach(f);
      const before = f.read();
      f.committed.length = 0;
      f.conflict(() => {
        f.clock(NOW + 60000);
        f.seed(USER, { ...f.read(USER), unrelated: 'concurrent' });
      });
      if (method === 'get') await expect(call(f, method)).resolves.toBeNull();
      else await failure(call(f, method));
      expect(f.read()).toEqual(before);
      expect(f.committed).toEqual([]);
    },
  );

  it('retries concurrent confirmation using the receipt without reapplying user updates', async () => {
    const f = fixture();
    await attach(f);
    const data = f.read()!;
    f.conflict(() => {
      const completed: Data = { ...data, confirmedLink: { candidateId: ID, postEnabled: false } };
      delete completed.pendingLink;
      f.seed(TOKEN, completed);
      f.seed(USER, { ...f.read(USER), xLinked: true, xPostEnabled: true });
    });
    f.committed.length = 0;
    await expect(f.store.confirm(UID, ID, false)).resolves.toBeUndefined();
    expect(f.read(USER)!.xPostEnabled).toBe(true);
    expect(f.committed).toEqual([]);
  });
});


describe('candidateStore confirmation history transaction retries', () => {
  function initialize(f: Fixture): void {
    f.seed(USER, {
      ...f.read(USER),
      subscription: null,
      judgementHistoryStartedAt: Timestamp.fromMillis(NOW - 1000),
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    });
  }

  function entry(stream: string, revision: number): string {
    return `${USER}/judgementHistory/${stream}/entries/${revision}`;
  }

  it('recomputes before snapshots and revisions from the retried user read', async () => {
    const f = fixture();
    initialize(f);
    await attach(f);
    f.committed.length = 0;
    const attempts = f.attempts;
    f.conflict(() => f.seed(USER, {
      ...f.read(USER),
      xLinked: true,
      xPostEnabled: true,
      judgementRevisions: { goal: 1, settings: 4, xLink: 6, subscription: 1 },
    }));
    await f.store.confirm(UID, ID, false);
    expect(f.attempts - attempts).toBe(2);
    expect(f.read(entry('settings', 5))).toMatchObject({
      revision: 5, before: { xPostEnabled: true }, after: { xPostEnabled: false },
    });
    expect(f.read(entry('xLink', 7))).toMatchObject({
      revision: 7, before: { xLinked: true }, after: { xLinked: true },
    });
    expect(f.read(entry('settings', 2))).toBeUndefined();
    expect(f.read(entry('xLink', 2))).toBeUndefined();
    expect(f.read(USER)!.judgementRevisions).toEqual({
      goal: 1, settings: 5, xLink: 7, subscription: 1,
    });
    expect(f.committed).toHaveLength(4);
  });

  it('preserves old token/user and creates no entries on commit failure', async () => {
    const f = fixture();
    initialize(f);
    await attach(f);
    const token = f.read();
    const user = f.read(USER);
    f.committed.length = 0;
    f.failCommit();
    await failure(f.store.confirm(UID, ID, true));
    expect(f.read()).toEqual(token);
    expect(f.read(USER)).toEqual(user);
    expect(f.read(entry('settings', 2))).toBeUndefined();
    expect(f.read(entry('xLink', 2))).toBeUndefined();
    expect(f.committed).toEqual([]);
  });
});
