import { randomBytes, randomUUID } from 'node:crypto';
import {
  FieldValue,
  Firestore,
  Timestamp,
  type DocumentData,
  type Transaction,
} from 'firebase-admin/firestore';

import { createActiveTokenStore } from '../activeTokenStore';
import { createCandidateStore } from '../candidateStore';
import { decrypt, encrypt } from '../crypto';
import type { TokenResult } from '../tokenTransport';

/**
 * 7-3b内部単位: active認証情報の更新排他・比較保存。
 * このファイルはread-onlyで受け渡す未実行のRED用テスト。
 * mainが適用し、実Emulator RED後に製品sourceを受け取る。
 *
 * 提案する内部API契約（公開Callableへexportしない）:
 * read(uid): Promise<ActiveSnapshot | null>
 * claimRefresh(uid, expected, claimId, ttlMs): Promise<'claimed' | 'busy' | 'blocked'>
 * saveRefresh(uid, expected, claimId, tokens): Promise<'saved' | 'already-saved'>
 * blockRefresh(uid, expected, claimId): Promise<void>
 * releaseRefresh(uid, expected, claimId): Promise<void>
 *
 * ActiveSnapshotは以下8項目だけ。平文は含まない。
 * blockedは同じ連携世代で解除しない。busyを受けた呼出元はHTTPを開始しない。
 * 同じclaimIdのclaim再送もbusyとし、HTTP開始権限を二重に与えない。
 * save済みreceiptの再送は元snapshotと現在の保存済みcredentialsを照合し、
 * 再暗号化やupdateをせずalready-savedを返す。
 * stale snapshot/非所有者/期限外save/不正入力/SDK失敗はすべて定型Error。
 * refreshControlの具体的な内部field構造は実装に委ねる。
 * releaseは呼出元が明確な失敗を確認した場合だけ使用する内部API。
 * HTTP・5分待機・3回制限・通知・root連携変更はこのStoreの責務に含めない。
 */
interface ActiveSnapshot {
  readonly uid: string;
  readonly linkRevision: number;
  readonly candidateId: string;
  readonly xUserId: string;
  readonly encryptedAccessToken: string;
  readonly encryptedRefreshToken: string;
  readonly scope: string;
  readonly expiresAt: Timestamp;
}

interface StoreContract {
  read(uid: string): Promise<ActiveSnapshot | null>;
  claimRefresh(
    uid: string, expected: ActiveSnapshot, claimId: string, ttlMs: number,
  ): Promise<'claimed' | 'busy' | 'blocked'>;
  saveRefresh(
    uid: string, expected: ActiveSnapshot, claimId: string, tokens: TokenResult,
  ): Promise<'saved' | 'already-saved'>;
  blockRefresh(uid: string, expected: ActiveSnapshot, claimId: string): Promise<void>;
  releaseRefresh(uid: string, expected: ActiveSnapshot, claimId: string): Promise<void>;
}

const NOW = Date.UTC(2026, 9, 26, 0, 0, 0);
const MAX_TIMESTAMP_MS = 253402300799999;
const KEY = randomBytes(32).toString('base64');
const SCOPE = 'tweet.read tweet.write users.read offline.access';
const TTL = 30_000;
const FAILURE = 'X auth active token operation failed';
const OLD_ACCESS = 'synthetic-active-access';
const OLD_REFRESH = 'synthetic-active-refresh';

function tokens(patch: Partial<TokenResult> = {}): TokenResult {
  return {
    accessToken: 'synthetic-updated-access',
    refreshToken: 'synthetic-updated-refresh',
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: SCOPE,
    ...patch,
  };
}

async function failure(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(FAILURE);
  expect((caught as Error).cause).toBeUndefined();
  expect(Object.keys(caught as Error)).toEqual([]);
}

describe('activeTokenStore with real local Firestore', () => {
  let db: Firestore;
  let uid: string;
  let time: number;
  let initialUser: DocumentData;
  let initialToken: DocumentData;

  beforeAll(() => {
    const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
    const match = /^(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(host);
    if (
      process.env.GCLOUD_PROJECT !== 'demo-gokaku' ||
      match === null || Number(match[1]) > 65535
    ) {
      throw new Error('Local demo-gokaku Firestore Emulator required');
    }
    db = new Firestore({ projectId: 'demo-gokaku' });
  });

  function userRef() { return db.doc(`users/${uid}`); }
  function tokenRef() { return db.doc(`xTokens/${uid}`); }

  function store(firestore: Firestore = db, now: () => number = () => time): StoreContract {
    return createActiveTokenStore({ firestore, now, encryptionKey: KEY });
  }

  function activeData(): DocumentData {
    return {
      encryptedAccessToken: encrypt(OLD_ACCESS, KEY, { uid, purpose: 'accessToken' }),
      encryptedRefreshToken: encrypt(OLD_REFRESH, KEY, { uid, purpose: 'refreshToken' }),
      // An expired access token must still be readable for refresh.
      expiresAt: Timestamp.fromMillis(NOW - 1000),
      scope: SCOPE,
      xUserId: '100',
      confirmedLink: { candidateId: 'active_candidate', postEnabled: true },
      pendingLink: {
        candidateId: 'pending_candidate',
        encryptedAccessToken: encrypt('synthetic-pending-access', KEY, {
          uid, purpose: 'accessToken',
        }),
        encryptedRefreshToken: encrypt('synthetic-pending-refresh', KEY, {
          uid, purpose: 'refreshToken',
        }),
        expiresAt: Timestamp.fromMillis(NOW + 600_000),
        scope: SCOPE,
        profile: { id: '200', username: 'new_user', profileImageUrl: null },
      },
      oauthStates: { unrelated_state: { retained: true } },
      unrelated: { nested: ['keep'] },
    };
  }

  beforeEach(async () => {
    uid = `active-token-store-${randomUUID()}`;
    time = NOW;
    initialUser = {
      xLinked: true,
      xPostEnabled: true,
      xUsername: 'old_user',
      subscription: null,
      deletionInProgress: false,
      unrelated: 'keep',
      judgementHistoryStartedAt: Timestamp.fromMillis(NOW - 10_000),
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    };
    initialToken = activeData();
    await userRef().create(initialUser);
    await tokenRef().create(initialToken);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db || !uid) return;
    try {
      // Only this test's private token document; never collection-wide cleanup.
      await tokenRef().delete();
    } finally {
      // Includes only this test's owned history subcollections.
      await db.recursiveDelete(userRef());
    }
  });

  afterAll(async () => {
    if (db) await db.terminate();
  });

  async function snapshot(): Promise<ActiveSnapshot> {
    const result = await store().read(uid);
    expect(result).not.toBeNull();
    return result!;
  }

  async function state() {
    return db.runTransaction(async (tx) => {
      const docs = await tx.getAll(userRef(), tokenRef());
      return docs.map((doc) => ({ data: doc.data(), updateTime: doc.updateTime }));
    }, { readOnly: true });
  }

  async function claimed(claimId = randomUUID()) {
    const expected = await snapshot();
    expect(await store().claimRefresh(uid, expected, claimId, TTL)).toBe('claimed');
    return { expected, claimId };
  }

  async function unchanged(operation: Promise<unknown>, before: Awaited<ReturnType<typeof state>>) {
    await failure(operation);
    expect(await state()).toEqual(before);
  }

  function writes(s: StoreContract, expected: ActiveSnapshot, claimId: string) {
    return [
      () => s.claimRefresh(uid, expected, randomUUID(), TTL),
      () => s.saveRefresh(uid, expected, claimId, tokens()),
      () => s.blockRefresh(uid, expected, claimId),
      () => s.releaseRefresh(uid, expected, claimId),
    ];
  }

  it('01 reads exact legacy active envelopes and generation without writes or plaintext', async () => {
    const before = await state();
    const result = await snapshot();
    expect(result).toEqual({
      uid,
      linkRevision: 1,
      candidateId: 'active_candidate',
      xUserId: '100',
      encryptedAccessToken: initialToken.encryptedAccessToken,
      encryptedRefreshToken: initialToken.encryptedRefreshToken,
      expiresAt: initialToken.expiresAt,
      scope: SCOPE,
    });
    expect(result.expiresAt).toBeInstanceOf(Timestamp);
    expect(decrypt(result.encryptedAccessToken, KEY, { uid, purpose: 'accessToken' }))
      .toBe(OLD_ACCESS);
    expect(decrypt(result.encryptedRefreshToken, KEY, { uid, purpose: 'refreshToken' }))
      .toBe(OLD_REFRESH);
    expect(JSON.stringify(result)).not.toContain(OLD_ACCESS);
    expect(JSON.stringify(result)).not.toContain(OLD_REFRESH);
    expect(await state()).toEqual(before);
  });

  it('02 returns null for unlinked accounts with no active credentials, including pending-only', async () => {
    await userRef().update({ xLinked: false });
    for (const data of [undefined, {}, { pendingLink: initialToken.pendingLink }]) {
      if (data === undefined) await tokenRef().delete();
      else await tokenRef().set(data);
      const before = await state();
      expect(await store().read(uid)).toBeNull();
      expect(await state()).toEqual(before);
    }
  });

  it('03 rejects missing or partial active credentials and malformed active metadata', async () => {
    const patches: DocumentData[] = [
      { encryptedAccessToken: FieldValue.delete() },
      { encryptedRefreshToken: FieldValue.delete() },
      { expiresAt: FieldValue.delete() },
      { scope: FieldValue.delete() },
      { xUserId: FieldValue.delete() },
      { expiresAt: '2026-10-26T00:00:00Z' },
      { expiresAt: { seconds: 1, nanoseconds: 0 } },
      // Firestore preserves microseconds; retain an invalid sub-millisecond value.
      { expiresAt: new Timestamp(1, 1000) },
      { scope: 'tweet.read tweet.write users.read' },
      { scope: `${SCOPE} offline.access.extra\n` },
      { scope: SCOPE.replace(' ', '  ') },
      { xUserId: 'not-a-provider-id' },
      { encryptedAccessToken: 'invalid-envelope' },
    ];
    for (const patch of patches) {
      await tokenRef().set(initialToken);
      await tokenRef().update(patch);
      const before = await state();
      if (patch.expiresAt instanceof Timestamp) {
        expect(before[1].data!.expiresAt).toEqual(patch.expiresAt);
      }
      await unchanged(store().read(uid), before);
    }
    await tokenRef().delete();
    await unchanged(store().read(uid), await state());
    await userRef().update({ xLinked: false });
    await tokenRef().set({ encryptedAccessToken: initialToken.encryptedAccessToken });
    await unchanged(store().read(uid), await state());
  });

  it('04 authenticates both old envelopes against exact uid and purpose', async () => {
    const badEnvelopes: DocumentData[] = [
      { encryptedAccessToken: encrypt(OLD_ACCESS, KEY, { uid: 'other', purpose: 'accessToken' }) },
      { encryptedRefreshToken: encrypt(OLD_REFRESH, KEY, { uid: 'other', purpose: 'refreshToken' }) },
      { encryptedAccessToken: initialToken.encryptedRefreshToken },
      { encryptedRefreshToken: initialToken.encryptedAccessToken },
    ];
    for (const patch of badEnvelopes) {
      await tokenRef().set({ ...initialToken, ...patch });
      await unchanged(store().read(uid), await state());
    }
  });

  it('05 rejects malformed generation metadata and confirmation receipts', async () => {
    for (const revision of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      await userRef().update({ 'judgementRevisions.xLink': revision });
      await unchanged(store().read(uid), await state());
    }
    await userRef().set(initialUser);
    await userRef().update({ 'judgementRevisions.xLink': FieldValue.delete() });
    await unchanged(store().read(uid), await state());
    await userRef().set(initialUser);
    for (const receipt of [null, {}, { candidateId: '../unsafe' }, { candidateId: '' }]) {
      await tokenRef().set({ ...initialToken, confirmedLink: receipt });
      await unchanged(store().read(uid), await state());
    }
  });

  it('06 gives exactly one of two concurrent server claims permission to refresh', async () => {
    const expected = await snapshot();
    const beforeUser = (await state())[0];
    const ids = [randomUUID(), randomUUID()];
    const results = await Promise.all(ids.map((id) =>
      store().claimRefresh(uid, expected, id, TTL)));
    expect([...results].sort()).toEqual(['busy', 'claimed']);
    const winner = ids[results.indexOf('claimed')];
    const loser = ids[results.indexOf('busy')];
    const before = await state();
    await unchanged(store().saveRefresh(uid, expected, loser, tokens()), before);
    expect(await store().saveRefresh(uid, expected, winner, tokens())).toBe('saved');
    expect((await state())[0]).toEqual(beforeUser);
  });

  it('07 persists busy across Store instances and does not renew even the same claimId', async () => {
    const { expected, claimId } = await claimed();
    const before = await state();
    time += TTL - 1;
    expect(await store().claimRefresh(uid, expected, claimId, TTL)).toBe('busy');
    expect(await store().claimRefresh(uid, expected, randomUUID(), TTL)).toBe('busy');
    expect(await state()).toEqual(before);
  });

  it('08 converts expired inflight to persistent blocked at the exact boundary', async () => {
    const { expected, claimId } = await claimed();
    time += TTL;
    expect(await store().claimRefresh(uid, expected, randomUUID(), TTL)).toBe('blocked');
    const blocked = await state();
    expect(blocked[1].data!.encryptedAccessToken).toBe(initialToken.encryptedAccessToken);
    time += TTL * 100;
    expect(await store().claimRefresh(uid, expected, randomUUID(), TTL)).toBe('blocked');
    expect(await state()).toEqual(blocked);
    await unchanged(store().saveRefresh(uid, expected, claimId, tokens()), blocked);
    await unchanged(store().releaseRefresh(uid, expected, claimId), blocked);
  });

  it('09 explicit block prevents subsequent refresh and cannot be released', async () => {
    const { expected, claimId } = await claimed();
    await expect(store().blockRefresh(uid, expected, claimId)).resolves.toBeUndefined();
    const before = await state();
    expect(await store().claimRefresh(uid, expected, randomUUID(), TTL)).toBe('blocked');
    await unchanged(store().releaseRefresh(uid, expected, claimId), before);
    await unchanged(store().saveRefresh(uid, expected, claimId, tokens()), before);
  });

  it('10 releases a known refusal while preventing its delayed owner from saving', async () => {
    const { expected, claimId } = await claimed();
    await expect(store().releaseRefresh(uid, expected, claimId)).resolves.toBeUndefined();
    const nextId = randomUUID();
    expect(await store().claimRefresh(uid, expected, nextId, TTL)).toBe('claimed');
    const before = await state();
    await unchanged(store().saveRefresh(uid, expected, claimId, tokens()), before);
    await unchanged(store().blockRefresh(uid, expected, claimId), before);
    await unchanged(store().releaseRefresh(uid, expected, claimId), before);
    expect(await store().saveRefresh(uid, expected, nextId, tokens())).toBe('saved');
  });

  it('11 rejects nonowners and unclaimed writes without changing any document', async () => {
    const expected = await snapshot();
    const id = randomUUID();
    for (const operation of writes(store(), expected, id).slice(1)) {
      await unchanged(operation(), await state());
    }
    await store().claimRefresh(uid, expected, id, TTL);
    for (const operation of writes(store(), expected, randomUUID()).slice(1)) {
      await unchanged(operation(), await state());
    }
  });

  it('12 saves AAD-encrypted tokens and exact expiry while preserving every unrelated field', async () => {
    const { expected, claimId } = await claimed();
    const oldExpected = { ...expected };
    const before = await state();
    const result = tokens({ scope: `${SCOPE} extra.scope` });
    time += 5000;
    expect(await store().saveRefresh(uid, expected, claimId, result)).toBe('saved');
    const after = await state();
    expect(after[0]).toEqual(before[0]);
    const data = after[1].data!;
    const { refreshControl, ...rest } = data;
    expect(refreshControl).toBeDefined();
    expect(rest).toEqual({
      ...initialToken,
      encryptedAccessToken: data.encryptedAccessToken,
      encryptedRefreshToken: data.encryptedRefreshToken,
      scope: result.scope,
      expiresAt: Timestamp.fromMillis(time + result.expiresIn * 1000),
    });
    expect(data.expiresAt).toBeInstanceOf(Timestamp);
    expect(decrypt(data.encryptedAccessToken, KEY, { uid, purpose: 'accessToken' }))
      .toBe(result.accessToken);
    expect(decrypt(data.encryptedRefreshToken, KEY, { uid, purpose: 'refreshToken' }))
      .toBe(result.refreshToken);
    expect(() => decrypt(data.encryptedAccessToken, KEY, {
      uid: 'other', purpose: 'accessToken',
    })).toThrow();
    expect(() => decrypt(data.encryptedAccessToken, KEY, { uid, purpose: 'refreshToken' }))
      .toThrow();
    expect(() => decrypt(data.encryptedRefreshToken, KEY, { uid, purpose: 'accessToken' }))
      .toThrow();
    expect(JSON.stringify(after)).not.toContain(result.accessToken);
    expect(JSON.stringify(after)).not.toContain(result.refreshToken);
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect(expected).toEqual(oldExpected);
  });

  it('13 concurrent save retransmissions return saved/already-saved and never rewrite receipt', async () => {
    const { expected, claimId } = await claimed();
    const results = await Promise.all([
      store().saveRefresh(uid, expected, claimId, tokens()),
      store().saveRefresh(uid, expected, claimId, tokens()),
    ]);
    expect([...results].sort()).toEqual(['already-saved', 'saved']);
    const saved = await state();
    time += TTL * 10;
    expect(await store().saveRefresh(uid, expected, claimId, tokens())).toBe('already-saved');
    expect(await state()).toEqual(saved);
  });

  it('14 does not treat an old receipt as authority over subsequently changed credentials', async () => {
    const { expected, claimId } = await claimed();
    await store().saveRefresh(uid, expected, claimId, tokens());
    await tokenRef().update({
      encryptedAccessToken: encrypt('synthetic-concurrent-access', KEY, {
        uid, purpose: 'accessToken',
      }),
    });
    await unchanged(store().saveRefresh(uid, expected, claimId, tokens()), await state());
  });

  it('15 binds all eight snapshot values and never mutates frozen caller snapshots', async () => {
    const { expected, claimId } = await claimed();
    const patches: Partial<ActiveSnapshot>[] = [
      { uid: 'other' }, { linkRevision: 2 }, { candidateId: 'different_candidate' },
      { xUserId: '999' },
      { encryptedAccessToken: encrypt(OLD_ACCESS, KEY, { uid, purpose: 'accessToken' }) },
      { encryptedRefreshToken: encrypt(OLD_REFRESH, KEY, { uid, purpose: 'refreshToken' }) },
      { scope: `${SCOPE} extra.scope` },
      { expiresAt: Timestamp.fromMillis(NOW) },
    ];
    for (const patch of patches) {
      const forged = Object.freeze({ ...expected, ...patch });
      const before = await state();
      for (const operation of writes(store(), forged, claimId)) {
        await unchanged(operation(), before);
      }
    }
    const frozen = Object.freeze({ ...expected });
    expect(await store().saveRefresh(uid, frozen, claimId, tokens())).toBe('saved');
    expect(frozen).toEqual(expected);
  });

  it('16 rejects stale snapshots after either envelope, scope, expiry or identity changes', async () => {
    const { expected, claimId } = await claimed();
    const original = (await tokenRef().get()).data()!;
    const patches: DocumentData[] = [
      { encryptedAccessToken: encrypt(OLD_ACCESS, KEY, { uid, purpose: 'accessToken' }) },
      { encryptedRefreshToken: encrypt(OLD_REFRESH, KEY, { uid, purpose: 'refreshToken' }) },
      { scope: `${SCOPE} extra.scope` },
      { expiresAt: Timestamp.fromMillis(NOW + 1) },
      { xUserId: '200' },
      { confirmedLink: { candidateId: 'other_candidate', postEnabled: true } },
    ];
    for (const patch of patches) {
      await tokenRef().set({ ...original, ...patch });
      const before = await state();
      for (const operation of writes(store(), expected, claimId)) {
        await unchanged(operation(), before);
      }
    }
    await tokenRef().set(original);
    await userRef().update({ 'judgementRevisions.xLink': 2 });
    for (const operation of writes(store(), expected, claimId)) {
      await unchanged(operation(), await state());
    }
  });

  it.each([false, true])(
    '17 allows a genuinely new link generation to replace control with blocked=%s',
    async (blocked) => {
      const { expected, claimId } = await claimed();
      if (blocked) await store().blockRefresh(uid, expected, claimId);
      await createCandidateStore({ firestore: db, now: () => time, encryptionKey: KEY })
        .confirm(uid, 'pending_candidate', true);
      const current = await snapshot();
      expect(current.linkRevision).toBe(2);
      expect(current.candidateId).toBe('pending_candidate');
      expect(await store().claimRefresh(uid, current, randomUUID(), TTL)).toBe('claimed');
    },
  );

  it('18 rejects every delayed old-owner operation after real candidate confirmation', async () => {
    const { expected, claimId } = await claimed();
    await createCandidateStore({ firestore: db, now: () => time, encryptionKey: KEY })
      .confirm(uid, 'pending_candidate', false);
    const current = await snapshot();
    const before = await state();
    for (const operation of writes(store(), expected, claimId)) {
      await unchanged(operation(), before);
    }
    expect(current.candidateId).toBe('pending_candidate');
    expect(current.xUserId).toBe('200');
    expect((await state())[0].data!.xPostEnabled).toBe(false);
    expect(decrypt(current.encryptedAccessToken, KEY, { uid, purpose: 'accessToken' }))
      .toBe('synthetic-pending-access');
  });

  it('19 all writes reject deletion markers or missing parents/tokens without recreation', async () => {
    const { expected, claimId } = await claimed();
    const ownedToken = (await tokenRef().get()).data()!;
    for (const condition of ['deleting', 'root-missing', 'token-missing']) {
      await userRef().set(initialUser);
      await tokenRef().set(ownedToken);
      if (condition === 'deleting') await userRef().update({ deletionInProgress: true });
      if (condition === 'root-missing') await userRef().delete();
      if (condition === 'token-missing') await tokenRef().delete();
      const before = await state();
      for (const operation of writes(store(), expected, claimId)) {
        await unchanged(operation(), before);
      }
    }
  });

  it('20 rejects unsafe uid/claimId and invalid ttl before any persistence', async () => {
    const expected = await snapshot();
    const before = await state();
    for (const badUid of ['', '.', '..', '../other', '__reserved__', 'a'.repeat(129), '\ud800']) {
      await unchanged(store().read(badUid), before);
      await unchanged(store().claimRefresh(badUid, expected, randomUUID(), TTL), before);
    }
    for (const id of ['', ' ', '../claim', 'a/b', 'a.b', '__reserved__', 'a'.repeat(1501), '\ud800']) {
      await unchanged(store().claimRefresh(uid, expected, id, TTL), before);
      await unchanged(store().saveRefresh(uid, expected, id, tokens()), before);
      await unchanged(store().blockRefresh(uid, expected, id), before);
      await unchanged(store().releaseRefresh(uid, expected, id), before);
    }
    for (const ttl of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await unchanged(store().claimRefresh(uid, expected, randomUUID(), ttl), before);
    }
    time = MAX_TIMESTAMP_MS;
    await unchanged(store().claimRefresh(uid, expected, randomUUID(), 1), before);
  });

  it('21 validates TokenResult compatibly and retains the claim after rejected results', async () => {
    const { expected, claimId } = await claimed();
    const patches: Record<string, unknown>[] = [
      { accessToken: '' }, { accessToken: ' ' }, { accessToken: '\ud800' },
      { refreshToken: '' }, { refreshToken: ' ' }, { refreshToken: '\ud800' },
      { tokenType: 'bearer' }, { tokenType: 'Basic' },
      { scope: '' }, { scope: 'tweet.read tweet.write users.read' },
      { scope: 'tweet.read tweet.write users.read offline.access.extra' },
      { scope: `${SCOPE}\n` }, { scope: SCOPE.replace(' ', '  ') },
      { expiresIn: 0 }, { expiresIn: -1 }, { expiresIn: 0.5 },
      { expiresIn: NaN }, { expiresIn: Infinity }, { expiresIn: null },
      { expiresIn: Number.MAX_SAFE_INTEGER },
    ];
    const before = await state();
    for (const patch of patches) {
      await unchanged(store().saveRefresh(
        uid, expected, claimId, { ...tokens(), ...patch } as TokenResult,
      ), before);
    }
    expect(await store().saveRefresh(uid, expected, claimId, tokens({
      // A transport-normalized refresh fallback remains valid.
      refreshToken: OLD_REFRESH,
      scope: `${SCOPE} extra.scope`,
    }))).toBe('saved');
  });

  it('22 rejects invalid server clocks and refuses an owner save at claim expiry', async () => {
    const { expected, claimId } = await claimed();
    const before = await state();
    for (const badTime of [NaN, Infinity, 0.5, MAX_TIMESTAMP_MS + 1, -62135596800001]) {
      const invalid = store(db, () => badTime);
      await unchanged(invalid.claimRefresh(uid, expected, randomUUID(), TTL), before);
      await unchanged(invalid.saveRefresh(uid, expected, claimId, tokens()), before);
    }
    time = NOW + TTL;
    await unchanged(store().saveRefresh(uid, expected, claimId, tokens()), before);
    // A rejected save must not make the old credential available for another HTTP refresh.
    expect(await store().claimRefresh(uid, expected, randomUUID(), TTL)).toBe('blocked');
  });

  it('23 sanitizes encryption and transaction failures with atomic rollback', async () => {
    const { expected, claimId } = await claimed();
    const before = await state();
    const badKey: StoreContract = createActiveTokenStore({
      firestore: db, now: () => time, encryptionKey: 'synthetic-invalid-key',
    });
    await unchanged(badKey.saveRefresh(uid, expected, claimId, tokens()), before);
    // Real transaction callback runs and queues its writes, then fails before commit.
    const failingDb = {
      doc: db.doc.bind(db),
      runTransaction: async <T>(body: (tx: Transaction) => Promise<T>): Promise<T> =>
        db.runTransaction(async (tx) => {
          await body(tx);
          throw new Error('synthetic-private-backend-detail');
        }),
    } as unknown as Firestore;
    await unchanged(store(failingDb).saveRefresh(uid, expected, claimId, tokens()), before);
    expect(await store().saveRefresh(uid, expected, claimId, tokens())).toBe('saved');
  });

  it('24 every Store write reads its writable parent in the same transaction and uses update only', async () => {
    const traces: { reads: string[]; updates: string[]; forbidden: string[] }[] = [];
    const auditedDb = {
      doc: db.doc.bind(db),
      runTransaction: async <T>(body: (tx: Transaction) => Promise<T>): Promise<T> =>
        db.runTransaction(async (tx) => {
          const trace = { reads: [] as string[], updates: [] as string[], forbidden: [] as string[] };
          traces.push(trace);
          const get = tx.get.bind(tx);
          const update = tx.update.bind(tx);
          const proxy = new Proxy(tx, {
            get(target, property) {
              if (property === 'get') {
                return (ref: Parameters<Transaction['get']>[0]) => {
                  trace.reads.push('path' in ref ? String(ref.path) : 'non-document');
                  return get(ref);
                };
              }
              if (property === 'update') {
                return (...args: Parameters<Transaction['update']>) => {
                  trace.updates.push(args[0].path);
                  expect(trace.reads).toContain(userRef().path);
                  return update(...args);
                };
              }
              if (property === 'create' || property === 'set' || property === 'delete') {
                return () => {
                  trace.forbidden.push(String(property));
                  throw new Error('Store must update existing token documents only');
                };
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return body(proxy);
        }),
    } as unknown as Firestore;
    const s = store(auditedDb);
    const expected = await snapshot();
    const firstId = randomUUID();
    await s.claimRefresh(uid, expected, firstId, TTL);
    await s.releaseRefresh(uid, expected, firstId);
    const secondId = randomUUID();
    await s.claimRefresh(uid, expected, secondId, TTL);
    await s.saveRefresh(uid, expected, secondId, tokens());
    const current = await snapshot();
    const thirdId = randomUUID();
    await s.claimRefresh(uid, current, thirdId, TTL);
    await s.blockRefresh(uid, current, thirdId);
    const writing = traces.filter((trace) => trace.updates.length > 0);
    expect(writing).toHaveLength(6);
    for (const trace of traces) {
      expect(trace.forbidden).toEqual([]);
      expect(trace.reads).toContain(userRef().path);
      expect(trace.reads).toContain(tokenRef().path);
      expect(trace.updates.every((path) => path === tokenRef().path)).toBe(true);
    }
    const root = await userRef().get();
    expect(root.data()).toEqual(initialUser);
    expect((await userRef().collection('judgementHistory').get()).empty).toBe(true);
  });
});
