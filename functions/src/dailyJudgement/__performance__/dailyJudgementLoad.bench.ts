import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp,
  type DocumentReference, type DocumentSnapshot,
} from 'firebase-admin/firestore';

import { jstStartOfDay, jstStartOfNextDay } from '../../../../shared/date';
import type { JudgementSnapshots } from '../../../../shared/judgementHistory';
import { runDailyJudgements } from '../runDailyJudgements';

// 未適用・未実行。mainが新規Emulatorでこの1fileを単独実行する。
// Jest: --runInBand --testMatch '**/*.bench.ts' --runTestsByPath <このfile>
// 通常の *.test.ts から分離する。skip/gatingや実コアのmockは使わない。
// 測定はEmulator機上の限定結果であり、本番性能を保証しない。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('Load benchmark requires local demo-gokaku Firestore Emulator');
}

const TEST_TIMEOUT_MS = 2_400_000;
// dailyJudgementSchedule.ts の timeoutSeconds: 1800 に対応する。
const RUNTIME_LIMIT_MS = 1_800_000;
const USERS = 1000;
const GROUP_SIZE = 200;
const SESSIONS = 100;
const BATCH_LIMIT = 500;
const READ_CHUNK = 100;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DATE = '2026-10-24';
const SCHEDULE = '2026-10-24T15:00:00Z';
const CUTOFF = jstStartOfNextDay(DATE);
const BASELINE = Timestamp.fromMillis(jstStartOfDay('2026-06-01'));
const STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;
const GOAL_ID = 'load-goal';
const app = initializeApp({ projectId: 'demo-gokaku' }, `daily-load-${randomUUID()}`);
const db = getFirestore(app);
const owned = new Set<DocumentReference>();
const prefix = `daily-load-${randomUUID()}`;
const refs = Array.from({ length: USERS }, (_, index) =>
  db.doc(`users/${prefix}-${String(index).padStart(4, '0')}`));

// fixture/cleanupの余裕を含め、実行前に固定する。失敗後に引き上げない。
jest.setTimeout(TEST_TIMEOUT_MS);

async function bounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  const failures: unknown[] = [];
  for (let offset = 0; offset < items.length; offset += limit) {
    const settled = await Promise.allSettled(items.slice(offset, offset + limit).map(task));
    for (const result of settled) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
  // 開始済み処理を残さず、後片付けも全対象を試みてから失敗させる。
  if (failures.length > 0) throw new AggregateError(failures, 'Benchmark operations failed');
}

async function cleanup() {
  await bounded([...owned], 10, async (ref) => {
    await db.recursiveDelete(ref);
    owned.delete(ref);
  });
}

afterAll(async () => {
  try { await cleanup(); }
  finally {
    try { await db.terminate(); }
    finally { await deleteApp(app); }
  }
}, TEST_TIMEOUT_MS);

async function seed(index: number) {
  const ref = refs[index];
  const group = Math.floor(index / GROUP_SIZE);
  const goal = {
    startDate: '2026-06-01', examDate: group === 3 ? DATE : '2026-12-01',
    minDailyMinutes: 60, goalDailyMinutes: 120,
  };
  const subscription = { expiresAt: group === 4 ? CUTOFF : CUTOFF + DAY };
  const snapshots: JudgementSnapshots = {
    goal: { goalId: GOAL_ID, ...goal }, settings: { xPostEnabled: true },
    xLink: { xLinked: true }, subscription,
  };
  // commit失敗時にも、このfixtureの子孫だけを後片付けする。
  owned.add(ref);
  const batch = db.batch();
  batch.create(ref, {
    activeGoalId: GOAL_ID, xPostEnabled: true, xLinked: true, subscription,
    checkEnabled: group === 2,
    judgementHistoryStartedAt: BASELINE,
    judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
  });
  batch.create(ref.collection('goals').doc(GOAL_ID), {
    ...goal, type: 'cert', certId: 'other', certOtherName: '負荷検証資格',
    targetHours: 100, estimatedHours: null, status: 'active', createdAt: BASELINE.toMillis(),
  });
  for (const stream of STREAMS) {
    const entry = ref.collection('judgementHistory').doc(stream).collection('entries').doc('1');
    batch.create(entry, {
      schemaVersion: 1, revision: 1, committedAt: BASELINE,
      before: snapshots[stream], after: snapshots[stream],
    });
  }
  for (let offset = 0; offset < SESSIONS - 1; offset += 1) {
    const startAt = jstStartOfDay(DATE) - (offset + 1) * DAY + 12 * 60 * MINUTE;
    batch.create(ref.collection('sessions').doc(`past-${offset}`), {
      goalId: GOAL_ID, startAt, stopAt: startAt + 30 * MINUTE,
      checkEnabled: false, confirmations: [],
    });
  }
  const minutes = group === 0 ? 120 : group === 2 ? 65 : 30;
  batch.create(ref.collection('sessions').doc('target'), {
    goalId: GOAL_ID, startAt: CUTOFF - minutes * MINUTE,
    stopAt: group === 2 ? null : CUTOFF, checkEnabled: group === 2, confirmations: [],
  });
  expect(2 + STREAMS.length + SESSIONS).toBeLessThanOrEqual(BATCH_LIMIT);
  await batch.commit();
}

async function readResults() {
  const docs: DocumentSnapshot[] = [];
  for (let offset = 0; offset < refs.length; offset += READ_CHUNK) {
    docs.push(...await db.getAll(...refs.slice(offset, offset + READ_CHUNK)
      .map((ref) => ref.collection('dailyResults').doc(DATE))));
  }
  return docs;
}

function verifyResults(docs: readonly DocumentSnapshot[]) {
  expect(docs).toHaveLength(USERS);
  for (const [index, doc] of docs.entries()) {
    expect(doc.ref.path).toBe(refs[index].collection('dailyResults').doc(DATE).path);
    const group = Math.floor(index / GROUP_SIZE);
    expect(doc.exists).toBe(group < 3);
    if (group >= 3) {
      expect(doc.data()).toBeUndefined();
      continue;
    }
    const minutes = group === 0 ? 120 : group === 1 ? 30 : 65;
    // mokuhyo.txtの分単位・最低以上/努力以上の判定と一致する。
    expect(doc.data()).toEqual({
      goalId: GOAL_ID, studiedMinutes: minutes, metMin: group !== 1,
      metGoal: group === 0, postStatus: group === 1 ? 'pending' : 'none', postSkipReasons: [],
    });
  }
}

function expectedSummary(repeated: boolean) {
  return {
    targetDateKey: DATE, processed: USERS, initialized: 0, failed: 0,
    outcomes: {
      created: repeated ? 0 : 600, already: repeated ? 600 : 0, skipped: 400,
      noGoal: 0, noAccount: 0, deleting: 0, beforeCoverage: 0,
    },
    excludedSessions: { invalid_session_shape: 0, invalid_session_time: 0 },
  };
}

async function measure(label: 'daily_load_first' | 'daily_load_repeat') {
  const started = performance.now();
  const summary = await runDailyJudgements(SCHEDULE, { db });
  const elapsedMs = performance.now() - started;
  console.info(JSON.stringify({
    label, elapsedMs, processed: summary.processed, initialized: summary.initialized,
    failed: summary.failed, ...summary.outcomes, ...summary.excludedSessions,
  }));
  expect(elapsedMs).toBeLessThan(RUNTIME_LIMIT_MS);
  return summary;
}

test('7-2: 1000 users / 100000 sessions, real driver/core and immutable rerun', async () => {
  try {
    // 既存データを消して隔離を作らず、非空なら書込み前に失敗する。
    expect((await db.collection('users').limit(1).get()).empty).toBe(true);
    expect((await db.collectionGroup('sessions').limit(1).get()).empty).toBe(true);
    expect((await db.collectionGroup('dailyResults').limit(1).get()).empty).toBe(true);
    const started = performance.now();
    await bounded(Array.from({ length: USERS }, (_, index) => index), 8, seed);
    const seedElapsedMs = performance.now() - started;
    console.info(JSON.stringify({ label: 'daily_load_seed', elapsedMs: seedElapsedMs,
      users: USERS, sessions: USERS * SESSIONS }));
    expect((await db.collection('users').count().get()).data().count).toBe(USERS);
    await bounded(refs, 8, async (ref) => {
      expect((await ref.collection('sessions').count().get()).data().count).toBe(SESSIONS);
    });
    expect((await db.collectionGroup('sessions').count().get()).data().count).toBe(100_000);
    expect(await measure('daily_load_first')).toEqual(expectedSummary(false));
    const before = await readResults();
    verifyResults(before);
    expect((await db.collectionGroup('dailyResults').count().get()).data().count).toBe(600);
    expect(await measure('daily_load_repeat')).toEqual(expectedSummary(true));
    const after = await readResults();
    verifyResults(after);
    expect((await db.collectionGroup('dailyResults').count().get()).data().count).toBe(600);
    for (const [index, doc] of after.entries()) {
      expect(doc.data()).toEqual(before[index].data());
      expect(doc.updateTime).toEqual(before[index].updateTime);
    }
  } finally {
    await cleanup();
  }
}, TEST_TIMEOUT_MS);
