import { randomBytes, randomUUID } from 'node:crypto';
import {
  Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import { decrypt, encrypt, hashState } from '../crypto';
import { createStateStore } from '../stateStore';

type Data = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 20);
const EXPIRES = NOW + 60000; // テストfixture。製品のTTLを定めない。
const UID = 'state-store-unit';
const STATE = 'state-for-first-attempt';
const OTHER_STATE = 'state-for-other-attempt';
const VERIFIER = 'v'.repeat(43);
const REDIRECT = 'gokaku://oauth/callback?exact=1';
const FAILURE = 'X auth state operation failed';
const KEY = randomBytes(32).toString('base64');
const USER_PATH = `users/${UID}`;
const TOKEN_PATH = `xTokens/${UID}`;

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

/**
 * 楽観的transaction fake:
 * snapshotの分離、読み取りversion検査、callback再実行、全mutationの
 * commit前検証、例外時rollback、書き込み登録後のread拒否を行う。
 * SDKのロック実装そのものの検証は下のEmulatorテストで行う。
 */
function fixture() {
  const rows = new Map<string, Data>();
  const versions = new Map<string, number>();
  const reads: string[] = [];
  const committed: string[] = [];
  let attempts = 0;
  let beforeCommit: (() => void) | undefined;
  let rejectCommit = false;

  function seed(path: string, data?: Data): void {
    if (data === undefined) rows.delete(path);
    else rows.set(path, copy(data));
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }

  const db = {
    doc: jest.fn((path: string) => ({ path })),
    runTransaction: async <T>(
      callback: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
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
        const hook = beforeCommit;
        beforeCommit = undefined;
        hook?.();
        if ([...observed].some(
          ([path, version]) => (versions.get(path) ?? 0) !== version,
        )) {
          continue;
        }
        if (rejectCommit) throw new Error('private backend failure');
        for (const mutation of pending) {
          if (rows.has(mutation.path) === mutation.create) {
            throw new Error('mutation precondition failed');
          }
        }
        for (const mutation of pending) {
          seed(
            mutation.path,
            mutation.create
              ? mutation.data
              : { ...rows.get(mutation.path), ...mutation.data },
          );
          committed.push(mutation.path);
        }
        return result;
      }
      throw new Error('transaction conflict');
    },
  };

  seed(USER_PATH, { deletionInProgress: false });
  let now = NOW;
  const store = createStateStore({
    firestore: db as unknown as Firestore,
    now: () => now,
    encryptionKey: KEY,
  });

  return {
    db, store, seed, reads, committed,
    get attempts() { return attempts; },
    read: (path = TOKEN_PATH) => copy(rows.get(path)),
    clock: (value: number) => { now = value; },
    conflict: (hook: () => void) => { beforeCommit = hook; },
    failCommit: () => { rejectCommit = true; },
  };
}

function startInput(state = STATE) {
  return {
    uid: UID,
    state,
    pkceVerifier: VERIFIER,
    redirectUri: REDIRECT,
    expiresAt: EXPIRES,
  };
}

function consumeInput(state = STATE) {
  return { uid: UID, state, expectedRedirectUri: REDIRECT };
}

function states(f: ReturnType<typeof fixture>): Data {
  return f.read()!.oauthStates as Data;
}

async function failure(operation: Promise<unknown>): Promise<void> {
  const error: unknown = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(FAILURE);
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
}

describe('X OAuth state persistence', () => {
  it('16件目まで保存し、17件目は固定エラーで全項目を保持する', async () => {
    const f = fixture();
    const tokens = { accessToken: 'keep-access', metadata: { keep: true } };
    f.seed(TOKEN_PATH, tokens);
    for (let index = 0; index < 16; index += 1) {
      await f.store.start(startInput(`capacity-${index}`));
    }
    expect(Object.keys(states(f))).toHaveLength(16);
    const before = f.read();
    const commits = f.committed.length;
    await failure(f.store.start(startInput()));
    expect(f.read()).toEqual(before);
    expect(f.read()).toMatchObject(tokens);
    expect(f.committed).toHaveLength(commits);
  });

  it('成功時だけ既知の期限切れを整理し、有効・未知stateとtokenを保持する', async () => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    await f.store.start({ ...startInput('older'), expiresAt: NOW + 2 });
    await f.store.start(startInput(OTHER_STATE));
    const active = states(f)[hashState(OTHER_STATE)];
    const tokens = { accessToken: 'keep-access', pendingLink: { keep: true } };
    const unknown = { expiresAt: Timestamp.fromMillis(NOW), extra: 'keep' };
    f.seed(TOKEN_PATH, { ...tokens, oauthStates: { ...states(f), unknown } });
    f.clock(NOW + 2);
    await f.store.start(startInput('new-state'));
    expect(f.read()).toEqual({
      ...tokens,
      oauthStates: {
        [hashState(OTHER_STATE)]: active,
        unknown,
        [hashState('new-state')]: expect.any(Object),
      },
    });
    await failure(f.store.consume(consumeInput()));
    await failure(f.store.consume(consumeInput('older')));
    await expect(f.store.consume(consumeInput(OTHER_STATE))).resolves.toBe(VERIFIER);
  });

  it.each([
    null, [], 'unknown',
    { stateHash: 'wrong-hash' },
    { encryptedVerifier: '' },
    { encryptedVerifier: null },
    { redirectUri: '' },
    { redirectUri: null },
    { createdAt: 'unknown' },
    { expiresAt: 'unknown' },
    { createdAt: new Timestamp(0, 1) },
    { expiresAt: new Timestamp(0, 1) },
    { createdAt: Timestamp.fromMillis(NOW + 1) },
    { createdAt: Timestamp.fromMillis(NOW + 2) },
  ])('期限切れに見える不正recordを削除しない: %j', async (patch) => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    const key = hashState(STATE);
    const record = states(f)[key] as Data;
    const corrupt = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
      ? { ...record, ...patch }
      : patch;
    f.seed(TOKEN_PATH, { oauthStates: { [key]: corrupt } });
    f.clock(NOW + 2);
    await f.store.start(startInput(OTHER_STATE));
    expect(states(f)[key]).toEqual(corrupt);
    expect(Object.keys(states(f))).toHaveLength(2);
  });

  it('hash形式でないkeyはrecord内の値と一致しても保持する', async () => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    const record = states(f)[hashState(STATE)] as Data;
    const unknown = { ...record, stateHash: 'unknown' };
    f.seed(TOKEN_PATH, { oauthStates: { unknown } });
    f.clock(NOW + 1);
    await f.store.start(startInput(OTHER_STATE));
    expect(states(f).unknown).toEqual(unknown);
  });

  it('整理後も未知recordを含む16件なら拒否し、期限切れの整理もrollbackする', async () => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    for (let index = 0; index < 15; index += 1) {
      await f.store.start(startInput(`active-${index}`));
    }
    f.seed(TOKEN_PATH, {
      ...f.read(),
      refreshToken: 'keep-refresh',
      oauthStates: { ...states(f), unknown: { expiresAt: Timestamp.fromMillis(NOW) } },
    });
    const before = f.read();
    const commits = f.committed.length;
    f.clock(NOW + 1);
    await failure(f.store.start(startInput(OTHER_STATE)));
    expect(f.read()).toEqual(before);
    expect(f.committed).toHaveLength(commits);
  });

  it('期限切れの同じhashも整理前に拒否し、他の期限切れも変更しない', async () => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    await f.store.start({ ...startInput(OTHER_STATE), expiresAt: NOW + 1 });
    const before = f.read();
    const commits = f.committed.length;
    f.clock(NOW + 1);
    await failure(f.store.start(startInput()));
    await failure(f.store.consume(consumeInput()));
    expect(f.read()).toEqual(before);
    expect(f.committed).toHaveLength(commits);
  });

  it('期限切れ整理を伴うstartもcommit失敗で全項目を保持する', async () => {
    const f = fixture();
    await f.store.start({ ...startInput(), expiresAt: NOW + 1 });
    const before = f.read();
    const commits = f.committed.length;
    f.clock(NOW + 1);
    f.failCommit();
    await failure(f.store.start(startInput(OTHER_STATE)));
    expect(f.read()).toEqual(before);
    expect(f.committed).toHaveLength(commits);
  });

  it('競合再実行で最新の容量を確認し、17件目をcommitしない', async () => {
    const f = fixture();
    for (let index = 0; index < 15; index += 1) {
      await f.store.start(startInput(`active-${index}`));
    }
    const before = f.read()!;
    const concurrent = {
      ...before,
      oauthStates: { ...states(f), unknown: null },
    };
    const attempts = f.attempts;
    const commits = f.committed.length;
    f.conflict(() => f.seed(TOKEN_PATH, concurrent));
    await failure(f.store.start(startInput()));
    expect(f.attempts).toBe(attempts + 2);
    expect(f.read()).toEqual(concurrent);
    expect(f.committed).toHaveLength(commits);
  });

  it('hash key・暗号化・正確なredirectと明示期限を保存する', async () => {
    const f = fixture();
    await f.store.start(startInput());
    const saved = states(f);
    expect(Object.keys(saved)).toEqual([hashState(STATE)]);
    const record = saved[hashState(STATE)] as Data;
    expect(record).toEqual({
      stateHash: hashState(STATE),
      encryptedVerifier: expect.any(String),
      redirectUri: REDIRECT,
      createdAt: Timestamp.fromMillis(NOW),
      expiresAt: Timestamp.fromMillis(EXPIRES),
    });
    expect(decrypt(record.encryptedVerifier as string, KEY, {
      uid: UID, purpose: 'pkceVerifier',
    })).toBe(VERIFIER);
    expect(JSON.stringify(f.read())).not.toContain(VERIFIER);
    expect(JSON.stringify(f.read())).not.toContain(STATE);
    expect(f.db.doc.mock.calls.map(([path]) => path)).toEqual([
      USER_PATH, TOKEN_PATH,
    ]);
    expect(f.read(USER_PATH)).toEqual({ deletionInProgress: false });
  });

  it('他のtoken項目・stateを追加と消費の両方で保持する', async () => {
    const f = fixture();
    const tokens = {
      accessToken: 'opaque-access-envelope',
      refreshToken: 'opaque-refresh-envelope',
      expiresAt: Timestamp.fromMillis(EXPIRES),
      metadata: { untouched: true },
    };
    f.seed(TOKEN_PATH, tokens);
    await f.store.start(startInput(OTHER_STATE));
    const other = states(f)[hashState(OTHER_STATE)];
    await f.store.start(startInput());
    expect(f.read()).toMatchObject(tokens);
    expect(states(f)[hashState(OTHER_STATE)]).toEqual(other);
    await expect(f.store.consume(consumeInput())).resolves.toBe(VERIFIER);
    expect(f.read()).toEqual({
      ...tokens,
      oauthStates: { [hashState(OTHER_STATE)]: other },
    });
    await failure(f.store.consume(consumeInput()));
    expect(states(f)[hashState(OTHER_STATE)]).toEqual(other);
  });

  it('重複hashを上書きせず、異なるstateの並行追加は両方保持する', async () => {
    const f = fixture();
    await f.store.start(startInput());
    const before = f.read();
    await failure(f.store.start({ ...startInput(), pkceVerifier: 'w'.repeat(43) }));
    expect(f.read()).toEqual(before);

    const fresh = fixture();
    await Promise.all([
      fresh.store.start(startInput()),
      fresh.store.start(startInput(OTHER_STATE)),
    ]);
    expect(Object.keys(states(fresh)).sort()).toEqual([
      hashState(STATE), hashState(OTHER_STATE),
    ].sort());
    expect(fresh.attempts).toBeGreaterThan(2);
  });

  it('同じstateの並行作成・消費はそれぞれ1回だけ成功する', async () => {
    const f = fixture();
    const created = await Promise.allSettled([
      f.store.start(startInput()), f.store.start(startInput()),
    ]);
    expect(created.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const consumed = await Promise.allSettled([
      f.store.consume(consumeInput()), f.store.consume(consumeInput()),
    ]);
    expect(consumed.filter((result) => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: VERIFIER },
    ]);
    expect(states(f)).toEqual({});
  });

  it('state不一致・redirectの僅かな差異は有効stateを変更しない', async () => {
    const f = fixture();
    await f.store.start(startInput());
    const before = f.read();
    await failure(f.store.consume(consumeInput('unknown-state')));
    for (const expectedRedirectUri of [REDIRECT + '/', REDIRECT + ' ', REDIRECT.toUpperCase()]) {
      await failure(f.store.consume({ ...consumeInput(), expectedRedirectUri }));
    }
    expect(f.read()).toEqual(before);
    await expect(f.store.consume(consumeInput())).resolves.toBe(VERIFIER);
  });

  it.each([EXPIRES, EXPIRES + 1, NOW - 1, NaN, Infinity])(
    '期限境界・期限超過・未来createdAt・不正な現在時刻 %s を拒否する',
    async (now) => {
      const f = fixture();
      await f.store.start(startInput());
      const before = f.read();
      f.clock(now);
      await failure(f.store.consume(consumeInput()));
      expect(f.read()).toEqual(before);
    },
  );

  it.each([NOW, NOW - 1, NaN, Infinity, 0.5, 8640000000000000])(
    '不正な明示expiresAt %s を保存しない',
    async (expiresAt) => {
      const f = fixture();
      await failure(f.store.start({ ...startInput(), expiresAt }));
      expect(f.read()).toBeUndefined();
      expect(f.committed).toEqual([]);
    },
  );

  it.each([
    { stateHash: 'wrong-hash' },
    { redirectUri: null },
    { encryptedVerifier: 'malformed-envelope' },
    { createdAt: 'not-a-timestamp' },
    { expiresAt: Timestamp.fromMillis(NOW) },
    { createdAt: Timestamp.fromMillis(EXPIRES) },
    { createdAt: new Timestamp(0, 1) },
  ])('壊れたrecordを消さず固定エラーにする: %j', async (patch) => {
    const f = fixture();
    await f.store.start(startInput());
    const record = states(f)[hashState(STATE)] as Data;
    f.seed(TOKEN_PATH, {
      oauthStates: { [hashState(STATE)]: { ...record, ...patch } },
    });
    const before = f.read();
    await failure(f.store.consume(consumeInput()));
    expect(f.read()).toEqual(before);
  });

  it('別UID・用途・鍵の暗号文を復号せず、stateを保持する', async () => {
    for (const envelope of [
      encrypt(VERIFIER, KEY, { uid: UID + '-other', purpose: 'pkceVerifier' }),
      encrypt(VERIFIER, KEY, { uid: UID, purpose: 'accessToken' }),
      encrypt(VERIFIER, randomBytes(32).toString('base64'), {
        uid: UID, purpose: 'pkceVerifier',
      }),
    ]) {
      const f = fixture();
      await f.store.start(startInput());
      const record = states(f)[hashState(STATE)] as Data;
      f.seed(TOKEN_PATH, {
        oauthStates: { [hashState(STATE)]: { ...record, encryptedVerifier: envelope } },
      });
      const before = f.read();
      await failure(f.store.consume(consumeInput()));
      expect(f.read()).toEqual(before);
    }
  });

  it.each(['', '.', '..', 'a/b', 'a/b/c', '__reserved__', '\ud800', 'u'.repeat(129)])(
    '不正UID %j はパス作成前に拒否する',
    async (uid) => {
      const f = fixture();
      await failure(f.store.start({ ...startInput(), uid }));
      await failure(f.store.consume({ ...consumeInput(), uid }));
      expect(f.db.doc).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { deletionInProgress: true }])(
    '親missing/deletingは作成・消費とも拒否する',
    async (parent) => {
      const f = fixture();
      await f.store.start(startInput());
      const before = f.read();
      f.seed(USER_PATH, parent);
      await failure(f.store.start(startInput(OTHER_STATE)));
      await failure(f.store.consume(consumeInput()));
      expect(f.read()).toEqual(before);
    },
  );

  it.each(['start', 'consume'] as const)(
    '%sの競合再実行で削除markerを読み直し、mutationを残さない',
    async (operation) => {
      const f = fixture();
      await f.store.start(startInput());
      const before = f.read();
      f.conflict(() => f.seed(USER_PATH, { deletionInProgress: true }));
      await failure(operation === 'start'
        ? f.store.start(startInput(OTHER_STATE))
        : f.store.consume(consumeInput()));
      expect(f.read()).toEqual(before);
      expect(f.read(USER_PATH)).toEqual({ deletionInProgress: true });
      expect(f.reads.filter((path) => path === USER_PATH).length).toBeGreaterThanOrEqual(3);
    },
  );

  it('再実行時に現在時刻も再確認し、期限切れstateを消費しない', async () => {
    const f = fixture();
    await f.store.start(startInput());
    const before = f.read();
    f.conflict(() => {
      f.seed(TOKEN_PATH, before);
      f.clock(EXPIRES);
    });
    await failure(f.store.consume(consumeInput()));
    expect(f.read()).toEqual(before);
  });

  it('commit失敗ではverifierを返さず、作成・消費ともrollbackする', async () => {
    const f = fixture();
    await f.store.start(startInput());
    const before = f.read();
    f.failCommit();
    await failure(f.store.consume(consumeInput()));
    await failure(f.store.start(startInput(OTHER_STATE)));
    expect(f.read()).toEqual(before);
  });

  it('missing doc/record・壊れたmapは固定エラー、既存内容を保持する', async () => {
    const f = fixture();
    await failure(f.store.consume(consumeInput()));
    for (const oauthStates of [null, [], 'invalid', 123]) {
      f.seed(TOKEN_PATH, { accessToken: 'keep', oauthStates });
      const before = f.read();
      await failure(f.store.start(startInput()));
      await failure(f.store.consume(consumeInput()));
      expect(f.read()).toEqual(before);
    }
  });

  it('不正PKCE・state・redirectは保存しない', async () => {
    const f = fixture();
    for (const patch of [
      { pkceVerifier: 'short' }, { state: '' }, { state: '\ud800' },
      { redirectUri: '' }, { redirectUri: '\ud800' },
    ]) {
      await failure(f.store.start({ ...startInput(), ...patch }));
    }
    expect(f.read()).toBeUndefined();
    expect(f.committed).toEqual([]);
  });
});

// 未設定時は純粋unitのみ。設定があればlocalhost/demoを厳密確認してから接続する。
const emulatorSuite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

emulatorSuite('stateStore Firestore Emulator integration', () => {
  let db: Firestore;
  let uid: string;

  beforeAll(() => {
    if (
      process.env.GCLOUD_PROJECT !== 'demo-gokaku' ||
      !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
    ) {
      throw new Error('Local demo-gokaku Firestore Emulator required');
    }
    db = new Firestore({ projectId: 'demo-gokaku' });
  });

  beforeEach(async () => {
    uid = `oauth-state-${randomUUID()}`;
    await db.doc(`users/${uid}`).create({ deletionInProgress: false });
  });

  afterEach(async () => {
    if (!db || !uid) return;
    try {
      await db.doc(`xTokens/${uid}`).delete();
    } finally {
      await db.doc(`users/${uid}`).delete();
    }
  });

  afterAll(async () => {
    if (db) await db.terminate();
  });

  it('実transactionで競合消費は1成功、他state/tokenは保持する', async () => {
    const tokenRef = db.doc(`xTokens/${uid}`);
    await tokenRef.create({ accessToken: 'keep-access', refreshToken: 'keep-refresh' });
    const store = createStateStore({ firestore: db, now: () => NOW, encryptionKey: KEY });
    await Promise.all([
      store.start({ ...startInput(), uid }),
      store.start({ ...startInput(OTHER_STATE), uid }),
    ]);
    const before = (await tokenRef.get()).data()!;
    await failure(store.start({ ...startInput(), uid }));
    expect((await tokenRef.get()).data()).toEqual(before);

    const results = await Promise.allSettled([
      store.consume({ ...consumeInput(), uid }),
      store.consume({ ...consumeInput(), uid }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: VERIFIER },
    ]);
    const saved = (await tokenRef.get()).data()!;
    expect(saved).toEqual({
      accessToken: 'keep-access',
      refreshToken: 'keep-refresh',
      oauthStates: {
        [hashState(OTHER_STATE)]: before.oauthStates[hashState(OTHER_STATE)],
      },
    });
  }, 30_000);

  it('親markerとmissingを作成・消費の両方で拒否する', async () => {
    const store = createStateStore({ firestore: db, now: () => NOW, encryptionKey: KEY });
    await store.start({ ...startInput(), uid });
    const tokenRef = db.doc(`xTokens/${uid}`);
    const before = (await tokenRef.get()).data();
    await db.doc(`users/${uid}`).update({ deletionInProgress: true });
    await failure(store.start({ ...startInput(OTHER_STATE), uid }));
    await failure(store.consume({ ...consumeInput(), uid }));
    await db.doc(`users/${uid}`).delete();
    await failure(store.start({ ...startInput(OTHER_STATE), uid }));
    await failure(store.consume({ ...consumeInput(), uid }));
    expect((await tokenRef.get()).data()).toEqual(before);
  });
});
