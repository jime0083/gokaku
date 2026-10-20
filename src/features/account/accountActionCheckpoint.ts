import type { AsyncStorageStatic } from '@react-native-async-storage/async-storage';
import type { AccountAction, AccountActionCheckpoint } from './accountActionFlow';

export const ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY = 'account:action:v1';

export type AccountCheckpointStore = Pick<
  AsyncStorageStatic, 'getItem' | 'setItem' | 'removeItem'
>;
export type AccountCheckpointGuard = () => Promise<void>;

const PHASES: readonly AccountActionCheckpoint['phase'][] = [
  'cloud-pending', 'local-cleanup', 'sign-out', 'launch',
];

// All checkpoint callers must use this module in the same JS runtime.
// Native leases and the durable producer gate are managed by the caller.
let operations: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = operations.then(task, task);
  operations = result.catch(() => undefined);
  return result;
}

function identity(uid: unknown, action: unknown): void {
  if (
    typeof uid !== 'string' || uid.length === 0 ||
    (action !== 'logout' && action !== 'delete')
  ) {
    throw new Error('account-checkpoint-invalid');
  }
}

function checkpoint(value: unknown): AccountActionCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('account-checkpoint-invalid');
  }
  const record = value as Record<string, unknown>;
  const fields = ['uid', 'action', 'phase'];
  if (
    Object.keys(record).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  ) {
    throw new Error('account-checkpoint-invalid');
  }
  identity(record.uid, record.action);
  if (!PHASES.includes(record.phase as AccountActionCheckpoint['phase'])) {
    throw new Error('account-checkpoint-invalid');
  }
  return {
    uid: record.uid as string,
    action: record.action as AccountAction,
    phase: record.phase as AccountActionCheckpoint['phase'],
  };
}

async function read(
  store: AccountCheckpointStore,
  guard: AccountCheckpointGuard,
): Promise<AccountActionCheckpoint | null> {
  await guard();
  const raw = await store.getItem(ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY);
  await guard();
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('account-checkpoint-invalid');
  }
  return checkpoint(value);
}

function sameIdentity(
  saved: AccountActionCheckpoint,
  uid: string,
  action: AccountAction,
): void {
  if (saved.uid !== uid || saved.action !== action) {
    throw new Error('account-checkpoint-conflict');
  }
}

/**
 * Guard validates the bound operation identity and lease after its own awaits.
 * Whether confirmed progress permits null auth is exclusively caller policy.
 * Missing storage alone means null; corrupt/unknown formats and I/O errors throw.
 */
export function loadAccountActionCheckpoint(
  store: AccountCheckpointStore,
  guard: AccountCheckpointGuard,
): Promise<AccountActionCheckpoint | null> {
  return serialize(() => read(store, guard));
}

/** Save metadata only; snapshot arguments before waiting for other operations. */
export async function saveAccountActionCheckpoint(
  value: AccountActionCheckpoint,
  store: AccountCheckpointStore,
  guard: AccountCheckpointGuard,
): Promise<void> {
  const next = checkpoint(value);
  return serialize(async () => {
    const saved = await read(store, guard);
    await guard();
    if (saved) {
      sameIdentity(saved, next.uid, next.action);
      if (PHASES.indexOf(next.phase) < PHASES.indexOf(saved.phase)) {
        throw new Error('account-checkpoint-regression');
      }
      if (saved.phase === next.phase) return;
    }
    // No await between the last guard and starting the write.
    await store.setItem(
      ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY,
      JSON.stringify(next),
    );
    await guard();
  });
}

/** Missing is idempotent; an existing different UID/action is never removed. */
export async function clearAccountActionCheckpoint(
  uid: string,
  action: AccountAction,
  store: AccountCheckpointStore,
  guard: AccountCheckpointGuard,
): Promise<void> {
  identity(uid, action);
  return serialize(async () => {
    const saved = await read(store, guard);
    await guard();
    if (saved === null) return;
    sameIdentity(saved, uid, action);
    await store.removeItem(ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY);
    await guard();
  });
}
