import AsyncStorage from '@react-native-async-storage/async-storage';

import { getCurrentUid } from '@/config/firebase';

import { loadAccountActionCheckpoint } from './accountActionCheckpoint';
import type { AccountActionCheckpoint } from './accountActionFlow';
import { createAccountOperationGate } from './accountOperationGate';

let validatedCheckpoint: AccountActionCheckpoint | null = null;
const cloudSuccessUids = new Set<string>();
let evidenceRevision = 0;

function assertUid(uid: string): void {
  if (typeof uid !== 'string' || uid.trim().length === 0) {
    throw new Error('account-runtime-invalid-uid');
  }
}

/** Public metadata read: strict storage validation, without inferring auth success. */
export async function loadPendingCheckpoint(): Promise<AccountActionCheckpoint | null> {
  const revision = ++evidenceRevision;
  validatedCheckpoint = null;
  const saved = await loadAccountActionCheckpoint(AsyncStorage, async () => undefined);
  if (revision === evidenceRevision) {
    validatedCheckpoint = saved === null ? null : { ...saved };
  }
  return saved;
}

/** Side-effect-free, synchronous evidence for this exact UID only. */
export function getAccountCompletionConfirmed(expectedUid: string): boolean {
  return cloudSuccessUids.has(expectedUid) || (
    validatedCheckpoint !== null &&
    validatedCheckpoint.uid === expectedUid &&
    validatedCheckpoint.phase !== 'cloud-pending'
  );
}

/** Call immediately after verified cloud success, BEFORE any fallible save/check. */
export function rememberCloudSuccess(uid: string): void {
  assertUid(uid);
  cloudSuccessUids.add(uid);
}

/**
 * Finalization adapter only: call after launch, lease release and matching durable
 * checkpoint/native finalization have ALL succeeded. Never call on release alone,
 * failed persistence, auth changes, cancellation or an incomplete operation.
 * This forgets evidence only; it cannot erase metadata or open the durable gate.
 */
export function clearCompletionAfterSuccessfulFinalization(uid: string): void {
  assertUid(uid);
  evidenceRevision += 1;
  cloudSuccessUids.delete(uid);
  if (validatedCheckpoint?.uid === uid) validatedCheckpoint = null;
}

async function readDurableBlocked(): Promise<boolean> {
  if (await loadPendingCheckpoint() !== null) return true;
  // Detailed native getters acquire a lease and may be busy. Status must use
  // the lease-free persistent snapshot, with no missing-API/unknown fallback.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const native = (require('../../../modules/study-sync/src/StudySyncModule') as
    typeof import('../../../modules/study-sync/src/StudySyncModule')).default;
  const blocked = native.isAccountOperationBlocked();
  if (typeof blocked !== 'boolean') throw new Error('account-native-state-invalid');
  return blocked;
}

/** Import this singleton from every JS writer and account-action adapter. */
export const accountOperationGate = createAccountOperationGate({
  getCurrentUid,
  getAccountCompletionConfirmed,
  readDurableBlocked,
});
