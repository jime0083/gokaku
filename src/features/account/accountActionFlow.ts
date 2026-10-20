export type AccountAction = 'logout' | 'delete';

export type AccountActionCheckpoint = Readonly<{
  uid: string;
  action: AccountAction;
  phase: 'cloud-pending' | 'local-cleanup' | 'sign-out' | 'launch';
}>;

export type AccountActionFlowResult =
  | Readonly<{ status: 'complete' }>
  | Readonly<{
    status: 'incomplete';
    reason:
      | 'busy'
      | 'uid-changed'
      | 'measuring'
      | 'unknown-owner'
      | 'pending-records'
      | 'retry-required'
      | 'checkpoint-conflict';
  }>;

type IncompleteReason = Extract<
  AccountActionFlowResult,
  { status: 'incomplete' }
>['reason'];

export type AccountLocalState = Readonly<{
  measuring: boolean;
  ownership: 'known' | 'unknown';
  pendingRecords: boolean;
}>;

/**
 * Integration contract:
 * - Share one flow instance across all account-action callers.
 * - Every port binds its work to the expected UID, including checks inside the
 *   adapter after awaits and immediately before side effects. Preserve other
 *   UIDs' data, queues and credentials. Never infer ownership from current auth.
 * - acquireOperationBlock resolves true only after both native and JS producers
 *   and competing writers are blocked. It must not auto-stop a measurement.
 *   Failed acquisition must roll back any partially acquired execution lease.
 * - inspect/sync/cleanup run under that lease. inspect covers both native and JS;
 *   "known" means every affected record has provable ownership. pendingRecords
 *   describes this UID's unsent records, not another UID's queue.
 * - The execution lease and the durable normal-producer gate are distinct.
 *   releaseOperationBlock releases only this operation's execution lease. Native
 *   and JS normal producers remain blocked while any durable account-action
 *   checkpoint exists, including cloud-pending after a partial server failure.
 *   Release must consult authoritative durable state; unknown state fails closed.
 *   It never clears account data, checkpoints or another UID's lease.
 * - Acquisition/release are retryable. Acquisition must roll back partial leases
 *   on failure without opening a producer gate protected by a checkpoint.
 *   On restart, adapters must restore the durable gate before enabling producers.
 * - clearCheckpoint removes only matching UID/action metadata, then reconciles
 *   the producer gate against remaining durable checkpoints and execution leases.
 *   Normal producers may resume only when neither remains. Partial clear/release
 *   failures must be safely retryable and must not prematurely reopen producers.
 * - Before checkpoint creation, measuring/unknown-owner/Apple cancellation may
 *   release the execution lease and restore normal operation if durable state
 *   proves no checkpoint remains. A failed/uncertain durable read stays blocked.
 * - While a checkpoint remains, public UI exposes retry only. launch must honor
 *   this gate and must not enable normal measurement or writing by navigation.
 * - authAccountAction resolves only on a verified success response for this UID
 *   and action. It is idempotent. Auth disappearing is not success evidence.
 * - Checkpoints are durable non-secret metadata only. Saving cannot overwrite
 *   another UID/action's unfinished operation. Cleanup must preserve checkpoints.
 * - cleanup, signOut and launch are retryable/idempotent, including after partial
 *   success. Confirmed local finish permits null auth, never a different UID.
 *   The launch adapter must check the bound operation identity before navigation.
 * - Successful cloud action followed by failed checkpoint persistence is retained
 *   in this instance. Restart cannot recover that volatile evidence: resume stops
 *   at cloud-pending. Explicit run retry requires the same authenticated UID.
 */
export type AccountActionFlowDeps = Readonly<{
  getCurrentUid: () => string | null;
  acquireOperationBlock: (expectedUid: string, action: AccountAction) => Promise<boolean>;
  releaseOperationBlock: (expectedUid: string) => Promise<void>;
  inspectLocalState: (expectedUid: string) => Promise<AccountLocalState>;
  syncPendingRecords: (expectedUid: string) => Promise<void>;
  reauthenticateAndRevoke: (expectedUid: string) => Promise<void>;
  authAccountAction: (expectedUid: string, action: AccountAction) => Promise<void>;
  cleanupLocalData: (expectedUid: string) => Promise<void>;
  signOut: (expectedUid: string) => Promise<void>;
  launch: () => Promise<void>;
  loadCheckpoint: () => Promise<AccountActionCheckpoint | null>;
  saveCheckpoint: (checkpoint: AccountActionCheckpoint) => Promise<void>;
  clearCheckpoint: (expectedUid: string, action: AccountAction) => Promise<void>;
}>;

export type AccountActionFlow = Readonly<{
  run: (action: AccountAction, expectedUid: string) => Promise<AccountActionFlowResult>;
  resume: () => Promise<AccountActionFlowResult>;
}>;

class FlowStopped extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
  }
}

function incomplete(reason: IncompleteReason): AccountActionFlowResult {
  return { status: 'incomplete', reason };
}

function isAction(action: unknown): action is AccountAction {
  return action === 'logout' || action === 'delete';
}

function isCheckpoint(value: unknown): value is AccountActionCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.uid === 'string' && record.uid.length > 0 &&
    isAction(record.action) &&
    (
      record.phase === 'cloud-pending' ||
      record.phase === 'local-cleanup' ||
      record.phase === 'sign-out' ||
      record.phase === 'launch'
    ) &&
    Object.keys(record).length === 3
  );
}

type RequestedAction = Readonly<{ uid: string; action: AccountAction }>;

export function createAccountActionFlow(deps: AccountActionFlowDeps): AccountActionFlow {
  let busy = false;
  // Never replace confirmed in-memory progress with a stale durable checkpoint.
  let remembered: AccountActionCheckpoint | null = null;

  function assertUid(record: AccountActionCheckpoint): void {
    const currentUid = deps.getCurrentUid();
    const confirmed = record.phase !== 'cloud-pending';
    if (currentUid !== record.uid && !(confirmed && currentUid === null)) {
      throw new FlowStopped('uid-changed');
    }
  }

  async function boundCall<T>(
    record: AccountActionCheckpoint,
    call: () => Promise<T>,
  ): Promise<T> {
    assertUid(record);
    const result = await call();
    assertUid(record);
    return result;
  }

  async function persist(record: AccountActionCheckpoint): Promise<void> {
    // Keep success evidence before any fallible persistence or identity check.
    remembered = { ...record };
    await boundCall(record, () => deps.saveCheckpoint({ ...record }));
  }

  async function inspect(
    record: AccountActionCheckpoint,
    requireEmpty: boolean,
  ): Promise<void> {
    const state = await boundCall(record, () => deps.inspectLocalState(record.uid));
    // Fail closed even when an adapter violates its declared return type.
    if (!state || typeof state.measuring !== 'boolean') {
      throw new FlowStopped('retry-required');
    }
    if (state.measuring) throw new FlowStopped('measuring');
    if (state.ownership !== 'known') throw new FlowStopped('unknown-owner');
    if (typeof state.pendingRecords !== 'boolean') {
      throw new FlowStopped('retry-required');
    }
    if (requireEmpty && state.pendingRecords) {
      throw new FlowStopped('pending-records');
    }
  }

  async function attempt(request?: RequestedAction): Promise<AccountActionFlowResult> {
    let record: AccountActionCheckpoint | null = null;
    let acquiredUid: string | null = null;
    let result: AccountActionFlowResult = incomplete('retry-required');

    try {
      if (request) {
        if (!request.uid || !isAction(request.action)) {
          throw new FlowStopped('checkpoint-conflict');
        }
        const currentUid = deps.getCurrentUid();
        if (currentUid !== null && currentUid !== request.uid) {
          throw new FlowStopped('uid-changed');
        }
      }

      const uidBeforeLoad = deps.getCurrentUid();
      if (remembered) {
        record = { ...remembered };
      } else {
        const saved = await deps.loadCheckpoint();
        if (saved !== null) {
          if (!isCheckpoint(saved)) throw new FlowStopped('checkpoint-conflict');
          record = { ...saved };
        }
      }

      if (!record) {
        if (!request) throw new FlowStopped('retry-required');
        record = { ...request, phase: 'cloud-pending' };
      }

      if (
        request &&
        (record.uid !== request.uid || record.action !== request.action)
      ) {
        throw new FlowStopped('checkpoint-conflict');
      }
      if (uidBeforeLoad !== null && uidBeforeLoad !== record.uid) {
        throw new FlowStopped('uid-changed');
      }
      assertUid(record);

      // Automatic restart recovery cannot establish success from pending metadata.
      if (!request && record.phase === 'cloud-pending') {
        throw new FlowStopped('retry-required');
      }

      assertUid(record);
      const acquired = await deps.acquireOperationBlock(record.uid, record.action);
      // Record acquisition before checking identity so finally can release it.
      if (acquired !== true) throw new FlowStopped('retry-required');
      acquiredUid = record.uid;
      assertUid(record);

      if (record.phase === 'cloud-pending') {
        await inspect(record, false);
        await boundCall(record, () => deps.syncPendingRecords(record!.uid));
        await inspect(record, true);

        if (record.action === 'delete') {
          await boundCall(record, () => deps.reauthenticateAndRevoke(record!.uid));
          await inspect(record, true);
        }

        await persist(record);
        await inspect(record, true);
        assertUid(record);

        // This call can remove the Auth user. Store success before the post-await
        // UID check, so null is allowed and a different UID still stops cleanup.
        await deps.authAccountAction(record.uid, record.action);
        record = { ...record, phase: 'local-cleanup' };
        await persist(record);
      } else {
        // A prior save may have failed after success was remembered in memory.
        // Persist again before attempting any further local side effects.
        await persist(record);
      }

      if (record.phase === 'local-cleanup') {
        await inspect(record, true);
        await boundCall(record, () => deps.cleanupLocalData(record!.uid));
        record = { ...record, phase: 'sign-out' };
        await persist(record);
      }

      if (record.phase === 'sign-out') {
        assertUid(record);
        if (deps.getCurrentUid() !== null) {
          await boundCall(record, () => deps.signOut(record!.uid));
        }
        record = { ...record, phase: 'launch' };
        await persist(record);
      }

      await boundCall(record, () => deps.launch());
      result = { status: 'complete' };
    } catch (error) {
      result = incomplete(error instanceof FlowStopped ? error.reason : 'retry-required');
    } finally {
      if (acquiredUid !== null) {
        try {
          // Release only the execution lease. The adapter keeps normal producers
          // blocked while a durable checkpoint remains, including on failure.
          await deps.releaseOperationBlock(acquiredUid);
          if (record) assertUid(record);
        } catch {
          result = incomplete('retry-required');
        }
      }
    }

    // Retain the launch checkpoint until both launch and lease release succeed.
    // Clear reconciles the durable producer gate only after finishing the action.
    if (result.status === 'complete' && record) {
      try {
        const completed = record;
        await boundCall(completed, () =>
          deps.clearCheckpoint(completed.uid, completed.action),
        );
        remembered = null;
      } catch (error) {
        return incomplete(error instanceof FlowStopped ? error.reason : 'retry-required');
      }
    }
    return result;
  }

  async function execute(request?: RequestedAction): Promise<AccountActionFlowResult> {
    if (busy) return incomplete('busy');
    // Set synchronously before the first await.
    busy = true;
    try {
      return await attempt(request);
    } finally {
      busy = false;
    }
  }

  return {
    run: (action, expectedUid) => execute({ uid: expectedUid, action }),
    resume: () => execute(),
  };
}
