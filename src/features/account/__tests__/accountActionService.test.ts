import {
  accountActionService,
  createAccountActionService,
  type AccountActionNativePort,
  type AccountActionOptions,
  type AccountActionServiceDeps,
} from '../accountActionService';
import {
  ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY as CP,
  loadAccountActionCheckpoint,
} from '../accountActionCheckpoint';
import type { AccountAction, AccountActionCheckpoint } from '../accountActionFlow';
import { createAccountOperationGate, type AccountOperationLease } from '../accountOperationGate';
import type { LocalAccountStore } from '../localAccountData';
import type { AccountOperationBlock } from '../../../../modules/study-sync/src/StudySync.types';
import { TIMER_SESSIONS_STORAGE_KEY as SESSIONS } from '../../timer/storage';
import { STUDY_EVENT_QUEUE_STORAGE_KEY as EVENTS } from '../../timer/studyEventQueue';

// Any eager native load, including during singleton construction, fails this suite.
jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => {
  throw new Error('service-must-load-native-lazily');
});

const UID = 'service-owner';
const OTHER = 'service-other';
const ID = 'd25b7738-1b2a-4daf-8441-39a5643bd7b4';

function session(uid: string) {
  return {
    uid, sessionId: `session-${uid}`, startAt: 100, stopAt: 200,
    checkEnabled: true, confirmations: [],
  };
}

function event(uid: string) {
  return {
    uid, sessionId: `session-${uid}`, idempotencyKey: `event-${uid}`,
    action: 'start', clientTimeMs: 100, checkEnabled: true,
  };
}

function harness() {
  const trace: string[] = [];
  const state: {
    uid: string | null;
    block: AccountOperationBlock | null;
    permit: AccountOperationLease | null;
    measuring: boolean;
    nativePending: boolean;
    failRead: boolean;
    failSave: boolean;
    failCleanup: boolean;
    failFinish: boolean;
    failClear: boolean;
    unknownAfterCheckpoint: boolean;
  } = {
    uid: UID, block: null, permit: null, measuring: false, nativePending: true,
    failRead: false, failSave: false, failCleanup: false,
    failFinish: false, failClear: false, unknownAfterCheckpoint: false,
  };
  const data = new Map<string, string>([
    [SESSIONS, JSON.stringify([session(UID), session(OTHER)])],
    [EVENTS, JSON.stringify([event(UID), event(OTHER)])],
  ]);
  const store: jest.Mocked<LocalAccountStore> = {
    getAllKeys: jest.fn(async () => [...data.keys()]),
    getItem: jest.fn(async (key: string) => {
      if (key === CP && state.failRead) throw new Error('strict-read-failed');
      return data.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, raw: string) => {
      if (key === CP) {
        const cp = JSON.parse(raw) as AccountActionCheckpoint;
        if (state.failSave && cp.phase === 'local-cleanup') {
          throw new Error('checkpoint-save-failed');
        }
        trace.push(`save:${cp.phase}`);
      }
      if (key === SESSIONS) trace.push('js-cleanup');
      data.set(key, raw);
    }),
    removeItem: jest.fn(async (key: string) => {
      if (key === CP) {
        if (state.failClear) throw new Error('checkpoint-clear-failed');
        trace.push('cp-clear');
      }
      if (key === SESSIONS) trace.push('js-cleanup');
      data.delete(key);
    }),
  };
  let validated: AccountActionCheckpoint | null = null;
  const successes = new Set<string>();
  const confirmed = (uid: string) => successes.has(uid) ||
    (validated?.uid === uid && validated.phase !== 'cloud-pending');
  const load = jest.fn(async () => {
    validated = null;
    validated = await loadAccountActionCheckpoint(store, async () => undefined);
    return validated;
  });
  const gate = createAccountOperationGate({
    getCurrentUid: () => state.uid,
    getAccountCompletionConfirmed: confirmed,
    readDurableBlocked: async () => (await load()) !== null || state.block !== null,
  });
  const runtime: AccountActionServiceDeps['runtime'] = {
    accountOperationGate: {
      ...gate,
      releaseAccount: jest.fn(async (uid: string) => {
        await gate.releaseAccount(uid);
        trace.push('release');
      }),
    },
    loadPendingCheckpoint: load,
    getAccountCompletionConfirmed: confirmed,
    rememberCloudSuccess: jest.fn((uid: string) => {
      trace.push('remember');
      successes.add(uid);
    }),
    clearCompletionAfterSuccessfulFinalization: jest.fn((uid: string) => {
      trace.push('forget');
      successes.delete(uid);
      if (validated?.uid === uid) validated = null;
    }),
  };

  function exact(uid: string, action: AccountAction, id: string): void {
    expect(state.block).toEqual({ version: 1, uid, action, operationId: id });
    expect(uid).toBe(UID);
    expect(id).toBe(ID);
  }

  const native: jest.Mocked<AccountActionNativePort> = {
    getAccountOperationBlock: jest.fn(() => state.block ? { ...state.block } : null),
    beginAccountOperation: jest.fn((uid: string, action: AccountAction) => {
      trace.push('begin');
      state.block ??= { version: 1, uid, action, operationId: ID };
      return { ...state.block };
    }),
    inspectAccountOperation: jest.fn(async (uid: string, action: AccountAction, id: string) => {
      exact(uid, action, id);
      return {
        measuring: state.measuring,
        pendingRecords: state.nativePending,
        ownership: state.unknownAfterCheckpoint && data.has(CP)
          ? 'unknown' as const : 'known' as const,
      };
    }),
    drainAccountOperation: jest.fn(async (uid: string, action: AccountAction, id: string) => {
      exact(uid, action, id);
      trace.push('native-drain');
      state.nativePending = false;
      return 1;
    }),
    cleanupAccountOperation: jest.fn(async (uid: string, action: AccountAction, id: string) => {
      exact(uid, action, id);
      trace.push('native-cleanup');
      expect(JSON.parse(data.get(SESSIONS)!)).toEqual([session(OTHER)]);
      if (state.failCleanup) throw new Error('native-partial-cleanup');
    }),
    finishAccountOperation: jest.fn(async (uid: string, action: AccountAction, id: string) => {
      exact(uid, action, id);
      trace.push('native-finish');
      expect(() => state.permit!.assertCurrentUid()).toThrow('expired-lease');
      expect(JSON.parse(data.get(CP)!)).toEqual({ uid, action, phase: 'launch' });
      if (state.failFinish) throw new Error('native-finish-failed');
      state.block = null;
    }),
    cancelAccountOperation: jest.fn((uid: string, action: AccountAction, id: string) => {
      exact(uid, action, id);
      expect(data.has(CP)).toBe(false);
      expect(trace).not.toContain('cloud');
      trace.push('cancel');
      state.block = null;
    }),
  };

  const flush = jest.fn(async (uid: string, permit: AccountOperationLease) => {
    trace.push('js-flush');
    state.permit = permit;
    permit.assertCurrentUid();
    await expect(gate.runNormal(uid, async () => undefined))
      .rejects.toThrow('normal-blocked');
    permit.assertCurrentUid();
    const queue = JSON.parse(data.get(EVENTS)!) as { uid: string }[];
    await store.setItem(EVENTS, JSON.stringify(queue.filter((item) => item.uid !== uid)));
    permit.assertCurrentUid();
    return true;
  });
  const apple = jest.fn(async (_uid: string) => { trace.push('apple'); });
  const cloud = jest.fn(async (_uid: string, action: AccountAction) => {
    trace.push('cloud');
    if (action === 'delete') state.uid = null;
  });
  const signOut = jest.fn(async (uid: string) => {
    expect(state.uid).toBe(uid);
    trace.push('sdk-signout');
    state.uid = null;
  });
  const deps: AccountActionServiceDeps = {
    store, runtime, getCurrentUid: () => state.uid,
    getNative: () => native,
    flushPendingRecords: flush,
    reauthenticateAndRevoke: apple,
    authAccountAction: cloud,
    signOut,
  };
  const service = createAccountActionService(deps);
  const options: AccountActionOptions = {
    launch: jest.fn(async () => {
      trace.push('launch');
      expect(JSON.parse(data.get(CP)!)).toMatchObject({ uid: UID, phase: 'launch' });
      expect(state.block).not.toBeNull();
      await expect(gate.runNormal(UID, async () => undefined))
        .rejects.toThrow('normal-blocked');
    }),
  };
  return {
    data, store, state, trace, gate, runtime, native, flush, apple, cloud,
    signOut, service, options, deps,
  };
}

function metadataOptions(h: ReturnType<typeof harness>): AccountActionOptions {
  return {
    launch: jest.fn(async () => {
      h.trace.push('launch');
      expect(JSON.parse(h.data.get(CP)!))
        .toMatchObject({ uid: UID, phase: 'launch' });
      expect(h.state.block).toBeNull();
      expect(h.runtime.getAccountCompletionConfirmed(UID)).toBe(true);
      // A released permit would fail UID validation for OTHER instead.
      await expect(h.gate.runNormal(OTHER, async () => undefined))
        .rejects.toThrow('normal-blocked');
    }),
  };
}

it('exports one lazy singleton and binds logout/delete SDK boundaries and finalization order', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const again = require('../accountActionService') as typeof import('../accountActionService');
  expect(again.accountActionService).toBe(accountActionService);
  expect(jest.requireMock('@react-native-firebase/auth').getAuth).not.toHaveBeenCalled();

  for (const action of ['logout', 'delete'] as const) {
    const h = harness();
    const outcome = await h.service.perform(action, UID, h.options);
    expect(outcome).toEqual({ result: { status: 'complete' }, retryOnly: false });
    const expected = [
      'begin', 'js-flush', 'native-drain',
      ...(action === 'delete' ? ['apple'] : []),
      'cloud', 'remember', 'js-cleanup', 'native-cleanup',
      ...(action === 'logout' ? ['sdk-signout'] : []),
      'launch', 'release', 'native-finish', 'cp-clear', 'forget',
    ];
    expect(h.trace.filter((item) => !item.startsWith('save:'))).toEqual(expected);
    expect(h.cloud).toHaveBeenCalledWith(UID, action);
    expect(h.flush).toHaveBeenCalledWith(UID, h.state.permit);
    expect(h.native.cleanupAccountOperation).toHaveBeenCalledWith(UID, action, ID);
    expect(h.native.finishAccountOperation).toHaveBeenCalledWith(UID, action, ID);
    expect(h.signOut).toHaveBeenCalledTimes(action === 'logout' ? 1 : 0);
    expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
    expect(JSON.parse(h.data.get(SESSIONS)!)).toEqual([session(OTHER)]);
    expect(JSON.parse(h.data.get(EVENTS)!)).toEqual([event(OTHER)]);
    expect(h.runtime.getAccountCompletionConfirmed(UID)).toBe(false);
  }
});

it('cancels exact pre-Cloud blocks before release, but retains them after CP creation or unknown reads', async () => {
  for (const mode of ['measuring', 'unknown', 'apple', 'unreadable', 'checkpoint'] as const) {
    const h = harness();
    const before = h.data.get(SESSIONS);
    if (mode === 'measuring') h.state.measuring = true;
    if (mode === 'unknown') h.data.set(SESSIONS, '[{"sessionId":"legacy"}]');
    if (mode === 'apple' || mode === 'unreadable') {
      h.apple.mockImplementation(async () => {
        if (mode === 'unreadable') h.state.failRead = true;
        throw new Error('apple-cancelled');
      });
    }
    if (mode === 'checkpoint') h.state.unknownAfterCheckpoint = true;
    const action = mode === 'apple' || mode === 'unreadable' ? 'delete' : 'logout';
    const outcome = await h.service.perform(action, UID, h.options);
    expect(outcome.result.status).toBe('incomplete');
    expect(h.cloud).not.toHaveBeenCalled();
    expect(h.native.cleanupAccountOperation).not.toHaveBeenCalled();
    expect(h.options.launch).not.toHaveBeenCalled();
    if (mode === 'unreadable' || mode === 'checkpoint') {
      expect(outcome.retryOnly).toBe(true);
      expect(h.state.block).not.toBeNull();
      expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
      await expect(h.gate.runNormal(UID, async () => undefined)).rejects.toThrow();
    } else {
      expect(outcome.retryOnly).toBe(false);
      expect(h.state.block).toBeNull();
      expect(h.data.has(CP)).toBe(false);
      expect(h.native.cancelAccountOperation).toHaveBeenCalledWith(UID, action, ID);
      expect(h.trace.slice(-2)).toEqual(['cancel', 'release']);
      await expect(h.gate.runNormal(UID, async () => 'available')).resolves.toBe('available');
    }
    if (mode !== 'unknown') expect(h.data.get(SESSIONS)).toBe(before);
  }
});

it('remembers verified Cloud success before a failing save and retries partial cleanup without repeating Cloud', async () => {
  for (const failure of ['save', 'cleanup'] as const) {
    const h = harness();
    h.state.failSave = failure === 'save';
    h.state.failCleanup = failure === 'cleanup';
    const first = await h.service.perform('delete', UID, h.options);
    expect(first).toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
    expect(h.state.uid).toBeNull();
    expect(h.runtime.getAccountCompletionConfirmed(UID)).toBe(true);
    expect(h.runtime.getAccountCompletionConfirmed(OTHER)).toBe(false);
    expect(h.trace[h.trace.indexOf('cloud') + 1]).toBe('remember');
    expect(JSON.parse(h.data.get(CP)!)).toEqual({
      uid: UID, action: 'delete',
      phase: failure === 'save' ? 'cloud-pending' : 'local-cleanup',
    });
    expect(h.state.block?.operationId).toBe(ID);
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.options.launch).not.toHaveBeenCalled();
    expect(h.runtime.clearCompletionAfterSuccessfulFinalization).not.toHaveBeenCalled();
    await expect(h.gate.runNormal(UID, async () => undefined)).rejects.toThrow();

    h.state.failSave = false;
    h.state.failCleanup = false;
    expect(await h.service.resume(h.options))
      .toEqual({ result: { status: 'complete' }, retryOnly: false });
    expect(h.cloud).toHaveBeenCalledTimes(1);
    expect(h.apple).toHaveBeenCalledTimes(1);
    expect(h.runtime.rememberCloudSuccess).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.data.get(SESSIONS)!)).toEqual([session(OTHER)]);
  }
});

it('stops awaited UID changes before cleanup and never uses another UID to cancel or sign out', async () => {
  for (const boundary of ['flush', 'cloud'] as const) {
    const h = harness();
    const sessions = h.data.get(SESSIONS);
    if (boundary === 'flush') {
      h.flush.mockImplementation(async (_uid, permit) => {
        permit.assertCurrentUid();
        await Promise.resolve();
        h.state.uid = OTHER;
        return true;
      });
    } else {
      h.cloud.mockImplementation(async () => {
        h.trace.push('cloud');
        await Promise.resolve();
        h.state.uid = OTHER;
      });
    }
    expect(await h.service.perform('logout', UID, h.options))
      .toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
    expect(h.data.get(SESSIONS)).toBe(sessions);
    expect(h.native.cleanupAccountOperation).not.toHaveBeenCalled();
    expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.options.launch).not.toHaveBeenCalled();
    expect(h.state.block).toMatchObject({ uid: UID, action: 'logout', operationId: ID });
    expect(h.runtime.getAccountCompletionConfirmed(OTHER)).toBe(false);
    if (boundary === 'cloud') {
      expect(h.trace[h.trace.indexOf('cloud') + 1]).toBe('remember');
      expect(JSON.parse(h.data.get(CP)!)).toMatchObject({ uid: UID, phase: 'cloud-pending' });
    } else {
      expect(h.cloud).not.toHaveBeenCalled();
      expect(h.data.has(CP)).toBe(false);
    }
    await expect(h.gate.runNormal(OTHER, async () => undefined)).rejects.toThrow();
  }
});

it('retries native finish and CP removal failures without repeating completed data or Cloud work', async () => {
  for (const failure of ['finish', 'clear', 'partial-finish'] as const) {
    const h = harness();
    h.state.failFinish = failure === 'finish';
    h.state.failClear = failure === 'clear';
    if (failure === 'partial-finish') {
      const original = h.native.finishAccountOperation.getMockImplementation()!;
      h.native.finishAccountOperation.mockImplementation(async (uid, action, id) => {
        await original(uid, action, id);
        throw new Error('native-finish-failed-after-effect');
      });
    }
    expect(await h.service.perform('logout', UID, h.options))
      .toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
    expect(JSON.parse(h.data.get(CP)!))
      .toEqual({ uid: UID, action: 'logout', phase: 'launch' });
    expect(h.runtime.clearCompletionAfterSuccessfulFinalization).not.toHaveBeenCalled();
    const beginCount = h.native.beginAccountOperation.mock.calls.length;
    const cleanupCount = h.native.cleanupAccountOperation.mock.calls.length;
    const finishCount = h.native.finishAccountOperation.mock.calls.length;
    h.state.failFinish = false;
    h.state.failClear = false;
    const retryOptions = failure === 'finish' ? h.options : metadataOptions(h);
    expect(await h.service.resume(retryOptions))
      .toEqual({ result: { status: 'complete' }, retryOnly: false });
    if (failure !== 'finish') {
      expect(h.native.beginAccountOperation).toHaveBeenCalledTimes(beginCount);
      expect(h.native.finishAccountOperation).toHaveBeenCalledTimes(finishCount);
    }
    expect(h.native.cleanupAccountOperation).toHaveBeenCalledTimes(cleanupCount);
    expect(h.cloud).toHaveBeenCalledTimes(1);
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.state.block).toBeNull();
    expect(h.data.has(CP)).toBe(false);
    expect(h.runtime.clearCompletionAfterSuccessfulFinalization).toHaveBeenCalledTimes(1);
  }

  const orphan = harness();
  orphan.state.block = { version: 1, uid: UID, action: 'delete', operationId: ID };
  expect(await orphan.service.inspectPending()).toEqual({
    checkpoint: null, nativeBlock: orphan.state.block, retryOnly: true,
  });
  expect(orphan.runtime.getAccountCompletionConfirmed(UID)).toBe(false);
  expect(await orphan.service.resume(orphan.options))
    .toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
  expect(orphan.native.beginAccountOperation).not.toHaveBeenCalled();
  expect(orphan.cloud).not.toHaveBeenCalled();
  expect(orphan.runtime.rememberCloudSuccess).not.toHaveBeenCalled();

  expect(await orphan.service.perform('delete', UID, orphan.options))
    .toEqual({ result: { status: 'complete' }, retryOnly: false });
  expect(orphan.native.beginAccountOperation).toHaveBeenCalledTimes(1);
  expect(orphan.native.cleanupAccountOperation).toHaveBeenCalledWith(UID, 'delete', ID);
  expect(orphan.native.finishAccountOperation).toHaveBeenCalledWith(UID, 'delete', ID);
  expect(orphan.native.cancelAccountOperation).not.toHaveBeenCalled();
  expect(orphan.apple).toHaveBeenCalledTimes(1);
  expect(orphan.cloud).toHaveBeenCalledTimes(1);
});

it('finalizes strictly confirmed launch metadata after restart with same/null auth and guards identity changes', async () => {
  for (const action of ['logout', 'delete'] as const) {
    for (const uid of [UID, null]) {
      const h = harness();
      const cp: AccountActionCheckpoint = { uid: UID, action, phase: 'launch' };
      h.data.set(CP, JSON.stringify(cp));
      h.state.uid = uid;
      const records = [h.data.get(SESSIONS), h.data.get(EVENTS)];
      const options = metadataOptions(h);
      expect(await h.service.resume(options))
        .toEqual({ result: { status: 'complete' }, retryOnly: false });
      expect(options.launch).toHaveBeenCalledTimes(1);
      expect([h.data.get(SESSIONS), h.data.get(EVENTS)]).toEqual(records);
      expect(h.native.beginAccountOperation).not.toHaveBeenCalled();
      expect(h.native.inspectAccountOperation).not.toHaveBeenCalled();
      expect(h.native.drainAccountOperation).not.toHaveBeenCalled();
      expect(h.native.cleanupAccountOperation).not.toHaveBeenCalled();
      expect(h.native.finishAccountOperation).not.toHaveBeenCalled();
      expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
      expect(h.flush).not.toHaveBeenCalled();
      expect(h.apple).not.toHaveBeenCalled();
      expect(h.cloud).not.toHaveBeenCalled();
      expect(h.signOut).not.toHaveBeenCalled();
      expect(h.runtime.rememberCloudSuccess).toHaveBeenCalledTimes(1);
      expect(h.runtime.rememberCloudSuccess).toHaveBeenCalledWith(UID);
      expect(h.runtime.getAccountCompletionConfirmed(OTHER)).toBe(false);
      expect(h.runtime.getAccountCompletionConfirmed(UID)).toBe(false);
      expect(h.trace.filter((item) => !item.startsWith('save:')))
        .toEqual(['remember', 'launch', 'release', 'cp-clear', 'forget']);
    }
  }

  for (const failure of ['other-auth', 'read', 'phase', 'uid-during-launch', 'block-during-launch'] as const) {
    const h = harness();
    h.data.set(CP, JSON.stringify({
      uid: UID, action: 'logout',
      phase: failure === 'phase' ? 'local-cleanup' : 'launch',
    }));
    if (failure === 'other-auth') h.state.uid = OTHER;
    if (failure === 'read') h.state.failRead = true;
    const records = [h.data.get(SESSIONS), h.data.get(EVENTS)];
    const options: AccountActionOptions = {
      launch: jest.fn(async () => {
        if (failure === 'uid-during-launch') h.state.uid = OTHER;
        if (failure === 'block-during-launch') {
          h.state.block = { version: 1, uid: UID, action: 'logout', operationId: ID };
        }
      }),
    };
    expect(await h.service.resume(options))
      .toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
    expect(h.data.has(CP)).toBe(true);
    expect([h.data.get(SESSIONS), h.data.get(EVENTS)]).toEqual(records);
    expect(h.native.beginAccountOperation).not.toHaveBeenCalled();
    expect(h.native.cleanupAccountOperation).not.toHaveBeenCalled();
    expect(h.native.finishAccountOperation).not.toHaveBeenCalled();
    expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
    expect(h.cloud).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.runtime.clearCompletionAfterSuccessfulFinalization).not.toHaveBeenCalled();
  }
});

it('requires explicit same-auth native-only identity, preserves replaced IDs and safely cancels a precloud refusal', async () => {
  for (const failure of ['uid', 'null', 'owner', 'action', 'read', 'corrupt', 'replaced-id', 'measuring'] as const) {
    const h = harness();
    h.state.block = { version: 1, uid: UID, action: 'logout', operationId: ID };
    if (failure === 'uid') h.state.uid = OTHER;
    if (failure === 'null') h.state.uid = null;
    if (failure === 'owner') h.state.block.uid = OTHER;
    if (failure === 'action') h.state.block.action = 'delete';
    if (failure === 'read') h.state.failRead = true;
    if (failure === 'corrupt') h.data.set(CP, '{');
    if (failure === 'measuring') h.state.measuring = true;
    const replacementId = '027f7a8c-2c0b-444b-bb3e-47015550ad46';
    if (failure === 'replaced-id') {
      h.native.beginAccountOperation.mockImplementation((uid, action) => {
        h.state.block = { version: 1, uid, action, operationId: replacementId };
        return { ...h.state.block };
      });
    }
    const records = [h.data.get(SESSIONS), h.data.get(EVENTS)];
    const outcome = await h.service.perform('logout', UID, h.options);
    expect(outcome.result.status).toBe('incomplete');
    expect(outcome.retryOnly).toBe(failure !== 'measuring');
    expect([h.data.get(SESSIONS), h.data.get(EVENTS)]).toEqual(records);
    expect(h.cloud).not.toHaveBeenCalled();
    expect(h.apple).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.native.cleanupAccountOperation).not.toHaveBeenCalled();
    expect(h.native.finishAccountOperation).not.toHaveBeenCalled();
    expect(h.runtime.rememberCloudSuccess).not.toHaveBeenCalled();
    if (failure === 'measuring') {
      expect(h.native.cancelAccountOperation).toHaveBeenCalledWith(UID, 'logout', ID);
      expect(h.state.block).toBeNull();
      await expect(h.gate.runNormal(UID, async () => 'available'))
        .resolves.toBe('available');
    } else {
      expect(h.native.cancelAccountOperation).not.toHaveBeenCalled();
      expect(h.state.block).not.toBeNull();
      if (failure === 'replaced-id') {
        expect(h.state.block?.operationId).toBe(replacementId);
      } else {
        expect(h.native.beginAccountOperation).not.toHaveBeenCalled();
      }
    }
  }
});

it('recovers remembered launch after successful remove followed by guard or I/O failure without dropping UI identity', async () => {
  for (const origin of ['cloud', 'validated-checkpoint'] as const) {
    for (const failure of ['guard', 'io-after-remove'] as const) {
      const h = harness();
      if (origin === 'validated-checkpoint') {
        h.data.set(CP, JSON.stringify({ uid: UID, action: 'logout', phase: 'launch' }));
        h.state.uid = null;
      }
      // Save the implementation, not the jest.fn reference (P-078).
      const originalRemove = h.store.removeItem.getMockImplementation()!;
      h.store.removeItem.mockImplementation(async (key: string) => {
        await originalRemove(key);
        if (key === CP) {
          if (failure === 'guard') h.state.uid = OTHER;
          else throw new Error('remove-failed-after-effect');
        }
      });
      const first = origin === 'cloud'
        ? await h.service.perform('logout', UID, h.options)
        : await h.service.resume(metadataOptions(h));
      expect(first).toMatchObject({ result: { status: 'incomplete' }, retryOnly: true });
      expect(h.data.has(CP)).toBe(false);
      expect(h.state.block).toBeNull();
      expect(h.runtime.clearCompletionAfterSuccessfulFinalization).not.toHaveBeenCalled();

      // Another strict runtime read may invalidate its durable checkpoint cache.
      expect(await h.runtime.loadPendingCheckpoint()).toBeNull();
      expect(h.runtime.getAccountCompletionConfirmed(UID)).toBe(true);
      expect(h.runtime.getAccountCompletionConfirmed(OTHER)).toBe(false);
      expect(await h.service.inspectPending()).toEqual({
        checkpoint: { uid: UID, action: 'logout', phase: 'launch' },
        nativeBlock: null,
        retryOnly: true,
      });

      const counts = {
        begin: h.native.beginAccountOperation.mock.calls.length,
        cleanup: h.native.cleanupAccountOperation.mock.calls.length,
        finish: h.native.finishAccountOperation.mock.calls.length,
        cloud: h.cloud.mock.calls.length,
        flush: h.flush.mock.calls.length,
        signOut: h.signOut.mock.calls.length,
      };
      const records = [h.data.get(SESSIONS), h.data.get(EVENTS)];
      h.store.removeItem.mockImplementation(originalRemove);
      h.state.uid = null;
      expect(await h.service.resume(metadataOptions(h)))
        .toEqual({ result: { status: 'complete' }, retryOnly: false });
      expect(h.native.beginAccountOperation).toHaveBeenCalledTimes(counts.begin);
      expect(h.native.cleanupAccountOperation).toHaveBeenCalledTimes(counts.cleanup);
      expect(h.native.finishAccountOperation).toHaveBeenCalledTimes(counts.finish);
      expect(h.cloud).toHaveBeenCalledTimes(counts.cloud);
      expect(h.flush).toHaveBeenCalledTimes(counts.flush);
      expect(h.signOut).toHaveBeenCalledTimes(counts.signOut);
      expect([h.data.get(SESSIONS), h.data.get(EVENTS)]).toEqual(records);
      expect(h.data.has(CP)).toBe(false);
      expect(h.runtime.clearCompletionAfterSuccessfulFinalization).toHaveBeenCalledTimes(1);
      expect(await h.service.inspectPending())
        .toEqual({ checkpoint: null, nativeBlock: null, retryOnly: false });
    }
  }
});
