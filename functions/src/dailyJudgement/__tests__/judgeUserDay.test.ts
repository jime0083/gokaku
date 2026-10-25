import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp,
  type DocumentReference, type Firestore, type Query, type Transaction,
} from 'firebase-admin/firestore';

import * as dailyJudgement from '../../../../shared/dailyJudgement';
import { jstStartOfDay, jstStartOfNextDay } from '../../../../shared/date';
import type { JudgementSnapshots, JudgementStream } from '../../../../shared/judgementHistory';
import { recordStudySessionEvent } from '../../studySession/recordStudySessionEvent';
import { JudgementHistoryReadError } from '../historyReader';
import { judgeUserDay } from '../judgeUserDay';

// No skip/fallback: fail before initialization unless this is a local demo Emulator.
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('judgeUserDay tests require local demo-gokaku Firestore Emulator');
}

// The existing writer uses the default Admin app; both paths use this demo database.
const app = initializeApp({ projectId: 'demo-gokaku' });
const db = getFirestore(app);
const date = '2026-10-24';
const cutoff = jstStartOfNextDay(date);
const dayStart = jstStartOfDay(date);
const minute = 60_000;
const baselineAt = Timestamp.fromMillis(jstStartOfDay('2026-10-01'));
const streams: JudgementStream[] = ['goal', 'settings', 'xLink', 'subscription'];
const goal = {
  goalId: 'restored-goal', startDate: '2026-10-01', examDate: '2026-12-01',
  minDailyMinutes: 60, goalDailyMinutes: 120,
};
const snapshots: JudgementSnapshots = {
  goal, settings: { xPostEnabled: true }, xLink: { xLinked: true },
  subscription: { expiresAt: cutoff + minute },
};
const revisions = { goal: 1, settings: 1, xLink: 1, subscription: 1 };

let ref: DocumentReference;
function history(stream: JudgementStream) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}
async function snapshot<S extends JudgementStream>(stream: S, value: JudgementSnapshots[S]) {
  await history(stream).doc('1').set({
    schemaVersion: 1, revision: 1, committedAt: baselineAt, before: value, after: value,
  });
}
function resultRef() { return ref.collection('dailyResults').doc(date); }
function session(id: string, extra: Record<string, unknown> = {}) {
  return ref.collection('sessions').doc(id).set({
    goalId: goal.goalId, startAt: cutoff - 30 * minute,
    checkEnabled: false, ...extra,
  });
}
function judge(database: Firestore = db) { return judgeUserDay(ref.id, date, { db: database }); }
async function saved() { return (await resultRef().get()).data(); }
async function expectCreated(minutes: number, extra: Record<string, unknown> = {}) {
  const result = await judge();
  expect(result).toMatchObject({ status: 'created', excludedSessions: [] });
  expect(await saved()).toEqual({
    goalId: goal.goalId, studiedMinutes: minutes,
    metMin: minutes >= 60, metGoal: minutes >= 120,
    postStatus: minutes >= 60 ? 'none' : 'pending', postSkipReasons: [], ...extra,
  });
}

beforeEach(async () => {
  ref = db.doc(`users/judge-user-day-${randomUUID()}`);
  await ref.set({
    judgementHistoryStartedAt: baselineAt, judgementRevisions: revisions,
    activeGoalId: 'current-decoy', xPostEnabled: false, xLinked: false, subscription: null,
  });
  await Promise.all(streams.map((stream) => snapshot(stream, snapshots[stream])));
  await ref.collection('goals').doc(goal.goalId).set({ type: 'cert' });
});
afterEach(async () => {
  jest.restoreAllMocks();
  // Fixtures are per-test UUIDs; clean even if setup/assertions failed.
  if (ref) await db.recursiveDelete(ref);
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe('judgeUserDay real Emulator: fixed historical day', () => {
  test('achieved: floor combined seconds once and ignore another goal', async () => {
    await session('a', { startAt: dayStart, stopAt: dayStart + 60 * minute + 40_000 });
    await session('b', { startAt: dayStart + 90 * minute, stopAt: dayStart + 150 * minute + 20_000 });
    await session('decoy', { goalId: 'current-decoy', startAt: dayStart, stopAt: cutoff });
    await expectCreated(121);
    expect((await ref.get()).get('activeGoalId')).toBe('current-decoy');
  });

  test('unachieved day creates pending result without posting', async () => {
    await expectCreated(0);
  });

  test('P-129: start-only writer omits stopAt/confirmations but remains valid', async () => {
    await recordStudySessionEvent(ref.id, {
      sessionId: 'normal-start', goalId: goal.goalId, action: 'start', source: 'app',
      clientTimeMs: cutoff - 65 * minute, idempotencyKey: 'normal-start', checkEnabled: true,
    }, { now: () => cutoff - 65 * minute });
    const raw = (await ref.collection('sessions').doc('normal-start').get()).data();
    expect(raw).not.toHaveProperty('stopAt');
    expect(raw).not.toHaveProperty('confirmations');
    // Response deadline is still open at midnight; count through cutoff.
    await expectCreated(65);
  });

  test.each([undefined, null])('OFF long-running cross-day session is not narrowed by start window (%p)', async (stopAt) => {
    await session('long', {
      startAt: jstStartOfDay('2026-09-01'),
      ...(stopAt === undefined ? {} : { stopAt }),
    });
    await expectCreated(1440);
  });

  test('after-cutoff stop and future starts cannot change fixed-day judgement', async () => {
    await session('late-stop', { startAt: cutoff - 30 * minute, stopAt: cutoff + 30 * minute });
    await session('future', { startAt: cutoff, stopAt: cutoff + 180 * minute });
    await expectCreated(30);
  });

  test('all four histories before cutoff win over current and exactly-at-cutoff decoys', async () => {
    const after: JudgementSnapshots = {
      goal: { ...goal, goalId: 'new-goal', minDailyMinutes: 999 },
      settings: { xPostEnabled: false }, xLink: { xLinked: false }, subscription: null,
    };
    const batch = db.batch();
    batch.update(ref, { judgementRevisions: { goal: 2, settings: 2, xLink: 2, subscription: 2 } });
    for (const stream of streams) {
      batch.set(history(stream).doc('2'), {
        schemaVersion: 1, revision: 2, committedAt: Timestamp.fromMillis(cutoff),
        before: snapshots[stream], after: after[stream],
      });
    }
    await batch.commit();
    await session('historical', { startAt: cutoff - 90 * minute });
    await expectCreated(90);
  });

  test('registration day is judged but never posted', async () => {
    await snapshot('goal', { ...goal, startDate: date });
    await expectCreated(0, { postStatus: 'skipped', postSkipReasons: ['start_date'] });
  });

  test.each([
    ['exam', 'exam_date_reached'],
    ['before-start', 'before_start_date'],
    ['expired', 'subscription_inactive'],
    ['unpaid', 'subscription_inactive'],
  ])('not judged: %s', async (kind, reason) => {
    if (kind === 'exam') await snapshot('goal', { ...goal, examDate: date });
    if (kind === 'before-start') await snapshot('goal', { ...goal, startDate: '2026-10-25' });
    if (kind === 'expired') await snapshot('subscription', { expiresAt: cutoff });
    if (kind === 'unpaid') await snapshot('subscription', null);
    expect(await judge()).toEqual({ status: 'skipped', reason });
    expect(await saved()).toBeUndefined();
  });

  test.each(['noAccount', 'deleting', 'noGoal', 'beforeCoverage'])('distinguishes %s with no result/parent creation', async (status) => {
    if (status === 'noAccount') await ref.delete();
    if (status === 'deleting') await ref.set({ deletionInProgress: true });
    if (status === 'noGoal') await snapshot('goal', null);
    if (status === 'beforeCoverage') await ref.set({ activeGoalId: 'current-decoy' });
    expect(await judge()).toEqual({ status });
    expect(await saved()).toBeUndefined();
    if (status === 'noAccount') expect((await ref.get()).exists).toBe(false);
  });

  test('baseline exactly at cutoff is beforeCoverage, not a usable snapshot', async () => {
    await ref.update({ judgementHistoryStartedAt: Timestamp.fromMillis(cutoff) });
    expect(await judge()).toEqual({ status: 'beforeCoverage' });
    expect(await saved()).toBeUndefined();
  });

  test.each(streams)('missing %s history is retryable error, not an inactive skip', async (stream) => {
    await history(stream).doc('1').delete();
    await expect(judge()).rejects.toBeInstanceOf(JudgementHistoryReadError);
    expect(await saved()).toBeUndefined();
    await snapshot(stream, snapshots[stream]);
    await expectCreated(0);
  });
});

describe('session decoding and controlled diagnostics', () => {
  const badCases: [string, Record<string, unknown>][] = [
    ['start-string', { startAt: 'private-raw-time' }],
    ['start-null', { startAt: null }],
    ['start-nan', { startAt: NaN }],
    ['start-infinity', { startAt: Infinity }],
    ['stop-string', { stopAt: 'private-raw-time' }],
    ['stop-nan', { stopAt: NaN }],
    ['check-null', { checkEnabled: null }],
    ['check-string', { checkEnabled: 'false' }],
    ['confirms-null', { confirmations: null }],
    ['confirms-object', { confirmations: { private: 'private-raw-time' } }],
    ['confirms-element', { confirmations: ['private-raw-time'] }],
    ['confirms-null-element', { confirmations: [null] }],
    ['confirms-nan', { confirmations: [NaN] }],
    ['confirms-infinity', { confirmations: [Infinity] }],
    ['range-error', { stopAt: cutoff - 31 * minute }],
  ];

  test.each(badCases)('%s excludes only that session and returns ID/controlled reason', async (id, extra) => {
    await session('valid');
    await session(id, extra);
    const result = await judge();
    expect(result.status).toBe('created');
    if (result.status !== 'created') throw new Error('Expected creation');
    expect(result.excludedSessions).toHaveLength(1);
    const diagnostic = result.excludedSessions[0];
    expect(diagnostic).toEqual({
      id, reason: id === 'range-error' ? 'invalid_session_time' : 'invalid_session_shape',
    });
    expect(JSON.stringify(result)).not.toContain('private-raw-time');
    expect((await saved())?.studiedMinutes).toBe(30);
  });

  test.each(['startAt', 'checkEnabled'])('required %s missing is excluded, not defaulted', async (key) => {
    const raw: Record<string, unknown> = {
      goalId: goal.goalId, startAt: cutoff - 30 * minute, checkEnabled: false,
    };
    delete raw[key];
    await ref.collection('sessions').doc('incomplete').set(raw);
    const result = await judge();
    expect(result).toMatchObject({
      status: 'created',
      excludedSessions: [{ id: 'incomplete', reason: 'invalid_session_shape' }],
    });
    expect((await saved())?.studiedMinutes).toBe(0);
  });

  test('normal numeric confirmation elements remain usable', async () => {
    await session('confirmed', {
      startAt: cutoff - 90 * minute, checkEnabled: true, confirmations: [cutoff - 25 * minute],
    });
    await expectCreated(90);
  });

  test('unexpected shared exception propagates and commits nothing', async () => {
    const failure = new TypeError('unexpected calculation failure');
    const spy = jest.spyOn(dailyJudgement, 'judgeDailyResult');
    // Permit optional empty-session preclassification, fail actual calculation.
    spy.mockImplementation((input) => {
      if (input.sessions.length > 0) throw failure;
      return { judged: true, date, result: {
        goalId: goal.goalId, studiedMinutes: 0, metMin: false, metGoal: false,
        postStatus: 'pending', postSkipReasons: [],
      }, excludedSessions: [], otherGoalSessionCount: 0 };
    });
    await session('valid');
    await expect(judge()).rejects.toBe(failure);
    expect(await saved()).toBeUndefined();
  });
});

describe('atomic read/write boundary and immutable results', () => {
  test.each(['', ' ', '.', '..', '__reserved__', 'other/child', 'x'.repeat(129), '\ud800'])('invalid UID rejected before any database read: %p', async (uid) => {
    const runTransaction = jest.fn();
    const doc = jest.fn();
    await expect(judgeUserDay(uid, date, { db: { doc, runTransaction } as unknown as Firestore })).rejects.toThrow();
    expect(doc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  test.each(['2026-02-30', '2026-1-01', '../other', ''])('invalid date rejected before database use: %p', async (targetDateKey) => {
    const runTransaction = jest.fn();
    const doc = jest.fn();
    await expect(judgeUserDay(ref.id, targetDateKey, { db: { doc, runTransaction } as unknown as Firestore })).rejects.toThrow();
    expect(doc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  test('existing result is byte-for-byte immutable even if histories are now invalid', async () => {
    const existing = {
      goalId: 'old-goal', studiedMinutes: 77, metMin: true, metGoal: false,
      postStatus: 'posted', postSkipReasons: [], marker: 'preserve',
    };
    await resultRef().set(existing);
    const before = await resultRef().get();
    await history('settings').doc('1').delete();
    expect(await judge()).toEqual({ status: 'already' });
    const after = await resultRef().get();
    expect(after.data()).toEqual(existing);
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  });

  test('one Admin transaction owns parent/result/all four history streams/full goal query and create', async () => {
    await session('valid');
    const reads: (DocumentReference | Query)[] = [];
    const writes: string[] = [];
    let transactions = 0;
    const database = {
      doc: db.doc.bind(db),
      runTransaction: (callback: (tx: Transaction) => Promise<unknown>) => db.runTransaction(async (tx) => {
        transactions += 1;
        let wrote = false;
        const wrapped = {
          get: async (target: DocumentReference | Query) => {
            expect(wrote).toBe(false);
            reads.push(target);
            return 'path' in target ? tx.get(target as DocumentReference) : tx.get(target as Query);
          },
          create: (target: DocumentReference, data: Record<string, unknown>) => {
            wrote = true;
            writes.push(target.path);
            tx.create(target, data);
            return wrapped;
          },
        };
        return callback(wrapped as unknown as Transaction);
      }),
    } as unknown as Firestore;
    const sharedSpy = jest.spyOn(dailyJudgement, 'judgeDailyResult');
    expect((await judge(database)).status).toBe('created');
    expect(transactions).toBe(1);
    expect(writes).toEqual([resultRef().path]);
    const paths = reads.filter((target) => 'path' in target).map((target) => (target as DocumentReference).path);
    expect(paths).toEqual(expect.arrayContaining([ref.path, resultRef().path]));
    const queries = reads.filter((target) => !('path' in target)) as Query[];
    const expectedQuery = ref.collection('sessions').where('goalId', '==', goal.goalId);
    expect(queries.some((query) => query.isEqual(expectedQuery))).toBe(true);
    for (const stream of streams) {
      for (const before of [true, false]) {
        const expected = history(stream).where('committedAt', before ? '<' : '>=', Timestamp.fromMillis(cutoff))
          .orderBy('committedAt', before ? 'desc' : 'asc')
          .orderBy('revision', before ? 'desc' : 'asc').limit(1);
        expect(queries.some((query) => query.isEqual(expected))).toBe(true);
      }
    }
    expect(sharedSpy).toHaveBeenCalled();
    for (const [input] of sharedSpy.mock.calls) expect(input.judgedAt).toBe(cutoff);
  });

  test('unexpected database error propagates unchanged', async () => {
    const failure = new Error('unexpected SDK failure');
    const database = {
      doc: db.doc.bind(db), runTransaction: jest.fn().mockRejectedValue(failure),
    } as unknown as Firestore;
    await expect(judge(database)).rejects.toBe(failure);
    expect(await saved()).toBeUndefined();
  });

  test('two concurrent judges create one result; loser returns already', async () => {
    await session('valid');
    const results = await Promise.all([judge(), judge()]);
    expect(results.map((value: { status: string }) => value.status).sort()).toEqual(['already', 'created']);
    expect((await ref.collection('dailyResults').get()).size).toBe(1);
    expect((await saved())?.studiedMinutes).toBe(30);
  });
});

describe('actual writer/judge serializable consistency', () => {
  function writeStart() {
    return recordStudySessionEvent(ref.id, {
      sessionId: 'writer-session', goalId: goal.goalId, action: 'start', source: 'app',
      clientTimeMs: cutoff - 30 * minute, idempotencyKey: 'writer-start', checkEnabled: false,
    }, { now: () => cutoff + minute });
  }
  async function writerStartAt() {
    return (await ref.collection('sessions').doc('writer-session').get()).get('startAt');
  }

  test('writer first: accepted prior-day start contributes to judgement', async () => {
    await writeStart();
    await expectCreated(30);
    expect(await writerStartAt()).toBe(cutoff - 30 * minute);
  });

  test('judge first: late prior-day start is corrected to received time; result stays immutable', async () => {
    await expectCreated(0);
    const before = await resultRef().get();
    await writeStart();
    expect(await writerStartAt()).toBe(cutoff + minute);
    expect(await judge()).toEqual({ status: 'already' });
    expect((await resultRef().get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
  });

  test('simultaneous insert/judge permits either complete serial order, never a mixed snapshot', async () => {
    // No barrier waits for a commit while the opposing transaction may hold locks.
    const results = await Promise.allSettled([writeStart(), judge()]);
    expect(results.every((value) => value.status === 'fulfilled')).toBe(true);
    const pair = { startAt: await writerStartAt(), minutes: (await saved())?.studiedMinutes };
    expect([
      { startAt: cutoff - 30 * minute, minutes: 30 },
      { startAt: cutoff + minute, minutes: 0 },
    ]).toContainEqual(pair);
  });

  test('simultaneous stop/judge serializes with daily-result correction', async () => {
    await session('writer-session', { startAt: cutoff - 90 * minute });
    const stop = recordStudySessionEvent(ref.id, {
      sessionId: 'writer-session', goalId: goal.goalId, action: 'stop', source: 'app',
      clientTimeMs: cutoff - 30 * minute, idempotencyKey: 'writer-stop',
    }, { now: () => cutoff + minute });
    const results = await Promise.allSettled([stop, judge()]);
    expect(results.every((value) => value.status === 'fulfilled')).toBe(true);
    const stopAt = (await ref.collection('sessions').doc('writer-session').get()).get('stopAt');
    expect([
      { stopAt: cutoff - 30 * minute, minutes: 60 },
      { stopAt: cutoff + minute, minutes: 90 },
    ]).toContainEqual({ stopAt, minutes: (await saved())?.studiedMinutes });
  });
});
