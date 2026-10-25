import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  FieldValue, getFirestore, Timestamp,
  type DocumentReference, type Firestore, type Query, type Transaction,
} from 'firebase-admin/firestore';

import type { JudgementSnapshots, JudgementStream } from '../../../../shared/judgementHistory';
import { AccountWriteBlockedError } from '../../account/accountWriteGuard';
import { initializeHistory, InitializeHistoryError } from '../initializeHistory';

// 未設定/本番接続はskipせず、Admin SDKでデータに触れる前に停止する。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('initializeHistory tests require local demo-gokaku Firestore Emulator');
}
const app = initializeApp({ projectId: 'demo-gokaku' }, `initialize-history-${randomUUID()}`);
const db = getFirestore(app);
const streams = ['goal', 'settings', 'xLink', 'subscription'] as const;
const counters = () => ({ goal: 1, settings: 1, xLink: 1, subscription: 1 });
const goal = {
  startDate: '2026-10-01', examDate: '2026-12-01',
  minDailyMinutes: 60, goalDailyMinutes: 120,
  title: 'fixture goal', privateExtra: 'fixture-only-goal-extra',
};
const current = () => ({
  activeGoalId: 'active-goal', xPostEnabled: true, xLinked: true,
  subscription: {
    expiresAt: 1800000000000, status: 'active', signedTransaction: 'fixture-only-jws',
  },
  checkEnabled: true, encryptedAccessToken: 'fixture-only-token',
  displayName: 'fixture name', unrelated: { keep: true },
});
function collection(ref: DocumentReference, stream: JudgementStream) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}
function projection(): JudgementSnapshots {
  return {
    goal: {
      goalId: 'active-goal', startDate: goal.startDate, examDate: goal.examDate,
      minDailyMinutes: goal.minDailyMinutes, goalDailyMinutes: goal.goalDailyMinutes,
    },
    settings: { xPostEnabled: true }, xLink: { xLinked: true },
    subscription: { expiresAt: 1800000000000 },
  };
}

// runTransactionだけを装飾し、すべての読取/commit/retryは実Admin SDKへ渡す。
function decoratedDb(
  body: (tx: Transaction, run: () => Promise<unknown>) => Promise<unknown>,
): Firestore {
  return {
    doc: db.doc.bind(db),
    runTransaction: (callback: (tx: Transaction) => Promise<unknown>) =>
      db.runTransaction((tx) => body(tx, () => callback(tx))),
  } as unknown as Firestore;
}

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe('initializeHistory server core / real Firestore Emulator', () => {
  let ref: DocumentReference;
  beforeEach(async () => {
    ref = db.doc(`users/initialize-history-${randomUUID()}`);
    await ref.set(current());
    await ref.collection('goals').doc('active-goal').set(goal);
  });
  afterEach(async () => {
    // beforeEach/期待assertion失敗時もtest固有の子孫だけを削除する。
    if (ref) await db.recursiveDelete(ref);
  });
  const run = (store = db) => initializeHistory(store, ref.id);
  async function dump() {
    const root = await ref.get();
    return {
      exists: root.exists, root: root.data(), updateTime: root.updateTime,
      streams: await Promise.all(streams.map(async (stream) => {
        const result = await collection(ref, stream).get();
        return result.docs.map((doc) => ({
          id: doc.id, data: doc.data(), updateTime: doc.updateTime,
        }));
      })),
    };
  }
  async function rejectUnchanged(expectedError = InitializeHistoryError) {
    const before = await dump();
    await expect(run()).rejects.toBeInstanceOf(expectedError);
    expect(await dump()).toEqual(before);
  }

  test('現在値の最小4baseline/正規ID1/counter1/開始時刻を同一server commitで作る', async () => {
    const previous = (await ref.get()).updateTime!;
    expect(await run()).toEqual({ status: 'initialized' });
    const saved = await ref.get();
    const started = saved.get('judgementHistoryStartedAt') as Timestamp;
    expect(started).toBeInstanceOf(Timestamp);
    // REQUEST_TIMEと文書updateTimeは別の時刻。以下で各時刻同士を比較する。
    expect(saved.updateTime).toBeInstanceOf(Timestamp);
    expect(started.toMillis()).toBeGreaterThanOrEqual(previous.toMillis());
    expect(saved.data()).toEqual({
      ...current(), judgementRevisions: counters(), judgementHistoryStartedAt: started,
    });
    const expected = projection();
    for (const stream of streams) {
      const result = await collection(ref, stream).get();
      expect(result.docs.map((doc) => doc.id)).toEqual(['1']);
      const entry = result.docs[0];
      const committedAt = entry.get('committedAt') as Timestamp;
      expect(committedAt).toBeInstanceOf(Timestamp);
      expect(committedAt.isEqual(started)).toBe(true);
      expect(entry.data()).toEqual({
        schemaVersion: 1, revision: 1, committedAt: started,
        before: expected[stream], after: expected[stream],
      });
      expect(entry.updateTime.isEqual(saved.updateTime!)).toBe(true);
      expect(JSON.stringify(entry.data())).not.toMatch(/fixture-only|signedTransaction|encryptedAccessToken/);
    }
    expect((await ref.collection('goals').doc('active-goal').get()).data()).toEqual(goal);
  });

  test.each([{}, { activeGoalId: null }])('legacy欠落3項目だけを根userにも保存しgoalなしをnullにする: %p', async (pointer) => {
    await ref.set({ ...pointer, unrelated: { keep: true } });
    expect(await run()).toEqual({ status: 'initialized' });
    expect((await ref.get()).data()).toEqual({
      ...pointer, unrelated: { keep: true },
      xPostEnabled: false, xLinked: false, subscription: null,
      judgementRevisions: counters(), judgementHistoryStartedAt: expect.any(Timestamp),
    });
    const expected: JudgementSnapshots = {
      goal: null, settings: { xPostEnabled: false }, xLink: { xLinked: false }, subscription: null,
    };
    for (const stream of streams) {
      const saved = (await collection(ref, stream).doc('1').get()).data()!;
      expect(saved.before).toEqual(expected[stream]);
      expect(saved.after).toEqual(expected[stream]);
    }
  });

  test('正常なfalse/null/期限nullを保持し欠落だけを補完する', async () => {
    await ref.set({ xPostEnabled: false, subscription: { expiresAt: null, keep: 'value' } });
    await run();
    expect((await ref.get()).data()).toMatchObject({
      xPostEnabled: false, xLinked: false, subscription: { expiresAt: null, keep: 'value' },
    });
    expect((await collection(ref, 'subscription').doc('1').get()).get('after'))
      .toEqual({ expiresAt: null });
  });

  test.each([
    { xPostEnabled: null }, { xLinked: 'false' }, { subscription: {} },
    { subscription: { expiresAt: '1800000000000' } },
    { subscription: { expiresAt: Number.POSITIVE_INFINITY } },
  ])('保存済み不正値を初期値へ補完せず全体拒否: %p', async (patch) => {
    await ref.update(patch);
    await rejectUnchanged();
  });

  test.each(['', ' ', '/', 'other/path', '.', '..', '__reserved__', 42])(
    '不正activeGoalIdをnullへ変換せず拒否: %p', async (activeGoalId) => {
      await ref.update({ activeGoalId });
      await rejectUnchanged();
    },
  );

  test('実goal欠落/不正projectionは拒否し別goalを参照しない', async () => {
    await ref.update({ activeGoalId: 'not-present' });
    await rejectUnchanged();
    await ref.collection('goals').doc('not-present').set({ ...goal, startDate: 'bad-date' });
    await rejectUnchanged();
  });

  test('metadata両absentでも各streamのentries.limit(1)を同じtxで読み、write前に完了する', async () => {
    const queries = streams.map((stream) => collection(ref, stream).limit(1));
    const seen = new Set<number>();
    let writes = false;
    const store = decoratedDb(async (tx, execute) => {
      const get = tx.get.bind(tx);
      jest.spyOn(tx, 'get').mockImplementation(((target: DocumentReference | Query) => {
        expect(writes).toBe(false);
        if (!('path' in target)) {
          const index = queries.findIndex((query) => query.isEqual(target as Query));
          expect(index).toBeGreaterThanOrEqual(0);
          seen.add(index);
        }
        return get(target as DocumentReference);
      }) as typeof tx.get);
      const update = tx.update.bind(tx);
      jest.spyOn(tx, 'update').mockImplementation(((...args: Parameters<typeof tx.update>) => {
        expect(seen.size).toBe(4);
        writes = true;
        return update(...args);
      }) as typeof tx.update);
      const create = tx.create.bind(tx);
      jest.spyOn(tx, 'create').mockImplementation(((...args: Parameters<typeof tx.create>) => {
        expect(seen.size).toBe(4);
        writes = true;
        expect(args[0].id).toBe('1');
        return create(...args);
      }) as typeof tx.create);
      return execute();
    });
    await run(store);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(writes).toBe(true);
  });

  test.each(streams)('metadata absentの%s孤立entryは任意ID/内容でも拒否し上書きしない', async (stream) => {
    await collection(ref, stream).doc('arbitrary-orphan').set({ malformed: true });
    await rejectUnchanged();
  });

  test('初期化済みは書込みを登録せずalreadyInitializedで開始時刻/全entry不変', async () => {
    await run();
    const before = await dump();
    const store = decoratedDb(async (tx, execute) => {
      const forbidden = () => { throw new Error('alreadyInitialized must not write'); };
      jest.spyOn(tx, 'update').mockImplementation(forbidden);
      jest.spyOn(tx, 'create').mockImplementation(forbidden);
      jest.spyOn(tx, 'set').mockImplementation(forbidden);
      jest.spyOn(tx, 'delete').mockImplementation(forbidden);
      return execute();
    });
    expect(await run(store)).toEqual({ status: 'alreadyInitialized' });
    expect(await dump()).toEqual(before);
  });

  test('counter>1は現在counterのentryと現在値で検証しbaselineへ巻き戻さない', async () => {
    await run();
    const baseline = (await collection(ref, 'settings').doc('1').get()).data()!;
    const tx = db.batch();
    tx.update(ref, { xPostEnabled: false, 'judgementRevisions.settings': 2 });
    tx.create(collection(ref, 'settings').doc('2'), {
      schemaVersion: 1, revision: 2, committedAt: FieldValue.serverTimestamp(),
      before: baseline.after, after: { xPostEnabled: false },
    });
    await tx.commit();
    const before = await dump();
    expect(await run()).toEqual({ status: 'alreadyInitialized' });
    expect(await dump()).toEqual(before);
  });

  test.each([
    { judgementHistoryStartedAt: new Timestamp(100, 0) },
    { judgementRevisions: counters() },
    { judgementHistoryStartedAt: null, judgementRevisions: counters() },
    { judgementHistoryStartedAt: { seconds: 100, nanoseconds: 0 }, judgementRevisions: counters() },
  ])('部分metadata/SDK Timestamp以外を修復せず拒否: %p', async (metadata) => {
    await ref.update(metadata);
    await rejectUnchanged();
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    '初期化済みcounterが不正なら拒否: %p', async (counter) => {
      await run();
      await ref.update({ 'judgementRevisions.goal': counter });
      await rejectUnchanged();
    },
  );

  test.each(['goal', 'extra'] as const)('counterの欠落/余計キーを拒否: %s', async (key) => {
    await run();
    const revisions: Record<string, number> = counters();
    if (key === 'goal') delete revisions.goal;
    else revisions.extra = 1;
    await ref.update({ judgementRevisions: revisions });
    await rejectUnchanged();
  });

  test.each(streams)('初期化後の%s current entry欠落はrepairしない', async (stream) => {
    await run();
    await collection(ref, stream).doc('1').delete();
    await rejectUnchanged();
  });

  test('ID01は正規ID1の代わりにしない', async () => {
    await run();
    const one = collection(ref, 'settings').doc('1');
    await collection(ref, 'settings').doc('01').set((await one.get()).data()!);
    await one.delete();
    await rejectUnchanged();
  });

  test.each([
    { revision: 2 }, { schemaVersion: 2 }, { after: { xPostEnabled: false } },
    { before: { xPostEnabled: false } },
    { committedAt: { seconds: 100, nanoseconds: 0 } },
    { committedAt: new Timestamp(100, 0) }, { extra: 'fixture-only-extra' },
  ])('baseline不一致/不正entryはrepairせず拒否: %p', async (patch) => {
    await run();
    await collection(ref, 'settings').doc('1').update(patch);
    await rejectUnchanged();
  });

  test.each(['xPostEnabled', 'xLinked', 'subscription'])('初期化後の%s欠落を初期値へ戻さない', async (key) => {
    await run();
    await ref.update({ [key]: FieldValue.delete() });
    await rejectUnchanged();
  });

  test('初期化後のgoal現在値不一致も拒否', async () => {
    await run();
    await ref.collection('goals').doc('active-goal').update({ minDailyMinutes: 90 });
    await rejectUnchanged();
  });

  test.each(['missing', 'deleting'] as const)('getWritableAccountで%sを拒否し親を再作成しない', async (reason) => {
    if (reason === 'missing') await ref.delete();
    else await ref.update({ deletionInProgress: true });
    const before = await dump();
    const failure: unknown = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountWriteBlockedError);
    expect(failure).toMatchObject({ name: 'AccountWriteBlockedError', reason });
    expect(await dump()).toEqual(before);
  });

  test('同時初期化は一方だけ作成し他方は再読取して冪等終了', async () => {
    const results = await Promise.all([run(), run()]);
    expect(results.map((result) => result.status).sort())
      .toEqual(['alreadyInitialized', 'initialized']);
    const state = await dump();
    expect(state.root!.judgementRevisions).toEqual(counters());
    expect(state.streams.map((docs) => docs.map((doc) => doc.id)))
      .toEqual([['1'], ['1'], ['1'], ['1']]);
  });

  test('SDKのABORTED再試行でuser/実goalを再読取し後日の変更をbaselineへ反映する', async () => {
    let attempts = 0;
    const store = decoratedDb(async (_tx, execute) => {
      attempts += 1;
      if (attempts === 2) {
        // 最初のtransactionはabort済み。lockを保持したまま別writerを待たない。
        await ref.update({ xPostEnabled: false, unrelated: { keep: 'edited' } });
        await ref.collection('goals').doc('active-goal').update({ minDailyMinutes: 90 });
      }
      const result = await execute();
      if (attempts === 1) throw Object.assign(new Error('injected abort'), { code: 10 });
      return result;
    });
    expect(await run(store)).toEqual({ status: 'initialized' });
    expect(attempts).toBe(2);
    expect((await collection(ref, 'goal').doc('1').get()).get('after.minDailyMinutes')).toBe(90);
    expect((await collection(ref, 'settings').doc('1').get()).get('after.xPostEnabled')).toBe(false);
    expect((await ref.get()).get('unrelated')).toEqual({ keep: 'edited' });
  });

  test.each(['missing', 'deleting'] as const)('retry時も%sを再確認し初回の書込みを持ち越さない', async (reason) => {
    let attempts = 0;
    const store = decoratedDb(async (_tx, execute) => {
      attempts += 1;
      if (attempts === 2) {
        if (reason === 'missing') await ref.delete();
        else await ref.update({ deletionInProgress: true });
      }
      const result = await execute();
      if (attempts === 1) throw Object.assign(new Error('injected abort'), { code: 10 });
      return result;
    });
    await expect(run(store)).rejects.toMatchObject({ name: 'AccountWriteBlockedError', reason });
    expect(attempts).toBe(2);
    const saved = await dump();
    expect(saved.streams).toEqual([[], [], [], []]);
    if (reason === 'missing') expect(saved.exists).toBe(false);
    else expect(saved.root).toEqual({ ...current(), deletionInProgress: true });
  });

  test('commit時create衝突でroot初期値/metadata/4baselineが全rollback', async () => {
    await ref.set({ unrelated: { keep: true } });
    const occupied = ref.collection('testSentinels').doc('occupied');
    await occupied.create({ keep: true });
    const before = await dump();
    const store = decoratedDb(async (tx, execute) => {
      const result = await execute();
      // 製品のread検証とは独立したcommit失敗を同一txへ注入する。
      tx.create(occupied, { forbidden: true });
      return result;
    });
    await expect(run(store)).rejects.toMatchObject({ code: 6 });
    expect(await dump()).toEqual(before);
    expect((await occupied.get()).data()).toEqual({ keep: true });
  });
});
