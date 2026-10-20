import type { AccountActionCheckpoint } from '../accountActionFlow';
import type * as Runtime from '../accountOperationRuntime';

const KEY = 'account:action:v1';
let runtime: typeof Runtime;
let uid: string | null;
let data: Map<string, string>;
let getItem: jest.Mock;
let nativeStatus: jest.Mock;
let nativeLoads: number;

function seed(phase: AccountActionCheckpoint['phase'], owner = 'owner-a'): void {
  data.set(KEY, JSON.stringify({ uid: owner, action: 'delete', phase }));
}

beforeEach(() => {
  jest.resetModules();
  uid = 'owner-a';
  data = new Map();
  nativeLoads = 0;
  getItem = jest.fn(async (key: string) => data.get(key) ?? null);
  nativeStatus = jest.fn(() => false);
  jest.doMock('@/config/firebase', () => ({ getCurrentUid: () => uid }));
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
      getItem,
      setItem: jest.fn(async (key: string, value: string) => { data.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { data.delete(key); }),
    },
  }));
  jest.doMock('../../../../modules/study-sync/src/StudySyncModule', () => {
    nativeLoads += 1;
    return { __esModule: true, default: { isAccountOperationBlocked: nativeStatus,
      getAccountOperationBlock: () => { throw new Error('lease-busy'); } } };
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  runtime = require('../accountOperationRuntime') as typeof Runtime;
});

afterEach(() => {
  jest.resetModules();
  jest.dontMock('@/config/firebase');
  jest.dontMock('@react-native-async-storage/async-storage');
  jest.dontMock('../../../../modules/study-sync/src/StudySyncModule');
});

it('exports the same gate to every caller and defers native loading', async () => {
  expect(nativeLoads).toBe(0);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const other = require('../accountOperationRuntime') as typeof Runtime;
  expect(other.accountOperationGate).toBe(runtime.accountOperationGate);
  const permit = await runtime.accountOperationGate.acquireAccount('owner-a');
  permit.assertCurrentUid();
  await expect(other.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('normal-blocked');
  await runtime.accountOperationGate.releaseAccount('owner-a');
  expect(nativeLoads).toBe(1);
});

it('reads actual auth at admission and again at the lease boundary', async () => {
  await runtime.accountOperationGate.runNormal('owner-a', async (lease) => {
    uid = 'owner-b';
    expect(() => lease.assertCurrentUid()).toThrow('uid-changed');
  });
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('uid-changed');
});

it.each([false, true])('uses the lease-free native status %s when JS is absent', async (blocked) => {
  nativeStatus.mockReturnValue(blocked);
  if (blocked) {
    await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
      .rejects.toThrow('normal-blocked');
  } else {
    await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
      .resolves.toBe(1);
  }
  expect(nativeStatus).toHaveBeenCalledTimes(1);
});

it.each(['cloud-pending', 'local-cleanup', 'sign-out', 'launch'] as const)(
  'blocks all normal UIDs for strict checkpoint phase %s', async (phase) => {
    seed(phase, 'other-owner');
    const task = jest.fn(async () => 1);
    await expect(runtime.accountOperationGate.runNormal('owner-a', task))
      .rejects.toThrow('normal-blocked');
    expect(task).not.toHaveBeenCalled();
  },
);

it.each(['{', 'null', '{}', JSON.stringify({ uid: 'owner-a', action: 'delete',
  phase: 'launch', extra: true })])('rejects corrupt public and gate reads: %s', async (raw) => {
  data.set(KEY, raw);
  await expect(runtime.loadPendingCheckpoint()).rejects.toThrow('account-checkpoint-invalid');
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('durable-unknown');
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
});

it('propagates storage I/O and never falls back to native false', async () => {
  getItem.mockRejectedValue(new Error('storage-unavailable'));
  await expect(runtime.loadPendingCheckpoint()).rejects.toThrow('storage-unavailable');
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('durable-unknown');
});

it.each([undefined, null, 0, 'false', Promise.resolve(false)])(
  'rejects unavailable or malformed native status %s', async (value) => {
    nativeStatus.mockReturnValue(value);
    await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
      .rejects.toThrow('durable-unknown');
  },
);

it('rejects native exceptions', async () => {
  nativeStatus.mockImplementation(() => { throw new Error('native-unreadable'); });
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('durable-unknown');
});

it('rejects a missing native API without false fallback', async () => {
  jest.doMock('../../../../modules/study-sync/src/StudySyncModule', () => ({ default: {} }));
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('durable-unknown');
});

it.each(['local-cleanup', 'sign-out', 'launch'] as const)(
  'confirms only the exact UID after strict public loading of %s', async (phase) => {
    seed(phase);
    expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
    const pending = await runtime.loadPendingCheckpoint();
    expect(pending).toEqual({ uid: 'owner-a', action: 'delete', phase });
    expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(true);
    expect(runtime.getAccountCompletionConfirmed('owner-b')).toBe(false);
    uid = null;
    const permit = await runtime.accountOperationGate.acquireAccount('owner-a');
    permit.assertCurrentUid();
    await runtime.accountOperationGate.releaseAccount('owner-a');
    expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(true);
  },
);

it('never infers success from missing auth, absence, or cloud-pending', async () => {
  uid = null;
  await runtime.loadPendingCheckpoint();
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
  seed('cloud-pending');
  await runtime.loadPendingCheckpoint();
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
  await expect(runtime.accountOperationGate.acquireAccount('owner-a')).rejects.toThrow('uid-changed');
});

it('retains actual cloud success despite persistence/read failure, null auth and release', async () => {
  seed('cloud-pending');
  runtime.rememberCloudSuccess('owner-a');
  getItem.mockRejectedValue(new Error('I/O'));
  await expect(runtime.loadPendingCheckpoint()).rejects.toThrow('I/O');
  uid = null;
  const permit = await runtime.accountOperationGate.acquireAccount('owner-a');
  permit.assertCurrentUid();
  await expect(runtime.accountOperationGate.releaseAccount('owner-a')).rejects.toThrow('durable-unknown');
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(true);
  expect(runtime.getAccountCompletionConfirmed('owner-b')).toBe(false);
  uid = 'owner-b';
  await expect(runtime.accountOperationGate.acquireAccount('owner-a')).rejects.toThrow('uid-changed');
});

it('invalidates durable confirmation on absent, pending or failed subsequent reads', async () => {
  for (const next of ['absent', 'pending', 'failure']) {
    seed('launch');
    await runtime.loadPendingCheckpoint();
    expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(true);
    if (next === 'absent') data.delete(KEY);
    if (next === 'pending') seed('cloud-pending');
    if (next === 'failure') getItem.mockRejectedValueOnce(new Error('I/O'));
    await runtime.loadPendingCheckpoint().catch(() => undefined);
    expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
  }
});

it('clears evidence only for the explicitly finalized UID', async () => {
  seed('launch');
  await runtime.loadPendingCheckpoint();
  runtime.rememberCloudSuccess('owner-a');
  runtime.rememberCloudSuccess('owner-b');
  runtime.clearCompletionAfterSuccessfulFinalization('owner-a');
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
  expect(runtime.getAccountCompletionConfirmed('owner-b')).toBe(true);
  // Clearing volatile evidence does not erase or unblock durable metadata.
  expect(data.has(KEY)).toBe(true);
  await expect(runtime.accountOperationGate.runNormal('owner-a', async () => 1))
    .rejects.toThrow('normal-blocked');
});

it('returns a snapshot that cannot mutate synchronous confirmation', async () => {
  seed('cloud-pending');
  const pending = await runtime.loadPendingCheckpoint();
  Object.assign(pending!, { phase: 'launch' });
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
});

it('does not let an in-flight old read restore explicitly cleared evidence', async () => {
  let finish!: (raw: string) => void;
  getItem.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const loading = runtime.loadPendingCheckpoint();
  while (!finish) await Promise.resolve();
  runtime.clearCompletionAfterSuccessfulFinalization('owner-a');
  finish(JSON.stringify({ uid: 'owner-a', action: 'delete', phase: 'launch' }));
  await loading;
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
});

it.each(['', '   '])('rejects invalid UID %j without retaining evidence', (invalid) => {
  expect(() => runtime.rememberCloudSuccess(invalid)).toThrow('account-runtime-invalid-uid');
  expect(() => runtime.clearCompletionAfterSuccessfulFinalization(invalid))
    .toThrow('account-runtime-invalid-uid');
  expect(runtime.getAccountCompletionConfirmed(invalid)).toBe(false);
});

it('retains volatile success when the actual strict checkpoint write fails', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const store = require('@react-native-async-storage/async-storage').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { saveAccountActionCheckpoint } = require('../accountActionCheckpoint') as
    typeof import('../accountActionCheckpoint');
  seed('cloud-pending');
  runtime.rememberCloudSuccess('owner-a');
  store.setItem.mockRejectedValueOnce(new Error('write-failed'));
  await expect(saveAccountActionCheckpoint(
    { uid: 'owner-a', action: 'delete', phase: 'local-cleanup' },
    store, async () => undefined,
  )).rejects.toThrow('write-failed');
  uid = null;
  await runtime.loadPendingCheckpoint();
  const permit = await runtime.accountOperationGate.acquireAccount('owner-a');
  permit.assertCurrentUid();
  await runtime.accountOperationGate.releaseAccount('owner-a');
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(true);
});

it('does not cache older successful reads when a newer strict read fails', async () => {
  let finish!: (raw: string) => void;
  getItem.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  getItem.mockRejectedValueOnce(new Error('latest-read-failed'));
  const older = runtime.loadPendingCheckpoint();
  while (!finish) await Promise.resolve();
  const latest = runtime.loadPendingCheckpoint();
  const rejected = expect(latest).rejects.toThrow('latest-read-failed');
  finish(JSON.stringify({ uid: 'owner-a', action: 'delete', phase: 'launch' }));
  await older;
  await rejected;
  expect(runtime.getAccountCompletionConfirmed('owner-a')).toBe(false);
});
