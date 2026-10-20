export type AccountOperationLease = Readonly<{
  assertCurrentUid: () => void;
}>;

export type AccountOperationGateDeps = Readonly<{
  getCurrentUid: () => string | null;
  // Synchronous, side-effect-free evidence for this exact UID.
  // True only for a validated, cloud-success-confirmed checkpoint phase.
  // Never infer confirmation from missing auth or cloud-pending metadata.
  getAccountCompletionConfirmed: (expectedUid: string) => boolean;
  // Global OR of JS checkpoint existence and native blocked state.
  // Reject on unreadable/corrupt state; never translate unknown into false.
  readDurableBlocked: () => Promise<boolean>;
}>;

/**
 * Share one instance across all JS writers and account-action callers.
 * A root covers its entire writer, including HTTP and post-response persistence.
 * Await every async child; fire-and-forget work is outside this contract.
 * Pass the explicit root lease to nested runNormal calls and await their results.
 * Call lease.assertCurrentUid() after awaits and immediately before side effects.
 * Account permits are used directly by dedicated account operations, never as
 * normal-writer leases. Release only after all account operations have settled.
 * Only account permits accept null auth with current completion evidence.
 * This gate neither creates nor clears durable checkpoints.
 */
export function createAccountOperationGate(deps: AccountOperationGateDeps) {
  type NormalState = { uid: string; active: boolean };
  type AccountState = { uid: string; active: boolean };
  const normalLeases = new WeakMap<AccountOperationLease, NormalState>();
  let account: AccountState | null = null;
  let inflight = 0;
  let onIdle: (() => void) | undefined;

  function assertUid(uid: string): void {
    if (!uid || deps.getCurrentUid() !== uid) throw new Error('uid-changed');
  }

  function assertAccountUid(uid: string): void {
    if (!uid) throw new Error('uid-changed');
    const currentUid = deps.getCurrentUid();
    if (currentUid === uid) return;
    if (
      currentUid === null &&
      deps.getAccountCompletionConfirmed(uid) === true
    ) return;
    throw new Error('uid-changed');
  }

  async function readBlocked(): Promise<boolean> {
    try {
      const blocked = await deps.readDurableBlocked();
      if (typeof blocked !== 'boolean') throw new Error('invalid-state');
      return blocked;
    } catch {
      throw new Error('durable-unknown');
    }
  }

  async function runNormal<T>(
    expectedUid: string,
    task: (lease: AccountOperationLease) => Promise<T>,
    parentLease?: AccountOperationLease,
  ): Promise<T> {
    let lease: AccountOperationLease;
    let rootState: NormalState | undefined;
    if (parentLease !== undefined) {
      const state = normalLeases.get(parentLease);
      if (!state?.active || state.uid !== expectedUid) {
        throw new Error('invalid-lease');
      }
      parentLease.assertCurrentUid();
      lease = parentLease;
    } else {
      if (account !== null) throw new Error('normal-blocked');
      assertUid(expectedUid);
      const state: NormalState = { uid: expectedUid, active: true };
      rootState = state;
      lease = Object.freeze({
        assertCurrentUid: () => {
          if (!state.active) throw new Error('expired-lease');
          assertUid(state.uid);
        },
      });
      normalLeases.set(lease, state);
    }

    // Reserve synchronously, including time spent reading durable state.
    // Already-admitted roots may finish while account acquisition is waiting.
    inflight += 1;
    try {
      if (rootState && await readBlocked()) throw new Error('normal-blocked');
      lease.assertCurrentUid();
      return await task(lease);
    } finally {
      if (rootState) rootState.active = false;
      inflight -= 1;
      if (inflight === 0) {
        const resolve = onIdle;
        onIdle = undefined;
        resolve?.();
      }
    }
  }

  async function acquireAccount(expectedUid: string): Promise<AccountOperationLease> {
    if (account !== null) throw new Error('account-busy');
    assertAccountUid(expectedUid);
    const state: AccountState = { uid: expectedUid, active: false };
    // Close admission before the first await, including competing acquisitions.
    account = state;
    try {
      if (inflight !== 0) {
        await new Promise<void>((resolve) => { onIdle = resolve; });
      }
      assertAccountUid(expectedUid);
      state.active = true;
      return Object.freeze({
        assertCurrentUid: () => {
          if (account !== state || !state.active) throw new Error('expired-lease');
          assertAccountUid(expectedUid);
        },
      });
    } catch (error) {
      if (account === state) account = null;
      throw error;
    }
  }

  async function releaseAccount(expectedUid: string): Promise<void> {
    if (account !== null) {
      if (account.uid !== expectedUid) throw new Error('account-owner');
      if (!account.active) throw new Error('account-busy');
      account.active = false;
      account = null;
    }
    // Release never clears durable blocking. Every new root reads it afresh;
    // true remains blocked and unknown rejects even after this permit expires.
    await readBlocked();
  }

  return { runNormal, acquireAccount, releaseAccount } as const;
}
