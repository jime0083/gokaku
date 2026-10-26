import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { FUNCTIONS_REGION } from '../../config';
import { ensureAdminApp } from '../../firebaseAdmin';
import { dailyStudyJudgement } from '../dailyJudgementSchedule';

jest.mock('firebase-admin/firestore', () => ({ getFirestore: jest.fn() }));
jest.mock('../../firebaseAdmin', () => ({ ensureAdminApp: jest.fn() }));
jest.mock('../runDailyJudgements', () => ({ runDailyJudgements: jest.fn() }), { virtual: true });
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

beforeEach(() => {
  jest.clearAllMocks();
  runDailyJudgements.mockReset().mockResolvedValue(undefined);
  jest.mocked(getFirestore).mockReturnValue(db);
  consoleMethods.forEach((name) => jest.spyOn(console, name).mockImplementation(() => undefined));
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('runtime clock forbidden'); });
});
afterEach(() => {
  try {
    consoleMethods.forEach((name) => expect(console[name]).not.toHaveBeenCalled());
    [logger.write, logger.debug, logger.log, logger.info, logger.warn, logger.error].forEach((method) => expect(method).not.toHaveBeenCalled());
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
});

test('run obtains Admin dependencies at runtime and passes only the scheduled time', async () => {
  await dailyStudyJudgement.run({ ...event, body: { uid: 'fixture-other', scheduleTime: 'ignored' } } as typeof event);
  expect(ensureAdminApp).toHaveBeenCalledTimes(1);
  expect(getFirestore).toHaveBeenCalledTimes(1);
  expect(jest.mocked(ensureAdminApp).mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(getFirestore).mock.invocationCallOrder[0]);
  expect(runDailyJudgements.mock.calls).toEqual([[scheduleTime, { db }]]);
});

test('retry preserves the exact original scheduled time', async () => {
  await dailyStudyJudgement.run(event);
  await dailyStudyJudgement.run(event);
  expect(runDailyJudgements.mock.calls).toEqual([[scheduleTime, { db }], [scheduleTime, { db }]]);
});

test('run awaits processing and does not return or log its summary', async () => {
  let finish!: () => void;
  let settled = false;
  runDailyJudgements.mockReturnValueOnce(new Promise<void>((resolveDone) => { finish = resolveDone; }));
  const pending = Promise.resolve(dailyStudyJudgement.run(event));
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await expect(pending).resolves.toBeUndefined();
  runDailyJudgements.mockResolvedValueOnce({ privateValue: 'fixture-private' });
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).resolves.toBeUndefined();
});

test('processing failure propagates unchanged without custom logging', async () => {
  const failure = new Error('fixture-private-sdk-error');
  runDailyJudgements.mockRejectedValueOnce(failure);
  await expect(Promise.resolve(dailyStudyJudgement.run(event))).rejects.toBe(failure);
});

test('runtime dependency failure propagates without calling the driver', async () => {
  const failure = new Error('fixture-private-admin-error');
  jest.mocked(getFirestore).mockImplementationOnce(() => { throw failure; });
  await expect(Promise.resolve().then(() => dailyStudyJudgement.run(event))).rejects.toBe(failure);
  expect(runDailyJudgements).not.toHaveBeenCalled();
});
