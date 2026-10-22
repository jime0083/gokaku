import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp,
  type DocumentReference, type Query, type Transaction,
} from 'firebase-admin/firestore';

import type { JudgementSnapshots, JudgementStream } from '../../../../shared/judgementHistory';
import { JudgementHistoryReadError, readJudgementHistory } from '../historyReader';

// Emulator未設定をskipへ変えない。本番への接続前に必ず停止する。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(
    process.env.FIRESTORE_EMULATOR_HOST ?? '',
  )
) {
  throw new Error('historyReader tests require local demo-gokaku Firestore Emulator');
}

const app = initializeApp({ projectId: 'demo-gokaku' }, `history-reader-${randomUUID()}`);
const db = getFirestore(app);
const streams: JudgementStream[] = ['goal', 'settings', 'xLink', 'subscription'];
const start = new Timestamp(100, 0);
const cutoff = new Timestamp(200, 500000);
const goal = {
  goalId: 'historical-goal',
  startDate: '2026-10-01',
  examDate: '2026-12-01',
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
};
const values: JudgementSnapshots = {
  goal,
  settings: { xPostEnabled: true },
  xLink: { xLinked: true },
  subscription: { expiresAt: 300000 },
};
const counters = () => ({ goal: 1, settings: 1, xLink: 1, subscription: 1 });
const parent = () => ({
  judgementHistoryStartedAt: start,
  judgementRevisions: counters(),
  // 現在値は履歴の代用にしてはならない。
  activeGoalId: 'current-decoy',
  xPostEnabled: false,
  xLinked: false,
  subscription: null,
});
function entry(
  stream: JudgementStream,
  revision = 1,
  committedAt = start,
  before: unknown = values[stream],
  after: unknown = values[stream],
) {
  return { schemaVersion: 1, revision, committedAt, before, after };
}
function entries(ref: DocumentReference, stream: JudgementStream) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}
function queries(ref: DocumentReference, at: Timestamp) {
  return streams.flatMap((stream) => [
    {
      stream, before: true,
      query: entries(ref, stream).where('committedAt', '<', at)
        .orderBy('committedAt', 'desc').orderBy('revision', 'desc').limit(1),
    },
    {
      stream, before: false,
      query: entries(ref, stream).where('committedAt', '>=', at)
        .orderBy('committedAt', 'asc').orderBy('revision', 'asc').limit(1),
    },
  ]);
}
function expectedAvailable(subscription: JudgementSnapshots['subscription'] = values.subscription) {
  const { goalId, ...snapshot } = goal;
  return {
    status: 'available',
    goalId,
    goal: snapshot,
    user: { subscription, xPostEnabled: true, xLinked: true },
  };
}

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe('historyReader transaction contract', () => {
  test('渡されたtxだけで親と8本のbounded queryを読み、1ns差を保持する', async () => {
    const ref = db.doc(`users/history-unit-${randomUUID()}`);
    const at = new Timestamp(200, 500001);
    const previous = new Timestamp(200, 500000);
    const expected = queries(ref, at);
    const metadata = parent();
    metadata.judgementRevisions.goal = 3;
    const changed = { ...goal, minDailyMinutes: 75 };
    const later = { ...goal, minDailyMinutes: 90 };
    const seen: number[] = [];
    const get = jest.fn(async (target: DocumentReference | Query) => {
      if ('path' in target && target.path === ref.path) {
        return {
          exists: true,
          data: () => metadata,
          get: (key: keyof typeof metadata) => metadata[key],
        };
      }
      const index = expected.findIndex(({ query }) => query.isEqual(target as Query));
      if (index < 0) throw new Error('Unexpected read outside bounded transaction');
      seen.push(index);
      const { stream, before } = expected[index];
      const data = stream === 'goal'
        ? (before
          ? entry(stream, 2, previous, goal, changed)
          : entry(stream, 3, at, changed, later))
        : (before ? entry(stream) : undefined);
      const docs = data === undefined ? [] : [{
        id: String(data.revision),
        ref: entries(ref, stream).doc(String(data.revision)),
        data: () => data,
        get: (key: keyof typeof data) => data[key],
      }];
      return { docs, empty: docs.length === 0, size: docs.length };
    });
    const tx = { get } as unknown as Transaction;
    const millis = jest.spyOn(Timestamp.prototype, 'toMillis')
      .mockImplementation(() => { throw new Error('Timestamp precision loss'); });
    try {
      const result = await readJudgementHistory(tx, ref, at);
      expect(result).toEqual({
        ...expectedAvailable(),
        goal: {
          startDate: goal.startDate,
          examDate: goal.examDate,
          minDailyMinutes: 75,
          goalDailyMinutes: 120,
        },
      });
      expect(get).toHaveBeenCalledTimes(9);
      expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(millis).not.toHaveBeenCalled();
    } finally {
      millis.mockRestore();
    }
  });

  test.each([
    '', 'goals/other', 'users/u/goals/g', 'users/../other',
    'users/__reserved__', `users/${'x'.repeat(129)}`, 'users/\ud800',
  ])('所有userパス以外を読取前に拒否する: %p', async (path) => {
    const get = jest.fn();
    const tx = { get } as unknown as Transaction;
    await expect(readJudgementHistory(
      tx, { path } as DocumentReference, cutoff,
    )).rejects.toBeInstanceOf(JudgementHistoryReadError);
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    null, undefined, 200000,
    { seconds: 200, nanoseconds: 500000 },
    new Date(200000),
  ])('SDK Timestamp以外のcutoffを拒否する: %p', async (at) => {
    const get = jest.fn();
    await expect(readJudgementHistory(
      { get } as unknown as Transaction,
      db.doc(`users/history-invalid-${randomUUID()}`),
      at as Timestamp,
    )).rejects.toBeInstanceOf(JudgementHistoryReadError);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('historyReader real Firestore Emulator', () => {
  let ref: DocumentReference;

  beforeEach(async () => {
    ref = db.doc(`users/history-reader-${randomUUID()}`);
    const batch = db.batch();
    batch.set(ref, parent());
    for (const stream of streams) {
      batch.set(entries(ref, stream).doc('1'), entry(stream));
    }
    await batch.commit();
  });
  afterEach(async () => {
    // beforeEach/test途中失敗時も、このtest固有のuserだけを片付ける。
    if (ref) await db.recursiveDelete(ref);
  });
  function read(at = cutoff) {
    return db.runTransaction((tx) => readJudgementHistory(tx, ref, at));
  }

  test('履歴を判定入力へ復元し、現在値で上書きしない', async () => {
    expect(await read()).toEqual(expectedAvailable());
    expect((await ref.get()).data()).toEqual(parent());
  });

  test('親missingは孤立履歴があってもnoAccount、親を再作成しない', async () => {
    await ref.delete();
    expect(await read()).toEqual({ status: 'noAccount' });
    expect((await ref.get()).exists).toBe(false);
  });

  test('削除中は壊れたmetadataより先にdeletingとして扱う', async () => {
    await ref.set({ deletionInProgress: true, judgementRevisions: null });
    expect(await read()).toEqual({ status: 'deleting' });
    expect((await ref.get()).data()).toEqual({
      deletionInProgress: true, judgementRevisions: null,
    });
  });

  test('metadata両absentだけが履歴導入前', async () => {
    await ref.set({ activeGoalId: 'current-decoy' });
    expect(await read()).toEqual({ status: 'beforeCoverage' });
  });

  test.each([cutoff, new Timestamp(201, 0)])(
    '開始>=cutoffは導入前', async (startedAt) => {
      await ref.update({ judgementHistoryStartedAt: startedAt });
      expect(await read()).toEqual({ status: 'beforeCoverage' });
    },
  );

  test.each([
    { judgementHistoryStartedAt: start },
    { judgementRevisions: counters() },
    { judgementHistoryStartedAt: null, judgementRevisions: counters() },
    {
      judgementHistoryStartedAt: { seconds: 100, nanoseconds: 0 },
      judgementRevisions: counters(),
    },
    { judgementHistoryStartedAt: start, judgementRevisions: null },
    { judgementHistoryStartedAt: start, judgementRevisions: [] },
  ])('部分欠落・不正metadataを導入前へ変換しない: %p', async (data) => {
    await ref.set(data);
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test.each(streams)('%s counter欠落を拒否する', async (stream) => {
    const revisions: Record<string, number> = counters();
    delete revisions[stream];
    await ref.update({ judgementRevisions: revisions });
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'safe positive counter以外を拒否する: %p', async (value) => {
      await ref.update({ judgementRevisions: { ...counters(), settings: value } });
      await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
    },
  );

  test.each(streams)('%s履歴欠損を正常な不在へ変換しない', async (stream) => {
    await entries(ref, stream).doc('1').delete();
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test.each(streams)('%sの不正snapshotを拒否する', async (stream) => {
    await entries(ref, stream).doc('1').set(entry(stream, 1, start, {}, {}));
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test('null goalは確認済みnoGoal', async () => {
    await entries(ref, 'goal').doc('1').set(entry('goal', 1, start, null, null));
    expect(await read()).toEqual({ status: 'noGoal' });
  });

  test('null subscriptionはavailableの確認済み未購入', async () => {
    await entries(ref, 'subscription').doc('1')
      .set(entry('subscription', 1, start, null, null));
    expect(await read()).toEqual(expectedAvailable(null));
  });

  test('noGoalでも他stream欠損を隠さない', async () => {
    await entries(ref, 'goal').doc('1').set(entry('goal', 1, start, null, null));
    await entries(ref, 'subscription').doc('1').delete();
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test('同時刻revision最大の直前値とrevision最小の後続を読む', async () => {
    const changed = { ...goal, minDailyMinutes: 75 };
    const later = { ...goal, minDailyMinutes: 90 };
    const batch = db.batch();
    batch.update(ref, { judgementRevisions: { ...counters(), goal: 5 } });
    batch.set(entries(ref, 'goal').doc('2'),
      entry('goal', 2, new Timestamp(200, 499000), goal, goal));
    batch.set(entries(ref, 'goal').doc('3'),
      entry('goal', 3, new Timestamp(200, 499000), goal, changed));
    batch.set(entries(ref, 'goal').doc('4'),
      entry('goal', 4, cutoff, changed, later));
    batch.set(entries(ref, 'goal').doc('5'),
      entry('goal', 5, cutoff, later, later));
    await batch.commit();
    expect(await read()).toEqual({
      ...expectedAvailable(),
      goal: {
        startDate: goal.startDate,
        examDate: goal.examDate,
        minDailyMinutes: 75,
        goalDailyMinutes: 120,
      },
    });
  });

  test.each(streams)('%sの最新欠損を古いentryへのfallbackで隠さない', async (stream) => {
    await ref.update({ judgementRevisions: { ...counters(), [stream]: 2 } });
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test.each(streams)('%sの隣接revision gapを拒否する', async (stream) => {
    await ref.update({ judgementRevisions: { ...counters(), [stream]: 3 } });
    await entries(ref, stream).doc('3').set(entry(stream, 3, cutoff));
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test.each(streams)('%s後続のbefore不一致を拒否する', async (stream) => {
    const alternatives: JudgementSnapshots = {
      goal: null,
      settings: { xPostEnabled: false },
      xLink: { xLinked: false },
      subscription: null,
    };
    await ref.update({ judgementRevisions: { ...counters(), [stream]: 2 } });
    await entries(ref, stream).doc('2').set(
      entry(stream, 2, cutoff, alternatives[stream], values[stream]),
    );
    await expect(read()).rejects.toBeInstanceOf(JudgementHistoryReadError);
  });

  test('エラーにUID・raw metadataを含めない', async () => {
    const raw = 'private-invalid-counter';
    await ref.update({ judgementRevisions: { ...counters(), goal: raw } });
    const error = await read().then(
      () => { throw new Error('Expected history error'); },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(JudgementHistoryReadError);
    expect(String(error)).not.toContain(ref.id);
    expect(String(error)).not.toContain(raw);
    expect(JSON.stringify(error)).not.toContain(raw);
    expect(JSON.stringify(error)).not.toContain(ref.id);
  });
});

test('entriesの2方向composite indexと既存TTL overrideを保持する', () => {
  const config = JSON.parse(readFileSync(
    resolve(__dirname, '../../../../firestore.indexes.json'), 'utf8',
  ));
  for (const order of ['ASCENDING', 'DESCENDING']) {
    expect(config.indexes).toEqual(expect.arrayContaining([{
      collectionGroup: 'entries',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'committedAt', order },
        { fieldPath: 'revision', order },
      ],
    }]));
  }
  expect(config.fieldOverrides).toEqual(expect.arrayContaining([{
    collectionGroup: 'rateLimits',
    fieldPath: 'expireAt',
    ttl: true,
    indexes: [],
  }]));
});
