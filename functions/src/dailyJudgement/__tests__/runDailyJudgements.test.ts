import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  FieldPath, getFirestore, Query, Timestamp,
  type DocumentReference, type Firestore,
} from 'firebase-admin/firestore';

import { jstStartOfNextDay } from '../../../../shared/date';
import type { JudgementSnapshots } from '../../../../shared/judgementHistory';
import { initializeHistory } from '../initializeHistory';
import { judgeUserDay } from '../judgeUserDay';
import { DailyJudgementsError, runDailyJudgements } from '../runDailyJudgements';

// mainが新規Emulatorでこのsuiteだけを実行する。全データ削除は禁止。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('runDailyJudgements tests require local demo-gokaku Firestore Emulator');
}
const app = initializeApp({ projectId: 'demo-gokaku' }, `daily-run-${randomUUID()}`);
const db = getFirestore(app);
const date = '2026-10-24';
const schedule = '2026-10-24T15:00:00Z';
const cutoff = jstStartOfNextDay(date);
const minute = 60_000;
const baseline = Timestamp.fromMillis(cutoff - 20 * 24 * 60 * minute);
const streams = ['goal', 'settings', 'xLink', 'subscription'] as const;
const revisions = { goal: 1, settings: 1, xLink: 1, subscription: 1 };
const goal = {
  goalId: 'historical-goal', startDate: '2026-10-01', examDate: '2026-12-01',
  minDailyMinutes: 60, goalDailyMinutes: 120,
};
type Deps = Parameters<typeof runDailyJudgements>[1];
// 提案する安全な戻り値契約。outcomesはJudgeUserDayResult.status別の件数。
// summary: { targetDateKey, processed, initialized, failed, outcomes,
//   excludedSessions: { invalid_session_shape, invalid_session_time } }
// エラーはDailyJudgementsError('Daily judgements failed')で同じsummaryを保持。
// optional内部DI: initializeHistory?: typeof initializeHistory,
// judgeUserDay?: typeof judgeUserDay。本番省略時は既存の実コアを使う。
let owned: DocumentReference[] = [];
let prefix = '';
beforeEach(() => { owned = []; prefix = `daily-run-${randomUUID()}`; });
afterEach(async () => {
  jest.restoreAllMocks();
  const cleanup = await Promise.allSettled(owned.map((ref) => db.recursiveDelete(ref)));
  if (cleanup.some((result) => result.status === 'rejected')) {
    throw new Error('Owned daily judgement fixtures could not be cleaned');
  }
});
afterAll(async () => {
  try { await db.terminate(); } finally { await deleteApp(app); }
});
function own(label: string) {
  const ref = db.doc(`users/${prefix}-${label}`);
  owned.push(ref);
  return ref;
}
function history(ref: DocumentReference, stream: typeof streams[number]) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}
async function user(label: string, patch: Partial<JudgementSnapshots> = {}) {
  const ref = own(label);
  const snapshots: JudgementSnapshots = {
    goal, settings: { xPostEnabled: true }, xLink: { xLinked: true },
    subscription: { expiresAt: cutoff + minute }, ...patch,
  };
  const batch = db.batch();
  // 現在pointerなしでも過去のgoalを判定する。current activeGoalIdで絞らせない。
  batch.set(ref, {
    activeGoalId: null, xPostEnabled: false, xLinked: false, subscription: null,
    judgementHistoryStartedAt: baseline, judgementRevisions: revisions,
  });
  for (const stream of streams) {
    batch.set(history(ref, stream).doc('1'), {
      schemaVersion: 1, revision: 1, committedAt: baseline,
      before: snapshots[stream], after: snapshots[stream],
    });
  }
  await batch.commit();
  return ref;
}
function session(ref: DocumentReference, id: string, patch: Record<string, unknown>) {
  return ref.collection('sessions').doc(id).set({
    goalId: goal.goalId, startAt: cutoff - 30 * minute, checkEnabled: false, ...patch,
  });
}
function result(ref: DocumentReference) { return ref.collection('dailyResults').doc(date); }
function observeQueries() {
  const queries: Query[] = [];
  const get = Query.prototype.get;
  jest.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
    queries.push(this);
    return get.call(this);
  });
  return queries;
}
async function failure(deps: Deps) {
  const error: unknown = await runDailyJudgements(schedule, deps).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(DailyJudgementsError);
  if (!(error instanceof DailyJudgementsError)) throw new Error('Expected aggregate failure');
  expect(error.message).toBe('Daily judgements failed');
  return error;
}

test('実コア: 達成/未達/計測中/試験日/期限切れ/目標なしをまとめて処理する', async () => {
  const achieved = await user('01');
  const unmet = await user('02');
  const running = await user('03');
  const exam = await user('04', { goal: { ...goal, examDate: date } });
  const expired = await user('05', { subscription: { expiresAt: cutoff } });
  const noGoal = await user('06', { goal: null });
  await session(achieved, 'finished', { startAt: cutoff - 120 * minute, stopAt: cutoff });
  await session(running, 'open', { startAt: cutoff - 65 * minute, checkEnabled: true });
  const init = jest.fn(initializeHistory);
  const summary = await runDailyJudgements(schedule, { db, pageSize: 3, concurrency: 2, initializeHistory: init });
  expect(summary).toMatchObject({
    targetDateKey: date, processed: 6, initialized: 0, failed: 0,
    outcomes: { created: 3, skipped: 2, noGoal: 1 },
  });
  expect(init).not.toHaveBeenCalled();
  for (const [ref, minutes, postStatus] of [
    [achieved, 120, 'none'], [unmet, 0, 'pending'], [running, 65, 'none'],
  ] as const) {
    expect((await result(ref).get()).data()).toMatchObject({
      goalId: goal.goalId, studiedMinutes: minutes, postStatus,
    });
  }
  for (const ref of [exam, expired, noGoal]) expect((await result(ref).get()).exists).toBe(false);
});

test('文書ID昇順の2ページをcursorで処理し、全員をちょうど1回呼ぶ', async () => {
  const refs = await Promise.all(['03', '01', '02'].map((label) => user(label)));
  const sorted = [...refs].sort((a, b) => a.id.localeCompare(b.id));
  const cursor = await sorted[1].get();
  const queries = observeQueries();
  const judge = jest.fn(async () => ({ status: 'already' as const }));
  const summary = await runDailyJudgements(schedule, { db, pageSize: 2, concurrency: 1, judgeUserDay: judge });
  expect(summary).toMatchObject({ processed: 3, failed: 0, outcomes: { already: 3 } });
  expect(judge.mock.calls).toHaveLength(3);
  expect(judge).toHaveBeenNthCalledWith(1, sorted[0].id, date, { db });
  expect(judge).toHaveBeenNthCalledWith(2, sorted[1].id, date, { db });
  expect(judge).toHaveBeenNthCalledWith(3, sorted[2].id, date, { db });
  const ordered = db.collection('users').orderBy(FieldPath.documentId());
  expect(queries).toHaveLength(2);
  expect(queries[0].isEqual(ordered.limit(2))).toBe(true);
  expect(queries[1].isEqual(ordered.startAfter(cursor).limit(2))).toBe(true);
});

test.each([[undefined, 100, 10], [2, 3, 2]] as const)(
  '並列数%pを守り、既定page100/並列10も検証する', async (concurrency, pageSize, expectedPeak) => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => user(String(index).padStart(2, '0'))));
    const queries = observeQueries();
    let active = 0;
    let peak = 0;
    const judge = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      try { await new Promise<void>((resolve) => setImmediate(resolve)); }
      finally { active -= 1; }
      return { status: 'already' as const };
    });
    const deps: Deps = { db, judgeUserDay: judge };
    if (concurrency !== undefined) Object.assign(deps, { concurrency, pageSize });
    const summary = await runDailyJudgements(schedule, deps);
    expect(summary).toMatchObject({ processed: 12, failed: 0, outcomes: { already: 12 } });
    expect(judge).toHaveBeenCalledTimes(12);
    expect(peak).toBe(expectedPeak);
    expect(active).toBe(0);
    expect(queries[0].isEqual(db.collection('users').orderBy(FieldPath.documentId()).limit(pageSize))).toBe(true);
  },
);

test('実コアの二重起動と再実行で結果内容/updateTimeを変えない', async () => {
  const refs = await Promise.all([user('01'), user('02')]);
  const summaries = await Promise.all([
    runDailyJudgements(schedule, { db }), runDailyJudgements(schedule, { db }),
  ]);
  expect(summaries.reduce((sum, item) => sum + item.outcomes.created, 0)).toBe(2);
  expect(summaries.reduce((sum, item) => sum + item.outcomes.already, 0)).toBe(2);
  const before = await Promise.all(refs.map((ref) => result(ref).get()));
  await history(refs[0], 'settings').doc('1').delete();
  expect(await runDailyJudgements(schedule, { db })).toMatchObject({
    processed: 2, failed: 0, outcomes: { already: 2 },
  });
  for (const [index, ref] of refs.entries()) {
    const after = await result(ref).get();
    expect(after.data()).toEqual(before[index].data());
    expect(after.updateTime!.isEqual(before[index].updateTime!)).toBe(true);
  }
});

test('1人の例外後も別ページを完走し、安全な集計error後の再実行で回復する', async () => {
  const refs = await Promise.all(['01', '02', '03'].map((label) => user(label)));
  const judge = jest.fn<ReturnType<typeof judgeUserDay>, Parameters<typeof judgeUserDay>>().mockImplementation(async (uid, key, deps) => {
    if (uid === refs[0].id) throw new Error(`private-failure-${uid}`);
    return judgeUserDay(uid, key, deps);
  });
  const error = await failure({ db, pageSize: 2, concurrency: 1, judgeUserDay: judge });
  expect(error.summary).toMatchObject({
    targetDateKey: date, processed: 3, failed: 1, outcomes: { created: 2 },
  });
  expect(judge).toHaveBeenCalledTimes(3);
  expect((await result(refs[2]).get()).exists).toBe(true);
  expect(error).not.toHaveProperty('cause');
  const exposed = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
  expect(exposed).not.toContain('private-failure');
  for (const ref of refs) expect(exposed).not.toContain(ref.id);
  expect(await runDailyJudgements(schedule, { db })).toMatchObject({
    processed: 3, failed: 0, outcomes: { created: 1, already: 2 },
  });
});

test('legacyだけ初期化し、導入前を推測せず、再実行でbaselineを増やさない', async () => {
  const ref = own('legacy');
  await ref.set({ activeGoalId: null });
  const init = jest.fn(initializeHistory);
  expect(await runDailyJudgements(schedule, { db, initializeHistory: init })).toMatchObject({
    processed: 1, initialized: 1, failed: 0, outcomes: { beforeCoverage: 1 },
  });
  expect(init).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledWith(db, ref.id);
  const parent = await ref.get();
  const started = parent.get('judgementHistoryStartedAt') as Timestamp;
  expect(started).toBeInstanceOf(Timestamp);
  expect(started.toMillis()).toBeGreaterThan(cutoff);
  const entries = await Promise.all(streams.map((stream) => history(ref, stream).get()));
  for (const entry of entries) {
    expect(entry.size).toBe(1);
    expect(entry.docs[0].get('committedAt').isEqual(started)).toBe(true);
    expect(entry.docs[0].updateTime.isEqual(parent.updateTime!)).toBe(true);
  }
  init.mockClear();
  expect(await runDailyJudgements(schedule, { db, initializeHistory: init })).toMatchObject({
    processed: 1, initialized: 0, failed: 0, outcomes: { beforeCoverage: 1 },
  });
  expect(init).not.toHaveBeenCalled();
  expect((await ref.get()).updateTime!.isEqual(parent.updateTime!)).toBe(true);
  expect((await result(ref).get()).exists).toBe(false);
});

test.each(['missing', 'deleting'] as const)('列挙後の%sは初期化時も安全skipする', async (reason) => {
  const ref = own(reason);
  await ref.set({ activeGoalId: null });
  const init: typeof initializeHistory = async (database, uid) => {
    if (reason === 'missing') await ref.delete();
    else await ref.update({ deletionInProgress: true });
    return initializeHistory(database, uid);
  };
  const summary = await runDailyJudgements(schedule, { db, initializeHistory: init });
  expect(summary).toMatchObject({ processed: 1, initialized: 0, failed: 0 });
  expect(summary.outcomes[reason === 'missing' ? 'noAccount' : 'deleting']).toBe(1);
  expect((await ref.get()).exists).toBe(reason === 'deleting');
  for (const stream of streams) expect((await history(ref, stream).get()).empty).toBe(true);
  expect((await result(ref).get()).exists).toBe(false);
});

test.each([
  { judgementHistoryStartedAt: baseline }, { judgementRevisions: revisions },
  { judgementHistoryStartedAt: null, judgementRevisions: null },
])('部分/不正metadataを初期化で修復しない: %p', async (metadata) => {
  const ref = own('partial');
  await ref.set({ activeGoalId: null, ...metadata });
  const before = await ref.get();
  const init = jest.fn(initializeHistory);
  const error = await failure({ db, initializeHistory: init });
  expect(error.summary).toMatchObject({ processed: 1, initialized: 0, failed: 1 });
  expect(init).not.toHaveBeenCalled();
  const after = await ref.get();
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  for (const stream of streams) expect((await history(ref, stream).get()).empty).toBe(true);
});

test('不正sessionは定型reasonの件数だけにし、raw値/UID/sessionIDを露出しない', async () => {
  const ref = await user('diagnostics');
  await session(ref, 'private-shape-id', { startAt: 'private-raw-value' });
  await session(ref, 'private-time-id', { stopAt: cutoff - 31 * minute });
  await session(ref, 'valid', {});
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    jest.spyOn(console, method as 'log').mockImplementation(() => {}));
  const summary = await runDailyJudgements(schedule, { db });
  expect(summary.excludedSessions).toEqual({ invalid_session_shape: 1, invalid_session_time: 1 });
  expect(summary).toMatchObject({ processed: 1, failed: 0, outcomes: { created: 1 } });
  expect((await result(ref).get()).get('studiedMinutes')).toBe(30);
  const exposed = JSON.stringify([summary, logs.map((spy) => spy.mock.calls)]);
  for (const value of [ref.id, 'private-shape-id', 'private-time-id', 'private-raw-value']) {
    expect(exposed).not.toContain(value);
  }
});

test.each([
  [schedule, date], ['2026-10-25T00:00:00+09:00', date],
  ['2026-10-24T10:00:00-05:00', date], ['2024-03-01T00:00:00+09:00', '2024-02-29'],
  ['2027-01-01T00:00:00+09:00', '2026-12-31'],
])('予定時刻%sから実行日と独立したJST前日を固定する', async (at, expected) => {
  await Promise.all([user('01'), user('02')]);
  const judge = jest.fn(async () => ({ status: 'already' as const }));
  expect(await runDailyJudgements(at, { db, pageSize: 1, judgeUserDay: judge }))
    .toMatchObject({ targetDateKey: expected, processed: 2, failed: 0 });
  for (const ref of owned) expect(judge).toHaveBeenCalledWith(ref.id, expected, { db });
});

test.each([
  '', '2026-10-25', '2026-10-25T00:00:00', '2026-02-30T00:00:00Z',
  '2026-10-25T24:00:00Z', '2026-10-25T00:00:60Z', '2026-10-25T00:00:00+24:00',
  ' 2026-10-25T00:00:00Z', '2026-10-25T00:00:00Zjunk', null, 1792854000000,
])('不正予定時刻%pをIO前に拒否する', async (at) => {
  const io = jest.fn(() => { throw new Error('Unexpected database access'); });
  const database = new Proxy({} as Firestore, { get: io });
  await expect(runDailyJudgements(at as string, { db: database })).rejects.toBeInstanceOf(RangeError);
  expect(io).not.toHaveBeenCalled();
});

test.each(['pageSize', 'concurrency'] as const)('不正%sをIO前に拒否する', async (key) => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
    const io = jest.fn(() => { throw new Error('Unexpected database access'); });
    const database = new Proxy({} as Firestore, { get: io });
    await expect(runDailyJudgements(schedule, { db: database, [key]: value } as Deps))
      .rejects.toBeInstanceOf(RangeError);
    expect(io).not.toHaveBeenCalled();
  }
});

test('P136: 第2ページ取得失敗で処理済み集計を保持し、同じ予定時刻の再試行で既存結果を変えない', async () => {
  const refs = await Promise.all(['01', '02', '03'].map((label) => user(label)));
  const cursor = await refs[1].get();
  const secondPage = db.collection('users').orderBy(FieldPath.documentId()).startAfter(cursor).limit(2);
  const originalFailure = new Error('privatefailure-' + refs.map((ref) => ref.id).join('|'));
  const get = Query.prototype.get;
  let injected = 0;
  // driverのQuery.getだけを対象にする。実コアのtransaction.getは変更しない。
  const spy = jest.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
    if (injected === 0 && this.isEqual(secondPage)) {
      injected += 1;
      return Promise.reject(originalFailure);
    }
    return get.call(this);
  });
  let before: { data: unknown; updateTime: Timestamp }[] = [];
  try {
    const error = await failure({ db, pageSize: 2, concurrency: 1 });
    expect(injected).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(error).not.toBe(originalFailure);
    expect(error).not.toHaveProperty('cause');
    expect(error.summary).toEqual({
      targetDateKey: date, processed: 2, initialized: 0, failed: 0,
      outcomes: {
        created: 2, already: 0, beforeCoverage: 0,
        noAccount: 0, deleting: 0, noGoal: 0, skipped: 0,
      },
      excludedSessions: { invalid_session_shape: 0, invalid_session_time: 0 },
    });
    const exposed = JSON.stringify(Object.getOwnPropertyNames(error).map((key) => [key, Reflect.get(error, key)]));
    expect(exposed).not.toContain('privatefailure');
    for (const ref of refs) expect(exposed).not.toContain(ref.id);
    const snapshots = await Promise.all(refs.slice(0, 2).map((ref) => result(ref).get()));
    for (const snapshot of snapshots) {
      expect(snapshot.exists).toBe(true);
      expect(snapshot.updateTime).toBeInstanceOf(Timestamp);
    }
    before = snapshots.map((snapshot) => ({ data: snapshot.data(), updateTime: snapshot.updateTime! }));
    expect((await result(refs[2]).get()).exists).toBe(false);
  } finally {
    spy.mockRestore();
  }
  const retried = await runDailyJudgements(schedule, { db, pageSize: 2, concurrency: 1 });
  expect(retried).toMatchObject({
    targetDateKey: date, processed: 3, initialized: 0, failed: 0,
    outcomes: { created: 1, already: 2 },
  });
  expect(injected).toBe(1);
  expect((await result(refs[2]).get()).exists).toBe(true);
  for (const [index, ref] of refs.slice(0, 2).entries()) {
    const after = await result(ref).get();
    expect(after.data()).toEqual(before[index].data);
    expect(after.updateTime!.isEqual(before[index].updateTime)).toBe(true);
  }
});
