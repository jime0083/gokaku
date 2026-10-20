import AsyncStorage from '@react-native-async-storage/async-storage';

import { connectFirebaseEmulatorsIfNeeded, getCurrentUid } from '@/config/firebase';

import type { AccountOperationBlock } from '../../../modules/study-sync/src/StudySync.types';
import { callAccountAction } from './accountActionApi';
import {
  clearAccountActionCheckpoint,
  saveAccountActionCheckpoint,
} from './accountActionCheckpoint';
import {
  createAccountActionFlow,
  type AccountAction,
  type AccountActionCheckpoint,
  type AccountActionFlowResult,
} from './accountActionFlow';
import type { AccountOperationLease } from './accountOperationGate';
import * as accountRuntime from './accountOperationRuntime';
import { appleAccountAdapter } from './appleAccountAdapter';
import {
  cleanupLocalAccountData,
  inspectLocalAccountData,
  type LocalAccountStore,
} from './localAccountData';

export type {
  AccountAction,
  AccountActionCheckpoint,
  AccountActionFlowResult,
} from './accountActionFlow';
export type { AccountOperationBlock } from '../../../modules/study-sync/src/StudySync.types';

export type AccountActionNativePort = Pick<
  (typeof import('../../../modules/study-sync/src/StudySyncModule'))['default'],
  | 'getAccountOperationBlock'
  | 'beginAccountOperation'
  | 'inspectAccountOperation'
  | 'drainAccountOperation'
  | 'cleanupAccountOperation'
  | 'finishAccountOperation'
  | 'cancelAccountOperation'
>;

export type AccountActionOptions = Readonly<{
  /** UI keeps its Stack and incomplete overlay mounted while replacing the route. */
  launch: () => Promise<void>;
}>;

export type AccountActionOutcome = Readonly<{
  result: AccountActionFlowResult;
  retryOnly: boolean;
}>;

export type AccountActionPending = Readonly<{
  checkpoint: AccountActionCheckpoint | null;
  nativeBlock: AccountOperationBlock | null;
  retryOnly: boolean;
}>;

/** Share the exported singleton across every public caller. */
export type AccountActionService = Readonly<{
  perform: (
    action: AccountAction,
    expectedUid: string,
    options: AccountActionOptions,
  ) => Promise<AccountActionOutcome>;
  resume: (options: AccountActionOptions) => Promise<AccountActionOutcome>;
  /** Strict read. Rejection means the caller must retain its incomplete overlay. */
  inspectPending: () => Promise<AccountActionPending>;
}>;

export type AccountActionServiceDeps = Readonly<{
  store: LocalAccountStore;
  getCurrentUid: () => string | null;
  getNative: () => AccountActionNativePort;
  runtime: Pick<
    typeof accountRuntime,
    | 'accountOperationGate'
    | 'loadPendingCheckpoint'
    | 'getAccountCompletionConfirmed'
    | 'rememberCloudSuccess'
    | 'clearCompletionAfterSuccessfulFinalization'
  >;
  flushPendingRecords: (
    expectedUid: string,
    accountPermit: AccountOperationLease,
  ) => Promise<boolean>;
  reauthenticateAndRevoke: (expectedUid: string) => Promise<void>;
  /** Must resolve only after the actual Cloud API verifies UID/action success. */
  authAccountAction: (expectedUid: string, action: AccountAction) => Promise<void>;
  signOut: (expectedUid: string) => Promise<void>;
}>;

type Operation = {
  uid: string;
  action: AccountAction;
  native: AccountActionNativePort;
  block: AccountOperationBlock | null;
  permit: AccountOperationLease | null;
  cloudStarted: boolean;
  nativeFinished: boolean;
  metadataOnly: boolean;
};

function checkedBlock(value: AccountOperationBlock | null): AccountOperationBlock | null {
  if (value === null) return null;
  if (
    !value || value.version !== 1 ||
    typeof value.uid !== 'string' || value.uid.trim().length === 0 ||
    (value.action !== 'logout' && value.action !== 'delete') ||
    typeof value.operationId !== 'string' || value.operationId.trim().length === 0
  ) {
    throw new Error('account-service-native-state-invalid');
  }
  return { ...value };
}

function assertExactBlock(
  actual: AccountOperationBlock | null,
  expected: AccountOperationBlock,
): void {
  if (
    actual === null || actual.version !== expected.version ||
    actual.uid !== expected.uid || actual.action !== expected.action ||
    actual.operationId !== expected.operationId
  ) {
    throw new Error('account-service-operation-changed');
  }
}

export function createAccountActionService(
  deps: AccountActionServiceDeps,
): AccountActionService {
  let operation: Operation | null = null;
  let executing = false;
  let launchCallback: AccountActionOptions['launch'] | null = null;
  let explicitRequest: Pick<AccountActionCheckpoint, 'uid' | 'action'> | null = null;
  let cloudEvidence: Pick<AccountActionCheckpoint, 'uid' | 'action'> | null = null;
  // Volatile, existing checkpoint shape only. The flow also remembers launch.
  // Keep its binding available to UI and recovery after a post-remove failure.
  let launchEvidence: AccountActionCheckpoint | null = null;

  function sameIdentity(
    record: Pick<AccountActionCheckpoint, 'uid' | 'action'> | null,
    uid: string,
    action: AccountAction,
  ): boolean {
    return record !== null && record.uid === uid && record.action === action;
  }

  function assertUid(uid: string): void {
    const current = deps.getCurrentUid();
    if (
      current !== uid &&
      !(current === null && deps.runtime.getAccountCompletionConfirmed(uid))
    ) {
      throw new Error('uid-changed');
    }
  }

  function retainLaunchEvidence(checkpoint: AccountActionCheckpoint): void {
    const current = operation;
    if (
      checkpoint.phase !== 'launch' || !current || !current.permit ||
      !sameIdentity(checkpoint, current.uid, current.action) ||
      (launchEvidence !== null &&
        !sameIdentity(launchEvidence, current.uid, current.action)) ||
      (cloudEvidence !== null &&
        !sameIdentity(cloudEvidence, current.uid, current.action))
    ) {
      throw new Error('account-service-completion-conflict');
    }
    assertUid(current.uid);
    current.permit.assertCurrentUid();
    if (!deps.runtime.getAccountCompletionConfirmed(current.uid)) {
      throw new Error('account-service-completion-unconfirmed');
    }
    if (cloudEvidence === null) {
      // A strictly loaded launch checkpoint is already confirmed Cloud progress.
      // Preserve that validated proof before deleting its durable metadata.
      // Native-only metadata never reaches this path and is never proof.
      deps.runtime.rememberCloudSuccess(current.uid);
      cloudEvidence = { uid: current.uid, action: current.action };
    }
    launchEvidence = { ...checkpoint };
  }

  function bound(
    uid?: string,
    action?: AccountAction,
    allowReleased = false,
  ): Operation {
    const current = operation;
    if (
      !current ||
      (uid !== undefined && current.uid !== uid) ||
      (action !== undefined && current.action !== action) ||
      (current.block === null && !current.metadataOnly)
    ) {
      throw new Error('account-service-operation-missing');
    }
    if (
      current.metadataOnly &&
      (
        !current.nativeFinished ||
        !sameIdentity(launchEvidence, current.uid, current.action) ||
        !sameIdentity(cloudEvidence, current.uid, current.action) ||
        !deps.runtime.getAccountCompletionConfirmed(current.uid)
      )
    ) {
      throw new Error('account-service-completion-unconfirmed');
    }
    assertUid(current.uid);
    if (!allowReleased && current.permit === null) {
      throw new Error('account-service-permit-missing');
    }
    current.permit?.assertCurrentUid();
    const actual = checkedBlock(current.native.getAccountOperationBlock());
    if (current.nativeFinished) {
      if (actual !== null) throw new Error('account-service-operation-changed');
    } else {
      if (current.block === null) throw new Error('account-service-operation-missing');
      assertExactBlock(actual, current.block);
    }
    return current;
  }

  function nativeBound(
    uid?: string,
    action?: AccountAction,
    allowReleased = false,
  ): Operation & { block: AccountOperationBlock } {
    const current = bound(uid, action, allowReleased);
    if (current.block === null || current.metadataOnly || current.nativeFinished) {
      throw new Error('account-service-native-operation-required');
    }
    return current as Operation & { block: AccountOperationBlock };
  }

  function guard(uid: string, action?: AccountAction, allowReleased = false) {
    return async (): Promise<void> => {
      bound(uid, action, allowReleased);
    };
  }

  async function releaseOperationBlock(uid: string): Promise<void> {
    const current = operation;
    if (!current || current.uid !== uid || current.permit === null) {
      throw new Error('account-service-operation-missing');
    }
    try {
      const saved = await deps.runtime.loadPendingCheckpoint();
      if (saved === null && !current.cloudStarted && current.block !== null) {
        const held = nativeBound(uid, current.action);
        held.native.cancelAccountOperation(
          uid, held.action, held.block.operationId,
        );
        if (checkedBlock(held.native.getAccountOperationBlock()) !== null) {
          throw new Error('account-service-cancel-incomplete');
        }
      }
    } finally {
      try {
        await deps.runtime.accountOperationGate.releaseAccount(uid);
      } finally {
        current.permit = null;
      }
    }
  }

  async function acquireOperationBlock(
    uid: string,
    action: AccountAction,
  ): Promise<boolean> {
    const permit = await deps.runtime.accountOperationGate.acquireAccount(uid);
    let native: AccountActionNativePort;
    try {
      native = deps.getNative();
    } catch (error) {
      await deps.runtime.accountOperationGate.releaseAccount(uid);
      throw error;
    }
    const previous = operation;
    const current: Operation = {
      uid, action, native, permit, block: null,
      cloudStarted: false, nativeFinished: false, metadataOnly: false,
    };
    operation = current;
    try {
      const saved = await deps.runtime.loadPendingCheckpoint();
      assertUid(uid);
      permit.assertCurrentUid();
      if (saved !== null && !sameIdentity(saved, uid, action)) {
        throw new Error('account-service-checkpoint-conflict');
      }
      const existing = checkedBlock(native.getAccountOperationBlock());

      if (existing === null) {
        const recovery = saved?.phase === 'launch'
          ? saved
          : saved === null && sameIdentity(launchEvidence, uid, action)
            ? launchEvidence
            : null;
        if (recovery !== null) {
          // No native begin/inspect/drain/cleanup/finish or SDK action.
          // The existing JS permit protects checkpoint restoration/finalization.
          current.metadataOnly = true;
          current.nativeFinished = true;
          retainLaunchEvidence(recovery);
          bound(uid, action);
          return true;
        }
        if (saved !== null || launchEvidence !== null || cloudEvidence !== null) {
          throw new Error('account-service-completion-unconfirmed');
        }
      } else {
        if (existing.uid !== uid || existing.action !== action) {
          throw new Error('account-service-operation-changed');
        }
        if (saved === null) {
          // Only the human's explicit same-auth UID/action request may restart
          // a native-only operation from precloud. Resume never infers success.
          if (
            !sameIdentity(explicitRequest, uid, action) ||
            deps.getCurrentUid() !== uid ||
            launchEvidence !== null || cloudEvidence !== null
          ) {
            throw new Error('account-service-explicit-recovery-required');
          }
        }
        if (launchEvidence !== null && previous !== null) {
          if (previous.nativeFinished) {
            throw new Error('account-service-operation-changed');
          }
          if (previous.block !== null) assertExactBlock(existing, previous.block);
        }
      }

      const started = checkedBlock(native.beginAccountOperation(uid, action));
      if (started === null || started.uid !== uid || started.action !== action) {
        throw new Error('account-service-operation-changed');
      }
      // A returned replacement ID is not adopted, cancelled or cleaned up.
      if (existing !== null) assertExactBlock(started, existing);
      current.block = started;
      nativeBound(uid, action);
      return true;
    } catch (error) {
      await releaseOperationBlock(uid);
      throw error;
    }
  }

  const flow = createAccountActionFlow({
    getCurrentUid: deps.getCurrentUid,
    acquireOperationBlock,
    releaseOperationBlock,
    loadCheckpoint: () => deps.runtime.loadPendingCheckpoint(),
    saveCheckpoint: async (checkpoint) => {
      bound(checkpoint.uid, checkpoint.action);
      if (checkpoint.phase === 'launch') retainLaunchEvidence(checkpoint);
      await saveAccountActionCheckpoint(
        checkpoint, deps.store, guard(checkpoint.uid, checkpoint.action),
      );
    },
    inspectLocalState: async (uid) => {
      const held = nativeBound(uid);
      const js = await inspectLocalAccountData(uid, deps.store, guard(uid));
      nativeBound(uid);
      const native = await held.native.inspectAccountOperation(
        uid, held.action, held.block.operationId,
      );
      nativeBound(uid);
      if (
        !native || typeof native.measuring !== 'boolean' ||
        typeof native.pendingRecords !== 'boolean' ||
        (native.ownership !== 'known' && native.ownership !== 'unknown')
      ) {
        throw new Error('account-service-native-state-invalid');
      }
      return {
        measuring: js.measuring || native.measuring,
        ownership: js.ownership === 'known' && native.ownership === 'known'
          ? 'known' : 'unknown',
        pendingRecords: js.pendingRecords || native.pendingRecords,
      };
    },
    syncPendingRecords: async (uid) => {
      const held = nativeBound(uid);
      const complete = await deps.flushPendingRecords(uid, held.permit!);
      nativeBound(uid);
      if (complete !== true) throw new Error('account-service-pending-records');
      await held.native.drainAccountOperation(
        uid, held.action, held.block.operationId,
      );
      nativeBound(uid);
    },
    reauthenticateAndRevoke: async (uid) => {
      nativeBound(uid, 'delete');
      await deps.reauthenticateAndRevoke(uid);
      nativeBound(uid, 'delete');
    },
    authAccountAction: async (uid, action) => {
      const held = nativeBound(uid, action);
      held.cloudStarted = true;
      await deps.authAccountAction(uid, action);
      // Keep actual verified API success before any fallible check or await.
      deps.runtime.rememberCloudSuccess(uid);
      cloudEvidence = { uid, action };
      nativeBound(uid, action);
    },
    cleanupLocalData: async (uid) => {
      const held = nativeBound(uid);
      await cleanupLocalAccountData(uid, deps.store, guard(uid));
      nativeBound(uid);
      await held.native.cleanupAccountOperation(
        uid, held.action, held.block.operationId,
      );
      nativeBound(uid);
    },
    signOut: async (uid) => {
      nativeBound(uid);
      await deps.signOut(uid);
      nativeBound(uid);
    },
    launch: async () => {
      const held = bound();
      const callback = launchCallback;
      if (callback === null) throw new Error('account-service-launch-missing');
      await callback();
      bound(held.uid, held.action);
    },
    clearCheckpoint: async (uid, action) => {
      const held = bound(uid, action, true);
      if (held.permit !== null) throw new Error('account-service-release-required');
      const saved = await deps.runtime.loadPendingCheckpoint();
      bound(uid, action, true);
      if (
        saved === null || !sameIdentity(saved, uid, action) ||
        saved.phase !== 'launch'
      ) {
        throw new Error('account-service-checkpoint-conflict');
      }
      if (!held.nativeFinished) {
        const active = nativeBound(uid, action, true);
        await active.native.finishAccountOperation(
          uid, action, active.block.operationId,
        );
        held.nativeFinished = true;
      }
      bound(uid, action, true);
      await clearAccountActionCheckpoint(
        uid, action, deps.store, guard(uid, action, true),
      );
      // Forget only after the flow's own final post-await UID check succeeds.
    },
  });

  async function inspectPending(): Promise<AccountActionPending> {
    const saved = await deps.runtime.loadPendingCheckpoint();
    if (
      launchEvidence !== null &&
      (
        (saved !== null &&
          !sameIdentity(saved, launchEvidence.uid, launchEvidence.action)) ||
        !deps.runtime.getAccountCompletionConfirmed(launchEvidence.uid)
      )
    ) {
      throw new Error('account-service-completion-conflict');
    }
    const nativeBlock = checkedBlock(deps.getNative().getAccountOperationBlock());
    // Strict durable read always comes first. If remove already succeeded but
    // finalization failed, expose this flow's bound confirmed launch metadata.
    // The always-mounted UI can retain identity and retry without a new format.
    const checkpoint = saved ?? (launchEvidence === null ? null : { ...launchEvidence });
    return {
      checkpoint,
      nativeBlock,
      retryOnly: checkpoint !== null || nativeBlock !== null,
    };
  }

  async function execute(
    task: () => Promise<AccountActionFlowResult>,
    options: AccountActionOptions,
    request?: Pick<AccountActionCheckpoint, 'uid' | 'action'>,
  ): Promise<AccountActionOutcome> {
    if (executing) {
      return { result: { status: 'incomplete', reason: 'busy' }, retryOnly: true };
    }
    executing = true;
    launchCallback = options.launch;
    explicitRequest = request ?? null;
    try {
      let result = await task();
      if (result.status === 'complete') {
        try {
          const completed = bound(undefined, undefined, true);
          if (!completed.nativeFinished || completed.permit !== null) {
            throw new Error('account-service-finalization-incomplete');
          }
          deps.runtime.clearCompletionAfterSuccessfulFinalization(completed.uid);
          launchEvidence = null;
          cloudEvidence = null;
        } catch {
          result = { status: 'incomplete', reason: 'retry-required' };
        }
      }
      let retryOnly = true;
      try {
        retryOnly = (await inspectPending()).retryOnly;
      } catch {
        // Strict read failure retains the retry-only overlay.
      }
      return { result, retryOnly };
    } finally {
      launchCallback = null;
      explicitRequest = null;
      executing = false;
    }
  }

  return Object.freeze({
    perform: (action, expectedUid, options) =>
      execute(() => flow.run(action, expectedUid), options, { uid: expectedUid, action }),
    resume: (options) => execute(() => flow.resume(), options),
    inspectPending,
  });
}

const defaultDeps: AccountActionServiceDeps = {
  store: AsyncStorage,
  getCurrentUid,
  runtime: accountRuntime,
  getNative: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../../../modules/study-sync/src/StudySyncModule') as
      typeof import('../../../modules/study-sync/src/StudySyncModule')).default;
  },
  flushPendingRecords: async (uid, permit) => {
    // Dedicated account sender; never pass the account permit to runNormal.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sender = require('../timer/studyEventSender') as
      typeof import('../timer/studyEventSender');
    return sender.flushStudyEventQueueForAccount(uid, permit);
  },
  reauthenticateAndRevoke: appleAccountAdapter.reauthenticateAndRevoke,
  authAccountAction: callAccountAction,
  signOut: async (uid) => {
    connectFirebaseEmulatorsIfNeeded();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@react-native-firebase/auth') as
      typeof import('@react-native-firebase/auth');
    const auth = sdk.getAuth();
    if (auth.currentUser?.uid !== uid) throw new Error('uid-changed');
    await sdk.signOut(auth);
  },
};

/** Construction/import does not load native SDKs or perform production actions. */
export const accountActionService: AccountActionService =
  createAccountActionService(defaultDeps);
