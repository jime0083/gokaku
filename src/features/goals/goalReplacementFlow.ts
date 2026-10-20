import type StudySyncModule from '../../../modules/study-sync/src/StudySyncModule';
import { getCurrentUid } from '@/config/firebase';
import type { AccountOperationLease } from '@/features/account/accountOperationGate';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';
import { clearGoalReplacement, loadGoalReplacement, saveGoalReplacement, type GoalReplacementDraft } from '@/features/onboarding/replacementStorage';
import { INITIAL_ONBOARDING_DRAFT } from '@/features/onboarding/types';
import { findActiveSession, loadLocalSessions, removeReplacedLocalSessions } from '@/features/timer/storage';
import { loadStudyEventQueue } from '@/features/timer/studyEventQueue';
import { flushStudyEventQueue } from '@/features/timer/studyEventSender';
import { fetchActiveGoalId } from './activeGoalRepository';
import { replaceGoal } from './replaceGoalRepository';

function native(): typeof StudySyncModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../modules/study-sync/src/StudySyncModule').default;
}

export const REPLACEMENT_COMMUNICATION_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';
export class ReplacementMeasuringError extends Error {
  constructor() { super('計測中です。先にタイマーを停止してください'); }
}
function assertUid(uid: string, lease?: AccountOperationLease): void {
  lease?.assertCurrentUid();
  if (!uid || getCurrentUid() !== uid) throw new Error('ログイン中のユーザーが変わりました。ホームからやり直してください');
}
export async function assertReplacementStopped(lease?: AccountOperationLease): Promise<void> {
  lease?.assertCurrentUid();
  const sessions = await loadLocalSessions();
  lease?.assertCurrentUid();
  if (findActiveSession(sessions) || native().getActiveSession()) throw new ReplacementMeasuringError();
}
async function assertGoal(record: GoalReplacementDraft, lease: AccountOperationLease): Promise<void> {
  assertUid(record.uid, lease);
  const goalId = await fetchActiveGoalId();
  assertUid(record.uid, lease);
  if (goalId !== (record.committedGoalId ?? record.expectedGoalId)) throw new Error(REPLACEMENT_COMMUNICATION_ERROR);
}
export async function beginGoalReplacement(expectedGoalId: string, expectedUid: string | null = getCurrentUid()): Promise<GoalReplacementDraft> {
  const uid = getCurrentUid();
  if (!uid) throw new Error(REPLACEMENT_COMMUNICATION_ERROR);
  if (uid !== expectedUid) throw new Error(REPLACEMENT_COMMUNICATION_ERROR);
  return accountOperationGate.runNormal(uid, async (lease) => {
    await assertReplacementStopped(lease); lease.assertCurrentUid(); assertUid(uid, lease);
    const saved = await loadGoalReplacement(uid); assertUid(uid, lease);
    const record = saved ?? { uid, expectedGoalId, draft: { ...INITIAL_ONBOARDING_DRAFT } };
    await assertGoal(record, lease); assertUid(record.uid, lease);
    await saveGoalReplacement(record, lease); assertUid(uid, lease);
    return record;
  });
}
/** nowを注入する。API成功を記憶してからローカル後処理を行うため、後処理失敗を新commitで再試行しない。 */
export async function submitGoalReplacement(record: GoalReplacementDraft, now: number): Promise<void> {
  return accountOperationGate.runNormal(record.uid, async (lease) => {
    assertUid(record.uid, lease);
    if (!record.committedGoalId) {
      await assertReplacementStopped(lease); lease.assertCurrentUid();
      await assertGoal(record, lease); assertUid(record.uid, lease);
      await saveGoalReplacement(record, lease); assertUid(record.uid, lease);
      await flushStudyEventQueue(lease); assertUid(record.uid, lease);
      const pending = await loadStudyEventQueue(); assertUid(record.uid, lease);
      if (pending.length !== 0) throw new Error(REPLACEMENT_COMMUNICATION_ERROR);
      await assertReplacementStopped(lease); lease.assertCurrentUid();
      await assertGoal(record, lease); assertUid(record.uid, lease);
      const oldSessions = await loadLocalSessions(); assertUid(record.uid, lease);
      if (findActiveSession(oldSessions) || native().getActiveSession()) throw new ReplacementMeasuringError();
      record.oldSessionIds = oldSessions.map((session) => session.sessionId);
      await saveGoalReplacement(record, lease); assertUid(record.uid, lease);
      await assertReplacementStopped(lease); lease.assertCurrentUid();
      await assertGoal(record, lease); assertUid(record.uid, lease);
      const result = await replaceGoal(record.uid, record.expectedGoalId, record.draft, now);
      // 後処理の失敗を再commitで再試行しない。
      record.committedGoalId = result.goalId;
    }
    assertUid(record.uid, lease);
    await saveGoalReplacement(record, lease); assertUid(record.uid, lease);
    const guardCleanup = async () => {
      await assertGoal(record, lease); assertUid(record.uid, lease);
      await assertReplacementStopped(lease); lease.assertCurrentUid();
      assertUid(record.uid, lease);
    };
    await guardCleanup();
    assertUid(record.uid, lease);
    native().setCurrentGoalIdForAccount(record.uid, record.committedGoalId);
    await removeReplacedLocalSessions(record.oldSessionIds ?? [], guardCleanup); assertUid(record.uid, lease);
    await guardCleanup();
    const lastStop = native().getLastLockscreenStop();
    if (lastStop && record.oldSessionIds?.includes(lastStop.sessionId)) {
      assertUid(record.uid, lease);
      native().clearLastLockscreenStop();
    }
    // autoStopNoticeにはsessionIdがないため、新しいお知らせを誤って消さないよう保持する。
    await clearGoalReplacement(record.uid, lease); assertUid(record.uid, lease);
  });
}
