import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FieldPath, getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

import { AccountWriteBlockedError } from '../../account/accountWriteGuard';
import { ensureAdminApp } from '../../firebaseAdmin';
import { RATE_LIMITS, rateLimitDocPath, RateLimitExceededError } from '../../rateLimit';
import { initializeHistory, InitializeHistoryError } from '../initializeHistory';
import {
  createProductionInitializeJudgementHistoryDeps,
  handleInitializeJudgementHistoryRequest,
  initializeJudgementHistory,
  type InitializeJudgementHistoryDeps,
} from '../initializeHistoryCallable';

// 本番接続や未設定はskipせず、Admin SDKの初期化前に停止する。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('initializeHistoryCallable tests require local demo-gokaku Firestore Emulator');
}

const MESSAGE = '処理を完了できませんでした。再度お試しください';
const PRECONDITION = '履歴を初期化できません';
const RATE_MESSAGE = '呼び出し回数の上限に達しました。しばらく待ってから再度お試しください';
const NOW = Date.UTC(2026, 9, 25, 12, 0, 1);
const streams = ['goal', 'settings', 'xLink', 'subscription'] as const;
function request(uid: string | undefined = 'caller', data: unknown = {}): Pick<CallableRequest<unknown>, 'auth' | 'data'> {
  return { auth: uid === undefined ? undefined : { uid, token: {} as NonNullable<CallableRequest['auth']>['token'], rawToken: 'fixture-only-token' }, data };
}
function mockDeps() {
  return {
    initializeHistory: jest.fn<ReturnType<InitializeJudgementHistoryDeps['initializeHistory']>, [string]>()
      .mockResolvedValue({ status: 'initialized' }),
    enforceRateLimit: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
}
async function expectError(pending: Promise<unknown>, code: string, message: string, details?: unknown) {
  const error: unknown = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect(error).toMatchObject({ code, message });
  expect((error as HttpsError).details).toEqual(details);
  expect((error as HttpsError).toJSON()).toEqual({
    status: code.toUpperCase().replace(/-/g, '_'), message,
    ...(details === undefined ? {} : { details }),
  });
}

describe('history initialization authenticated boundary / DI', () => {
  test.each([undefined, '', ' ', 'a/b', '.', '..', '__reserved__', 'x'.repeat(129), '\u0000', '\ud800'])(
    'invalid auth UID never reaches dependencies: %p', async (uid) => {
      const deps = mockDeps();
      // default引数によるundefined置換を避け、未認証も明示する。
      const input = request('caller');
      input.auth = uid === undefined ? undefined : { ...input.auth!, uid };
      await expectError(handleInitializeJudgementHistoryRequest(input, deps), 'unauthenticated', 'ログインが必要です');
      expect(deps.enforceRateLimit).not.toHaveBeenCalled();
      expect(deps.initializeHistory).not.toHaveBeenCalled();
    },
  );
  test.each(['initialized', 'alreadyInitialized'] as const)('auth.uid only, ordered rate check, minimal result: %s', async (status) => {
    const deps = mockDeps();
    deps.initializeHistory.mockResolvedValue({ status, rawDoc: 'fixture-private' } as { status: typeof status });
    expect(await handleInitializeJudgementHistoryRequest(request('本人-uid'), deps)).toEqual({ status });
    expect(deps.enforceRateLimit.mock.calls).toEqual([['本人-uid']]);
    expect(deps.initializeHistory.mock.calls).toEqual([['本人-uid']]);
    expect(deps.enforceRateLimit.mock.invocationCallOrder[0])
      .toBeLessThan(deps.initializeHistory.mock.invocationCallOrder[0]);
  });
  test('empty null-prototype record is accepted', async () => {
    const deps = mockDeps();
    await expect(handleInitializeJudgementHistoryRequest(request('caller', Object.create(null)), deps))
      .resolves.toEqual({ status: 'initialized' });
  });
  const invalidPayloads: unknown[] = [
    null, undefined, [], '', 'x'.repeat(1024 * 1024), 0, false,
    { uid: 'victim' }, { expectedUid: 'caller' }, { auth: { uid: 'victim' } },
    { now: NOW }, { time: NOW }, { committedAt: NOW }, { judgementHistoryStartedAt: NOW },
    { defaults: {} }, { baseline: {} }, { judgementRevisions: {} },
    { xPostEnabled: true }, { xLinked: true }, { subscription: null }, { activeGoalId: null },
    { data: {} }, { ['x'.repeat(1024 * 1024)]: true },
    Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`key${i}`, i])),
    new Date(NOW), Object.create({ uid: 'victim' }),
    Object.defineProperty({}, 'uid', { value: 'victim', enumerable: false }),
    { [Symbol('uid')]: 'victim' }, JSON.parse('{"__proto__":{"uid":"victim"}}'),
  ];
  test.each(invalidPayloads.map((payload, index) => [index, payload] as const))(
    'reject nonempty/nonrecord payload without initialization, including oversized input: %s', async (_index, data) => {
      const deps = mockDeps();
      const input = request('caller');
      input.data = data;
      await expectError(handleInitializeJudgementHistoryRequest(input, deps), 'invalid-argument', '入力が不正です');
      expect(deps.enforceRateLimit.mock.calls).toEqual([['caller']]);
      expect(deps.initializeHistory).not.toHaveBeenCalled();
    },
  );
  test('payload getter is not evaluated', async () => {
    const getter = jest.fn(() => { throw new Error('fixture-private'); });
    const deps = mockDeps();
    await expectError(handleInitializeJudgementHistoryRequest(
      request('caller', Object.defineProperty({}, 'uid', { get: getter })), deps,
    ), 'invalid-argument', '入力が不正です');
    expect(getter).not.toHaveBeenCalled();
    expect(deps.initializeHistory).not.toHaveBeenCalled();
  });
  test.each(['limit', 'initialize'] as const)('SDK and unexpected HttpsError details are hidden: %s', async (phase) => {
    for (const failure of [new Error('fixture-private-sdk'), new HttpsError('permission-denied', 'fixture-private', { rawDoc: 'fixture-private' })]) {
      const deps = mockDeps();
      if (phase === 'limit') deps.enforceRateLimit.mockRejectedValue(failure);
      else deps.initializeHistory.mockRejectedValue(failure);
      await expectError(handleInitializeJudgementHistoryRequest(request(), deps), 'internal', MESSAGE);
      if (phase === 'limit') expect(deps.initializeHistory).not.toHaveBeenCalled();
    }
  });
  test.each(['missing', 'deleting'] as const)('account guard errors are fixed and private: %s', async (reason) => {
    for (const phase of ['limit', 'initialize']) {
      const deps = mockDeps();
      deps[phase === 'limit' ? 'enforceRateLimit' : 'initializeHistory']
        .mockRejectedValue(new AccountWriteBlockedError(reason));
      await expectError(handleInitializeJudgementHistoryRequest(request(), deps), 'failed-precondition', PRECONDITION);
    }
  });
  test('invalid history is a fixed precondition error', async () => {
    const deps = mockDeps();
    deps.initializeHistory.mockRejectedValue(new InitializeHistoryError());
    await expectError(handleInitializeJudgementHistoryRequest(request(), deps), 'failed-precondition', PRECONDITION);
  });
  test('rate limit is fixed even if thrown message was changed; core is not called', async () => {
    const deps = mockDeps();
    const error = new RateLimitExceededError('history-initialize');
    error.message = 'fixture-private';
    deps.enforceRateLimit.mockRejectedValue(error);
    await expectError(handleInitializeJudgementHistoryRequest(request(), deps), 'resource-exhausted', RATE_MESSAGE, { reason: 'rate-limited' });
    expect(deps.initializeHistory).not.toHaveBeenCalled();
  });
  test('public function uses Tokyo, exports only the public callable, and runs auth guard', async () => {
    expect(initializeJudgementHistory.__endpoint.region).toEqual(['asia-northeast1']);
    const index = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
    expect(index).toContain("export { initializeJudgementHistory } from './dailyJudgement/initializeHistoryCallable';");
    await expectError(initializeJudgementHistory.run({ data: {} } as CallableRequest<unknown>), 'unauthenticated', 'ログインが必要です');
  });
});

describe('history initialization production factory / real Firestore Emulator', () => {
  const ownedUids = new Set<string>();
  const db = () => { ensureAdminApp(); return getFirestore(); };
  async function user(data: Record<string, unknown> = {}): Promise<DocumentReference> {
    const uid = `history-callable-${randomUUID()}`;
    ownedUids.add(uid);
    const ref = db().doc(`users/${uid}`);
    await ref.create(data);
    return ref;
  }
  const deps = (now = NOW) => createProductionInitializeJudgementHistoryDeps({ now: () => now });
  const run = (uid: string, data: unknown = {}, now = NOW) =>
    handleInitializeJudgementHistoryRequest(request(uid, data), deps(now));
  async function dump(ref: DocumentReference) {
    const root = await ref.get();
    return {
      data: root.data(), updateTime: root.updateTime,
      streams: await Promise.all(streams.map(async (stream) => {
        const result = await ref.collection('judgementHistory').doc(stream).collection('entries').get();
        return result.docs.map((entry) => ({ id: entry.id, data: entry.data(), updateTime: entry.updateTime }));
      })),
    };
  }
  afterEach(async () => {
    try {
      await Promise.all([...ownedUids].map(async (uid) => {
        // user固有prefixのみ。失敗時も子孫と全minuteのcounterを片付ける。
        const counters = await db().collection('rateLimits')
          .where(FieldPath.documentId(), '>=', `${uid}_`)
          .where(FieldPath.documentId(), '<', `${uid}_\uf8ff`).get();
        await Promise.all([
          db().recursiveDelete(db().doc(`users/${uid}`)),
          ...counters.docs.map((entry) => entry.ref.delete()),
        ]);
      }));
    } finally { ownedUids.clear(); }
  });
  test('existing user only: defaults, four baselines and retry preserve committed history', async () => {
    const ref = await user({ privateExtra: 'fixture-private' });
    expect(await run(ref.id)).toEqual({ status: 'initialized' });
    const saved = await dump(ref);
    expect(saved.data).toEqual({
      privateExtra: 'fixture-private', xPostEnabled: false, xLinked: false, subscription: null,
      judgementHistoryStartedAt: expect.any(Timestamp),
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    });
    const expected = [null, { xPostEnabled: false }, { xLinked: false }, null];
    saved.streams.forEach((entries, i) => {
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('1');
      expect(entries[0].data).toEqual({
        schemaVersion: 1, revision: 1, committedAt: saved.data!.judgementHistoryStartedAt,
        before: expected[i], after: expected[i],
      });
      expect(entries[0].updateTime).toEqual(saved.updateTime);
    });
    expect(await run(ref.id)).toEqual({ status: 'alreadyInitialized' });
    expect(await dump(ref)).toEqual(saved);
    expect((await db().doc(rateLimitDocPath(ref.id, 'history-initialize', NOW)).get()).get('count')).toBe(2);
  });
  test('simultaneous requests create one baseline and return initialized/alreadyInitialized', async () => {
    const ref = await user();
    const results = await Promise.all([run(ref.id), run(ref.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(['alreadyInitialized', 'initialized']);
    expect((await dump(ref)).streams.map((entries) => entries.length)).toEqual([1, 1, 1, 1]);
  });
  test('UID forgery leaves caller and victim unchanged', async () => {
    const ref = await user();
    const victim = await user({ privateExtra: 'fixture-victim' });
    const before = await dump(ref);
    const other = await dump(victim);
    await expectError(run(ref.id, { uid: victim.id }), 'invalid-argument', '入力が不正です');
    expect(await dump(ref)).toEqual(before);
    expect(await dump(victim)).toEqual(other);
    expect((await db().doc(rateLimitDocPath(victim.id, 'history-initialize', NOW)).get()).exists).toBe(false);
  });
  test.each(['missing', 'deleting'] as const)('initial rate transaction refuses %s without creating counter or history', async (state) => {
    const ref = await user();
    if (state === 'missing') await ref.delete();
    else await ref.update({ deletionInProgress: true });
    const before = await dump(ref);
    await expectError(run(ref.id), 'failed-precondition', PRECONDITION);
    expect(await dump(ref)).toEqual(before);
    expect((await db().doc(rateLimitDocPath(ref.id, 'history-initialize', NOW)).get()).exists).toBe(false);
  });
  test.each(['missing', 'deleting'] as const)('core rechecks %s after rate limit succeeded', async (state) => {
    const ref = await user();
    const production = deps();
    const delayed: InitializeJudgementHistoryDeps = {
      ...production,
      initializeHistory: async (uid) => {
        if (state === 'missing') await ref.delete();
        else await ref.update({ deletionInProgress: true });
        return initializeHistory(db(), uid);
      },
    };
    await expectError(handleInitializeJudgementHistoryRequest(request(ref.id), delayed), 'failed-precondition', PRECONDITION);
    const after = await dump(ref);
    expect(after.data).toEqual(state === 'missing' ? undefined : { deletionInProgress: true });
    expect(after.streams).toEqual([[], [], [], []]);
  });
  test.each(['partial-metadata', 'bad-state', 'orphan', 'missing-entry'] as const)('invalid history is not repaired or exposed: %s', async (kind) => {
    const ref = await user();
    if (kind === 'partial-metadata') await ref.update({ judgementRevisions: { goal: 1 } });
    if (kind === 'bad-state') await ref.update({ xPostEnabled: 'fixture-private-invalid' });
    if (kind === 'orphan') await ref.collection('judgementHistory').doc('goal').collection('entries').doc('arbitrary').create({ privateExtra: 'fixture-private' });
    if (kind === 'missing-entry') {
      await run(ref.id);
      await ref.collection('judgementHistory').doc('settings').collection('entries').doc('1').delete();
    }
    const before = await dump(ref);
    await expectError(run(ref.id), 'failed-precondition', PRECONDITION);
    expect(await dump(ref)).toEqual(before);
  });
  test('history kind is 10/min; existing kind limits remain 60/10', async () => {
    expect(RATE_LIMITS).toEqual({ 'study-event': 60, 'purchase-verify': 10, 'history-initialize': 10 });
    const ref = await user();
    const other = await user();
    for (let i = 0; i < 10; i += 1) await run(ref.id);
    const before = await dump(ref);
    await expectError(run(ref.id), 'resource-exhausted', RATE_MESSAGE, { reason: 'rate-limited' });
    const counter = await db().doc(rateLimitDocPath(ref.id, 'history-initialize', NOW)).get();
    expect(counter.get('count')).toBe(10);
    expect(counter.get('expireAt')).toEqual(Timestamp.fromMillis(Math.floor(NOW / 60000) * 60000 + 360000));
    expect(await dump(ref)).toEqual(before);
    expect(await run(other.id)).toEqual({ status: 'initialized' });
    expect(await run(ref.id, {}, NOW + 60000)).toEqual({ status: 'alreadyInitialized' });
    expect(await dump(ref)).toEqual(before);
    expect((await db().doc(rateLimitDocPath(ref.id, 'study-event', NOW)).get()).exists).toBe(false);
    expect((await db().doc(rateLimitDocPath(ref.id, 'purchase-verify', NOW)).get()).exists).toBe(false);
  });
  test('invalid payload attempts consume quota before validation and cannot initialize', async () => {
    const ref = await user();
    for (let i = 0; i < 10; i += 1) {
      await expectError(run(ref.id, { now: NOW }), 'invalid-argument', '入力が不正です');
    }
    await expectError(run(ref.id), 'resource-exhausted', RATE_MESSAGE, { reason: 'rate-limited' });
    expect((await dump(ref)).streams).toEqual([[], [], [], []]);
    expect((await ref.get()).data()).toEqual({});
  });
});
