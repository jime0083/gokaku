import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { FUNCTIONS_REGION } from '../../config';
import { ensureAdminApp } from '../../firebaseAdmin';
import { dailyStudyJudgement } from '../dailyJudgementSchedule';
import { DailyJudgementsError, type DailyJudgementsSummary } from '../runDailyJudgements';

jest.mock('firebase-admin/firestore', () => ({
  ...jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore'),
  getFirestore: jest.fn(),
}));
jest.mock('../../firebaseAdmin', () => ({ ensureAdminApp: jest.fn() }));
jest.mock('../runDailyJudgements', () => ({
  DailyJudgementsError: jest.requireActual<typeof import('../runDailyJudgements')>('../runDailyJudgements').DailyJudgementsError,
  runDailyJudgements: jest.fn(),
}));
jest.mock('firebase-functions/logger', () => Object.fromEntries(
  ['write', 'debug', 'log', 'info', 'warn', 'error'].map((name) => [name, jest.fn()]),
));

const { runDailyJudgements } = jest.requireMock('../runDailyJudgements') as {
  runDailyJudgements: jest.Mock<Promise<unknown>, [string, { db: Firestore }]>;
};
const importCalls = [jest.mocked(ensureAdminApp).mock.calls.length, jest.mocked(getFirestore).mock.calls.length];
const db = Object.freeze({}) as Firestore;
const scheduleTime = '2026-10-25T15:00:00.000Z';
const event = { scheduleTime, jobName: 'fixture-daily-job' };
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

function summary(): DailyJudgementsSummary {
  return {
    targetDateKey: '2026-10-25',
    processed: 28,
    initialized: 2,
    failed: 0,
    outcomes: {
      created: 1, already: 2, beforeCoverage: 3,
      noAccount: 4, deleting: 5, noGoal: 6, skipped: 7,
    },
    excludedSessions: { invalid_session_shape: 8, invalid_session_time: 9 },
  };
}
function expectedUsage(value: DailyJudgementsSummary) {
  return {
    event: 'usage_summary',
    operation: 'daily_judgement',
    processed: value.processed,
    initialized: value.initialized,
    failed: value.failed,
    outcomes: {
      created: value.outcomes.created,
      already: value.outcomes.already,
      beforeCoverage: value.outcomes.beforeCoverage,
      noAccount: value.outcomes.noAccount,
      deleting: value.outcomes.deleting,
      noGoal: value.outcomes.noGoal,
      skipped: value.outcomes.skipped,
    },
    excludedSessions: {
      invalid_session_shape: value.excludedSessions.invalid_session_shape,
      invalid_session_time: value.excludedSessions.invalid_session_time,
    },
  };
}
function expectUsage(value: DailyJudgementsSummary) {
  expect(jest.mocked(logger.info).mock.calls).toEqual([
    ['usage_summary', expectedUsage(value)],
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(logger.info).mockReset();
  runDailyJudgements.mockReset().mockResolvedValue(undefined);
  jest.mocked(getFirestore).mockReturnValue(db);
  consoleMethods.forEach((name) => jest.spyOn(console, name).mockImplementation(() => undefined));
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('runtime clock forbidden'); });
});
afterEach(() => {
  try {
    consoleMethods.forEach((name) => expect(console[name]).not.toHaveBeenCalled());
    [logger.write, logger.debug, logger.log, logger.warn, logger.error].forEach((method) => expect(method).not.toHaveBeenCalled());
    // infoだけを許可し、すべての呼出しで固定フィールドと数値を検査する。
    for (const args of jest.mocked(logger.info).mock.calls) {
      expect(args).toHaveLength(2);
      expect(args[0]).toBe('usage_summary');
      const payload = args[1] as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'event', 'excludedSessions', 'failed', 'initialized', 'operation', 'outcomes', 'processed',
      ]);
      expect(payload.event).toBe('usage_summary');
      expect(payload.operation).toBe('daily_judgement');
      const outcomes = payload.outcomes as Record<string, unknown>;
      const excluded = payload.excludedSessions as Record<string, unknown>;
      expect(Object.keys(outcomes).sort()).toEqual([
        'already', 'beforeCoverage', 'created', 'deleting', 'noAccount', 'noGoal', 'skipped',
      ]);
      expect(Object.keys(excluded).sort()).toEqual(['invalid_session_shape', 'invalid_session_time']);
      for (const value of [payload.processed, payload.initialized, payload.failed, ...Object.values(outcomes), ...Object.values(excluded)]) {
        expect(typeof value).toBe('number');
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(0);
      }
    }
    expect(Date.now).not.toHaveBeenCalled();
  } finally { jest.restoreAllMocks(); }
});

test('import registers the schedule without obtaining runtime Admin dependencies', () => {
  expect(importCalls).toEqual([0, 0]);
  expect(FUNCTIONS_REGION).toBe('asia-northeast1');
  expect(dailyStudyJudgement.__endpoint).toMatchObject({
    platform: 'gcfv2', region: [FUNCTIONS_REGION], timeoutSeconds: 1800,
    maxInstances: 1, concurrency: 1,
    scheduleTrigger: {
      schedule: '0 0 * * *', timeZone: 'Asia/Tokyo',
      retryConfig: {
        retryCount: 3, maxRetrySeconds: 21600,
        minBackoffSeconds: 60, maxBackoffSeconds: 600,
      },
    },
  });
  const index = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
  expect(index).toContain("export { dailyStudyJudgement } from './dailyJudgement/dailyJudgementSchedule';");
  expect(logger.info).not.toHaveBeenCalled();
});

test('run obtains Admin dependencies at runtime and passes only the scheduled time', async () => {
  await dailyStudyJudgement.run({ ...event, body: { uid: 'fixture-other', scheduleTime: 'ignored' } } as typeof event);
  expect(ensureAdminApp).toHaveBeenCalledTimes(1);
  expect(getFirestore).toHaveBeenCalledTimes(1);
  expect(jest.mocked(ensureAdminApp).mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(getFirestore).mock.invocationCallOrder[0]);
  expect(runDailyJudgements.mock.calls).toEqual([[scheduleTime, { db }]]);
  expect(logger.info).not.toHaveBeenCalled();
});

test('retry preserves the exact original scheduled time', async () => {
  await dailyStudyJudgement.run(event);
  await dailyStudyJudgement.run(event);
  expect(runDailyJudgements.mock.calls).toEqual([[scheduleTime, { db }], [scheduleTime, { db }]]);
  expect(logger.info).not.toHaveBeenCalled();
});

test('run awaits processing and does not return its summary or log unknown data', async () => {
  let finish!: () => void;
  let settled = false;
  runDailyJudgements.mockReturnValueOnce(new Promise<void>((resolveDone) => { finish = resolveDone; }));
  const pending = Promise.resolve(dailyStudyJudgement.run(event));
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(logger.info).not.toHaveBeenCalled();
  finish();
  await expect(pending).resolves.toBeUndefined();
  runDailyJudgements.mockResolvedValueOnce({ privateValue: 'fixture-private' });
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).resolves.toBeUndefined();
  expect(logger.info).not.toHaveBeenCalled();
});

test('processing failure propagates unchanged without custom logging', async () => {
  const failure = Object.assign(new Error('fixture-private-sdk-error'), { summary: summary(), uid: 'fixture-private' });
  runDailyJudgements.mockRejectedValueOnce(failure);
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).rejects.toBe(failure);
  expect(logger.info).not.toHaveBeenCalled();
});

test('runtime dependency failure propagates without calling the driver', async () => {
  const failure = new Error('fixture-private-admin-error');
  jest.mocked(getFirestore).mockImplementationOnce(() => { throw failure; });
  await expect(Promise.resolve().then(() => dailyStudyJudgement.run(event))).rejects.toBe(failure);
  expect(runDailyJudgements).not.toHaveBeenCalled();
  expect(logger.info).not.toHaveBeenCalled();
});

test('success logs only the fixed counters once after awaited completion', async () => {
  const value = summary();
  Object.assign(value, { uid: 'fixture-private', rawError: new Error('fixture-private') });
  Object.assign(value.outcomes, { privateValue: 'fixture-private', unknownCount: 123 });
  Object.assign(value.excludedSessions, { sessionId: 'fixture-private', unknownCount: 456 });
  let finish!: (value: DailyJudgementsSummary) => void;
  runDailyJudgements.mockReturnValueOnce(new Promise<DailyJudgementsSummary>((resolveDone) => { finish = resolveDone; }));
  const pending = Promise.resolve(dailyStudyJudgement.run({
    ...event, body: { uid: 'fixture-private', text: 'fixture-private' },
  } as typeof event));
  await Promise.resolve();
  expect(logger.info).not.toHaveBeenCalled();
  finish(value);
  await expect(pending).resolves.toBeUndefined();
  expectUsage(value);
  expect(runDailyJudgements).toHaveBeenCalledTimes(1);
});

test('known partial failure logs counters and rethrows the identical error', async () => {
  const value = summary();
  value.processed += 1;
  value.failed = 1;
  const failure = new DailyJudgementsError(value);
  Object.assign(failure, { uid: 'fixture-private', cause: new Error('fixture-private') });
  runDailyJudgements.mockRejectedValueOnce(failure);
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).rejects.toBe(failure);
  expectUsage(value);
  expect(runDailyJudgements).toHaveBeenCalledTimes(1);
});

test.each([false, true])('logger failure preserves the processing outcome (failure=%s)', async (failed) => {
  const value = summary();
  value.failed = failed ? 1 : 0;
  const failure = new DailyJudgementsError(value);
  jest.mocked(logger.info).mockImplementationOnce(() => { throw new Error('fixture-private-logger'); });
  if (failed) runDailyJudgements.mockRejectedValueOnce(failure);
  else runDailyJudgements.mockResolvedValueOnce(value);
  const pending = Promise.resolve(dailyStudyJudgement.run(event));
  if (failed) await expect(pending).rejects.toBe(failure);
  else await expect(pending).resolves.toBeUndefined();
  expectUsage(value);
  expect(runDailyJudgements).toHaveBeenCalledTimes(1);
});

const counterPaths = [
  ['processed'], ['initialized'], ['failed'],
  ...['created', 'already', 'beforeCoverage', 'noAccount', 'deleting', 'noGoal', 'skipped'].map((key) => ['outcomes', key]),
  ...['invalid_session_shape', 'invalid_session_time'].map((key) => ['excludedSessions', key]),
];
const invalidCounts: unknown[] = [undefined, null, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, {}, []];
test.each(counterPaths.map((path) => [path.join('.'), path] as const))('invalid or missing %s skips the entire log for success and known failure', async (_label, path) => {
  for (const invalid of invalidCounts) {
    for (const failed of [false, true]) {
      const value = summary();
      const failure = new DailyJudgementsError(value);
      const candidate = failed ? failure.summary : value;
      const group = (path.length === 1 ? candidate : candidate[path[0] as 'outcomes' | 'excludedSessions']) as unknown as Record<string, unknown>;
      group[path[path.length - 1]] = invalid;
      if (failed) runDailyJudgements.mockRejectedValueOnce(failure);
      else runDailyJudgements.mockResolvedValueOnce(candidate);
      const pending = Promise.resolve(dailyStudyJudgement.run(event));
      if (failed) await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toBeUndefined();
      expect(logger.info).not.toHaveBeenCalled();
    }
  }
});

test.each([undefined, null, [], {}, { processed: 0 }, { ...summary(), outcomes: null }, { ...summary(), excludedSessions: [] }])('unknown summary is not replaced with zero counts (%#)', async (value) => {
  runDailyJudgements.mockResolvedValueOnce(value);
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).resolves.toBeUndefined();
  expect(logger.info).not.toHaveBeenCalled();
});

test('zero and maximum safe integer counts are accepted without coercion', async () => {
  const value = summary();
  value.processed = Number.MAX_SAFE_INTEGER;
  value.initialized = 0;
  value.outcomes.created = 0;
  value.excludedSessions.invalid_session_shape = 0;
  runDailyJudgements.mockResolvedValueOnce(value);
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).resolves.toBeUndefined();
  expectUsage(value);
});

test('telemetry extraction failure preserves success and the identical processing error', async () => {
  for (const failed of [false, true]) {
    const value = summary();
    const failure = new DailyJudgementsError(value);
    const candidate = failed ? failure.summary : value;
    Object.defineProperty(candidate, 'outcomes', { get: () => { throw new Error('fixture-private-getter'); } });
    if (failed) runDailyJudgements.mockRejectedValueOnce(failure);
    else runDailyJudgements.mockResolvedValueOnce(candidate);
    const pending = Promise.resolve(dailyStudyJudgement.run(event));
    if (failed) await expect(pending).rejects.toBe(failure);
    else await expect(pending).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  }
});
