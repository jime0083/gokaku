import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { write, debug, log, info, warn, error } from 'firebase-functions/logger';
import { defineSecret } from 'firebase-functions/params';
import { onSchedule, type ScheduledEvent } from 'firebase-functions/v2/scheduler';
import { FUNCTIONS_REGION } from '../../config';
import { ensureAdminApp } from '../../firebaseAdmin';
import { createActiveTokenStore } from '../../xAuth/activeTokenStore';
import { X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, X_TOKEN_ENCRYPTION_KEY,
  X_OAUTH_REDIRECT_URI, X_OAUTH_STATE_TTL_SECONDS, readAuthorizationConfig } from '../../xAuth/config';
import type { TokenFetch } from '../../xAuth/tokenTransport';
import { ensurePostingJob } from '../createPostingJob';
import { requestPost, type PostFetch, type PostInput, type PostResult } from '../postTransport';
import { createPostingJobStore } from '../postingJobStore';
import { createPostingTokenProvider } from '../postingToken';

jest.mock('node:crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(), initializeApp: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: jest.fn() }));
jest.mock('firebase-functions/params', () => ({ defineSecret: jest.fn() }));
jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(jest.requireActual('firebase-functions/v2/scheduler').onSchedule),
}));
jest.mock('firebase-functions/logger', () => ({
  write: jest.fn(), debug: jest.fn(), log: jest.fn(),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../firebaseAdmin', () => ({ ensureAdminApp: jest.fn() }));
jest.mock('../../xAuth/config', () => ({
  X_OAUTH_CLIENT_ID: { name: 'X_OAUTH_CLIENT_ID', value: jest.fn() },
  X_OAUTH_CLIENT_SECRET: { name: 'X_OAUTH_CLIENT_SECRET', value: jest.fn() },
  X_TOKEN_ENCRYPTION_KEY: { name: 'X_TOKEN_ENCRYPTION_KEY', value: jest.fn() },
  X_OAUTH_REDIRECT_URI: { value: jest.fn() },
  X_OAUTH_STATE_TTL_SECONDS: { value: jest.fn() },
  readAuthorizationConfig: jest.fn(),
}));
jest.mock('../../xAuth/activeTokenStore', () => ({ createActiveTokenStore: jest.fn() }));
jest.mock('../createPostingJob', () => ({ ensurePostingJob: jest.fn() }));
jest.mock('../postingJobStore', () => ({ createPostingJobStore: jest.fn() }));
jest.mock('../postingToken', () => ({ createPostingTokenProvider: jest.fn() }));
jest.mock('../postTransport', () => ({ requestPost: jest.fn() }));
jest.mock('../postingWorker', () => ({ processPostingDate: jest.fn() }), { virtual: true });
jest.mock('../runPendingPostings', () => ({ runPendingPostings: jest.fn() }), { virtual: true });

type WorkerDeps = {
  ensureJob: (uid: string, date: string) => ReturnType<typeof ensurePostingJob>;
  store: ReturnType<typeof createPostingJobStore>;
  tokens: ReturnType<typeof createPostingTokenProvider>;
  post: (accessToken: string, payload: PostInput) => Promise<PostResult>;
  newClaimId: () => string;
};
type BatchDeps = {
  db: Firestore;
  processPostingDate: (uid: string, date: string) => Promise<unknown>;
};
const { processPostingDate } = jest.requireMock('../postingWorker') as {
  processPostingDate: jest.Mock<Promise<unknown>, [string, string, WorkerDeps]>;
};
const { runPendingPostings } = jest.requireMock('../runPendingPostings') as {
  runPendingPostings: jest.Mock<Promise<unknown>, [BatchDeps]>;
};
const privateValue = 'synthetic-private-provider-value';
const secrets = [X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, X_TOKEN_ENCRYPTION_KEY];
const factories = [createActiveTokenStore, createPostingJobStore, createPostingTokenProvider];
const db = Object.freeze({}) as Firestore;
const activeStore = Object.freeze({}) as ReturnType<typeof createActiveTokenStore>;
const jobStore = Object.freeze({}) as ReturnType<typeof createPostingJobStore>;
const tokens = Object.freeze({}) as ReturnType<typeof createPostingTokenProvider>;
const key = Buffer.alloc(32, 7).toString('base64');
const event: ScheduledEvent = { scheduleTime: '2026-10-25T15:00:00.000Z', jobName: 'fixture-posting' };
const failureMessage = 'X posting scheduled processing failed';

function installGuards() {
  jest.spyOn(Date, 'now').mockReturnValue(1792933200000);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(privateValue));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  jest.spyOn(console, 'trace').mockImplementation(() => undefined);
  jest.spyOn(console, 'dir').mockImplementation(() => undefined);
  jest.spyOn(console, 'table').mockImplementation(() => undefined);
}
function expectSilence() {
  [write, debug, log, info, warn, error, console.log, console.info, console.warn,
    console.error, console.debug, console.trace, console.dir, console.table]
    .forEach((method) => expect(method).not.toHaveBeenCalled());
}
installGuards();
const { scheduledStudyPosting } = jest.requireActual<typeof import('../postingSchedule')>('../postingSchedule');
const registration = jest.mocked(onSchedule).mock.calls.slice();
const importCalls = [ensureAdminApp, getApps, initializeApp, getFirestore, defineSecret,
  ...secrets.map((secret) => secret.value), ...factories, ensurePostingJob,
  requestPost, processPostingDate, runPendingPostings, Date.now, randomUUID, globalThis.fetch,
  X_OAUTH_REDIRECT_URI.value, X_OAUTH_STATE_TTL_SECONDS.value, readAuthorizationConfig]
  .map((method) => jest.mocked(method).mock.calls.length);
expectSilence();

beforeEach(() => {
  jest.resetAllMocks();
  installGuards();
  jest.mocked(ensureAdminApp).mockImplementation(() => undefined);
  jest.mocked(getFirestore).mockReturnValue(db);
  jest.mocked(X_OAUTH_CLIENT_ID.value).mockReturnValue('synthetic-client');
  jest.mocked(X_OAUTH_CLIENT_SECRET.value).mockReturnValue('synthetic-secret');
  jest.mocked(X_TOKEN_ENCRYPTION_KEY.value).mockReturnValue(key);
  jest.mocked(createActiveTokenStore).mockReturnValue(activeStore);
  jest.mocked(createPostingJobStore).mockReturnValue(jobStore);
  jest.mocked(createPostingTokenProvider).mockReturnValue(tokens);
  jest.mocked(ensurePostingJob).mockResolvedValue({ status: 'existing' });
  jest.mocked(requestPost).mockResolvedValue({ kind: 'posted', postId: '123' });
  jest.mocked(randomUUID).mockReturnValue('11111111-1111-4111-8111-111111111111');
  processPostingDate.mockResolvedValue({ status: 'skipped' });
  runPendingPostings.mockResolvedValue({ privateValue });
});
afterEach(() => {
  try {
    expectSilence();
    [getApps, initializeApp, defineSecret, X_OAUTH_REDIRECT_URI.value,
      X_OAUTH_STATE_TTL_SECONDS.value, readAuthorizationConfig]
      .forEach((method) => expect(method).not.toHaveBeenCalled());
  } finally { jest.restoreAllMocks(); }
});

async function workerDeps() {
  await scheduledStudyPosting.run(event);
  await runPendingPostings.mock.calls[0][0].processPostingDate('persisted-user', '2026-10-24');
  return processPostingDate.mock.calls[0][2];
}
async function expectSanitized() {
  const caught: unknown = await Promise.resolve().then(() => scheduledStudyPosting.run(event))
    .then(() => undefined, (value: unknown) => value);
  expect(caught).toBeInstanceOf(Error);
  const failure = caught as Error;
  expect(failure.message).toBe(failureMessage);
  expect(failure.cause).toBeUndefined();
  expect(Object.getOwnPropertyNames(failure).sort()).toEqual(['message', 'stack']);
  expect(String(failure)).not.toContain(privateValue);
  expect(failure.stack).not.toContain(privateValue);
  expect(JSON.stringify(failure)).not.toContain(privateValue);
}

test('import is inert and registers exactly one scheduled endpoint with existing secret refs', () => {
  expect(importCalls.every((count) => count === 0)).toBe(true);
  expect(registration).toHaveLength(1);
  expect(registration[0][0]).toEqual({
    schedule: '* * * * *', timeZone: 'Asia/Tokyo', region: FUNCTIONS_REGION,
    timeoutSeconds: 1800, maxInstances: 1, concurrency: 1, retryCount: 0, secrets,
  });
  expect(FUNCTIONS_REGION).toBe('asia-northeast1');
  expect(scheduledStudyPosting.__endpoint).toMatchObject({
    platform: 'gcfv2', region: [FUNCTIONS_REGION], timeoutSeconds: 1800,
    maxInstances: 1, concurrency: 1,
    scheduleTrigger: { schedule: '* * * * *', timeZone: 'Asia/Tokyo', retryConfig: { retryCount: 0 } },
    secretEnvironmentVariables: secrets.map((secret) => ({ key: secret.name })),
  });
  const index = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
  expect(index.match(/export\s*\{\s*scheduledStudyPosting\s*\}\s*from\s*['"]\.\/xPosting\/postingSchedule['"]/g)).toHaveLength(1);
});

test('invocation obtains Admin then secrets and injects one shared live clock and UUID function', async () => {
  const deps = await workerDeps();
  expect(ensureAdminApp).toHaveBeenCalledTimes(1);
  expect(getFirestore).toHaveBeenCalledTimes(1);
  const adminOrder = jest.mocked(ensureAdminApp).mock.invocationCallOrder[0];
  const dbOrder = jest.mocked(getFirestore).mock.invocationCallOrder[0];
  expect(adminOrder).toBeLessThan(dbOrder);
  secrets.forEach((secret) => {
    expect(secret.value).toHaveBeenCalledTimes(1);
    expect(dbOrder).toBeLessThan(jest.mocked(secret.value).mock.invocationCallOrder[0]);
  });
  const active = jest.mocked(createActiveTokenStore).mock.calls[0][0];
  const provider = jest.mocked(createPostingTokenProvider).mock.calls[0][0];
  expect(active).toEqual({ firestore: db, now: expect.any(Function), encryptionKey: key });
  expect(createPostingJobStore).toHaveBeenCalledWith({ db, now: active.now });
  expect(provider).toEqual({
    store: activeStore, fetch: expect.any(Function),
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
    encryptionKey: key, now: active.now, newClaimId: randomUUID,
  });
  expect(deps.store).toBe(jobStore);
  expect(deps.tokens).toBe(tokens);
  expect(deps.newClaimId).toBe(randomUUID);
  expect(Date.now).not.toHaveBeenCalled();
  expect(randomUUID).not.toHaveBeenCalled();
  expect(active.now()).toBe(1792933200000);
  jest.mocked(Date.now).mockReturnValue(1792933260000);
  expect(active.now()).toBe(1792933260000);
  expect(deps.newClaimId()).toBe('11111111-1111-4111-8111-111111111111');
});

test('event getters are ignored and batch controls the UID and date passed to the worker', async () => {
  const untrusted = Object.create(null) as ScheduledEvent;
  for (const name of ['uid', 'body', 'data', 'scheduleTime', 'jobName']) {
    Object.defineProperty(untrusted, name, { get() { throw new Error(privateValue); } });
  }
  await expect(Promise.resolve().then(() => scheduledStudyPosting.run(untrusted))).resolves.toBeUndefined();
  const batch = runPendingPostings.mock.calls[0][0];
  expect(Object.keys(batch).sort()).toEqual(['db', 'processPostingDate']);
  expect(batch.db).toBe(db);
  await expect(batch.processPostingDate('persisted-user', '2026-10-24')).resolves.toEqual({ status: 'skipped' });
  expect(processPostingDate).toHaveBeenCalledTimes(1);
  expect(processPostingDate.mock.calls[0].slice(0, 2)).toEqual(['persisted-user', '2026-10-24']);
  expect(Object.keys(processPostingDate.mock.calls[0][2]).sort())
    .toEqual(['ensureJob', 'newClaimId', 'post', 'store', 'tokens']);
});

test('ensureJob forwards the selected target and the identical DB and clock', async () => {
  const deps = await workerDeps();
  const now = jest.mocked(createActiveTokenStore).mock.calls[0][0].now;
  await expect(deps.ensureJob('another-user', '2026-10-23')).resolves.toEqual({ status: 'existing' });
  expect(ensurePostingJob).toHaveBeenCalledWith('another-user', '2026-10-23', { db, now });
});

test('post forwards token and payload unchanged and injects a typed global-fetch adapter', async () => {
  const deps = await workerDeps();
  const payload = { text: 'synthetic approved text', mediaIds: ['456'] };
  await expect(deps.post('synthetic-access', payload)).resolves.toEqual({ kind: 'posted', postId: '123' });
  const [adapter, accessToken, input] = jest.mocked(requestPost).mock.calls[0];
  expect(accessToken).toBe('synthetic-access');
  expect(input).toBe(payload);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  const response = new Response(null, { status: 429 });
  jest.mocked(globalThis.fetch).mockResolvedValueOnce(response);
  const init: Parameters<PostFetch>[1] = {
    method: 'POST', headers: {}, body: '{}', redirect: 'error', signal: new AbortController().signal,
  };
  await expect(adapter('https://post.example.test', init)).resolves.toBe(response);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).toHaveBeenCalledWith('https://post.example.test', init);
});

test('token adapter passes URLSearchParams and response through the stubbed global fetch', async () => {
  await scheduledStudyPosting.run(event);
  const adapter: TokenFetch = jest.mocked(createPostingTokenProvider).mock.calls[0][0].fetch;
  expect(globalThis.fetch).not.toHaveBeenCalled();
  const response = new Response(null, { status: 400 });
  jest.mocked(globalThis.fetch).mockResolvedValueOnce(response);
  const init: Parameters<TokenFetch>[1] = {
    method: 'POST', headers: {}, body: new URLSearchParams({ grant_type: 'refresh_token' }),
    redirect: 'error', signal: new AbortController().signal,
  };
  await expect(adapter('https://token.example.test', init)).resolves.toBe(response);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).toHaveBeenCalledWith('https://token.example.test', init);
});

test('entrypoint awaits batch completion and returns no private summary', async () => {
  let finish!: (value: unknown) => void;
  let settled = false;
  runPendingPostings.mockReturnValueOnce(new Promise<unknown>((done) => { finish = done; }));
  const pending = Promise.resolve().then(() => scheduledStudyPosting.run(event));
  const watched = pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(runPendingPostings).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    finish({ privateValue });
    await watched;
  }
  await expect(pending).resolves.toBeUndefined();
});

test('repeated invocations reacquire runtime state and keep each callback bound to its own DB', async () => {
  await scheduledStudyPosting.run(event);
  const first = runPendingPostings.mock.calls[0][0];
  const db2 = Object.freeze({}) as Firestore;
  const active2 = Object.freeze({}) as ReturnType<typeof createActiveTokenStore>;
  jest.mocked(getFirestore).mockReturnValueOnce(db2);
  jest.mocked(X_OAUTH_CLIENT_ID.value).mockReturnValueOnce('synthetic-client-2');
  jest.mocked(X_TOKEN_ENCRYPTION_KEY.value).mockReturnValueOnce('synthetic-key-2');
  jest.mocked(createActiveTokenStore).mockReturnValueOnce(active2);
  await scheduledStudyPosting.run(event);
  const second = runPendingPostings.mock.calls[1][0];
  expect(first.db).toBe(db);
  expect(second.db).toBe(db2);
  expect(createActiveTokenStore).toHaveBeenCalledTimes(2);
  expect(createPostingJobStore).toHaveBeenCalledTimes(2);
  expect(createPostingTokenProvider).toHaveBeenCalledTimes(2);
  secrets.forEach((secret) => expect(secret.value).toHaveBeenCalledTimes(2));
  expect(jest.mocked(createPostingTokenProvider).mock.calls[1][0]).toMatchObject({
    store: active2, encryptionKey: 'synthetic-key-2', credentials: { clientId: 'synthetic-client-2' },
  });
  await first.processPostingDate('first-user', '2026-10-23');
  await second.processPostingDate('second-user', '2026-10-24');
  const firstWorker = processPostingDate.mock.calls[0][2];
  const secondWorker = processPostingDate.mock.calls[1][2];
  await firstWorker.ensureJob('first-user', '2026-10-23');
  await secondWorker.ensureJob('second-user', '2026-10-24');
  expect(jest.mocked(ensurePostingJob).mock.calls.map((call) => call[2].db)).toEqual([db, db2]);
});

test('Admin, secret and factory failures are all replaced without invoking the batch', async () => {
  const fail = () => { throw new Error(privateValue); };
  const injections: (() => void)[] = [
    () => { jest.mocked(ensureAdminApp).mockImplementationOnce(fail); },
    () => { jest.mocked(getFirestore).mockImplementationOnce(fail); },
    ...secrets.map((secret) => () => { jest.mocked(secret.value).mockImplementationOnce(fail); }),
    () => { jest.mocked(createActiveTokenStore).mockImplementationOnce(fail); },
    () => { jest.mocked(createPostingJobStore).mockImplementationOnce(fail); },
    () => { jest.mocked(createPostingTokenProvider).mockImplementationOnce(fail); },
  ];
  for (const inject of injections) {
    jest.clearAllMocks();
    inject();
    await expectSanitized();
    expect(runPendingPostings).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }
});

test('batch rejection is sanitized even when the thrown value has malicious accessors', async () => {
  runPendingPostings.mockRejectedValueOnce(new Error(privateValue));
  await expectSanitized();
  runPendingPostings.mockRejectedValueOnce({
    get message() { throw new Error(privateValue); },
    toString() { throw new Error(privateValue); },
  });
  await expectSanitized();
  expect(runPendingPostings).toHaveBeenCalledTimes(2);
});
