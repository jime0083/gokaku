import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AccountOperationLease } from '@/features/account/accountOperationGate';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';
import { sanitizeOnboardingDraft } from './storage';
import type { OnboardingDraft } from './types';

/** 初回登録draftとは別の、UID・変更元目標に結び付いた入力。commit後は後処理だけ再開する。 */
export type GoalReplacementDraft = {
  uid: string;
  expectedGoalId: string;
  draft: OnboardingDraft;
  committedGoalId?: string;
  /** commit前の旧ローカル記録だけを後処理で除去する。 */
  oldSessionIds?: string[];
};
const KEY_PREFIX = 'onboarding:replacement:v1:';
const key = (uid: string) => KEY_PREFIX + encodeURIComponent(uid);
let writes: Promise<void> = Promise.resolve();
function serialize(
  uid: string,
  task: () => Promise<void>,
  parentLease?: AccountOperationLease,
): Promise<void> {
  const previous = writes;
  const result = accountOperationGate.runNormal(uid, async (lease) => {
    await previous;
    lease.assertCurrentUid();
    await task();
    lease.assertCurrentUid();
  }, parentLease);
  // gateの待機開始時からloadにも保存待ちを見せる。
  writes = result.catch(() => undefined);
  return result;
}
export async function loadGoalReplacement(uid: string): Promise<GoalReplacementDraft | null> {
  await writes;
  const raw = await AsyncStorage.getItem(key(uid));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.uid !== uid || typeof value.expectedGoalId !== 'string' || !value.expectedGoalId ||
      (value.committedGoalId !== undefined && (typeof value.committedGoalId !== 'string' || !value.committedGoalId))) return null;
    return { uid, expectedGoalId: value.expectedGoalId, draft: sanitizeOnboardingDraft(value.draft),
      ...(value.committedGoalId ? { committedGoalId: value.committedGoalId } : {}),
      oldSessionIds: Array.isArray(value.oldSessionIds) ? value.oldSessionIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0) : [] };
  } catch { return null; }
}
export function saveGoalReplacement(
  record: GoalReplacementDraft,
  parentLease?: AccountOperationLease,
): Promise<void> {
  // gate/直列化のawait前に所有UIDと保存内容を固定する。
  const uid = record.uid;
  const storageKey = key(uid);
  const raw = JSON.stringify(record);
  return serialize(uid, () => AsyncStorage.setItem(storageKey, raw), parentLease);
}
export function clearGoalReplacement(
  uid: string,
  parentLease?: AccountOperationLease,
): Promise<void> {
  const storageKey = key(uid);
  return serialize(uid, () => AsyncStorage.removeItem(storageKey), parentLease);
}
