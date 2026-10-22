import { isJudgementSnapshot, isTimestampLike, type JudgementSnapshots } from '@shared/judgementHistory';

import { buildGoalDocument } from './buildGoalDocument';
import { GoalRejectedByServerError, type SaveGoalFirestoreDeps, type SaveGoalHistoryDeps, type SaveGoalTransaction } from './saveGoal';
import type { GoalDocument } from './types';
import type { OnboardingDraft } from '../onboarding/types';

export class GoalReplacementAuthError extends Error {
  constructor() { super('目標変更を開始したユーザーとログイン中のユーザーが一致しません'); this.name = 'GoalReplacementAuthError'; }
}
export class GoalReplacementConflictError extends Error {
  constructor() { super('変更元の目標が現在の有効な目標ではありません'); this.name = 'GoalReplacementConflictError'; }
}
export type ReplaceGoalTransaction<Ref> = SaveGoalTransaction<Ref> & {
  update: (ref: Ref, data: Record<string, unknown>) => unknown;
};
export type ReplaceGoalDeps<Ref> = Omit<SaveGoalFirestoreDeps<Ref>, 'runTransaction'> & {
  /** 両metadata absentのlegacyだけは履歴依存なしで保存できる。 */
  history?: SaveGoalHistoryDeps<Ref>;
  getCurrentUid: () => string | null;
  getGoalDocRef: (uid: string, goalId: string) => Ref;
  runTransaction: <T>(body: (tx: ReplaceGoalTransaction<Ref>) => Promise<T>) => Promise<T>;
};
export type ReplaceGoalParams = {
  expectedUid: string; expectedGoalId: string; draft: OnboardingDraft; now: number;
};
export type ReplaceGoalResult = { goalId: string; goal: GoalDocument };


const JUDGEMENT_STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

/** C/Dと同じmetadata判定。部分metadataをlegacyへ落とさない。 */
function replacementGoalRevisions<Ref>(
  user: Record<string, unknown>,
  history: SaveGoalHistoryDeps<Ref> | undefined,
): (Record<string, unknown> & { goal: number }) | null {
  const hasStartedAt = Object.prototype.hasOwnProperty.call(user, 'judgementHistoryStartedAt');
  const hasRevisions = Object.prototype.hasOwnProperty.call(user, 'judgementRevisions');
  if (!hasStartedAt && !hasRevisions) return null;

  const revisions = user.judgementRevisions;
  if (
    !hasStartedAt || !hasRevisions || !history
    || !history.isTimestamp(user.judgementHistoryStartedAt)
    || !isTimestampLike(user.judgementHistoryStartedAt)
    || typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)
  ) {
    throw new Error('判定履歴のmetadataまたは保存依存が不正です');
  }
  const counters = revisions as Record<string, unknown>;
  for (const stream of JUDGEMENT_STREAMS) {
    const revision = counters[stream];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error('判定履歴のrevisionが不正です');
    }
  }
  if (!Number.isSafeInteger((counters.goal as number) + 1)) {
    throw new Error('判定履歴のrevisionが上限に達しています');
  }
  return counters as Record<string, unknown> & { goal: number };
}

/** 保存時readの値を最小projectionにし、不正値は補完しない。 */
function replacementGoalSnapshot(
  goalId: string, goal: Record<string, unknown>,
): NonNullable<JudgementSnapshots['goal']> {
  const snapshot = {
    goalId,
    startDate: goal.startDate,
    examDate: goal.examDate,
    minDailyMinutes: goal.minDailyMinutes,
    goalDailyMinutes: goal.goalDailyMinutes,
  };
  if (!isJudgementSnapshot('goal', snapshot)) {
    throw new Error('判定履歴の目標snapshotが不正です');
  }
  return snapshot;
}

/** 6-3a: Only persist the replacement. Caller clears inputs/queues and navigates after commit. */
export async function replaceGoal<Ref>(deps: ReplaceGoalDeps<Ref>, params: ReplaceGoalParams): Promise<ReplaceGoalResult> {
  const { expectedUid: uid, expectedGoalId: oldId } = params;
  const guardAuth = () => {
    if (!uid || deps.getCurrentUid() !== uid) throw new GoalReplacementAuthError();
  };
  guardAuth();
  if (!oldId || oldId.includes('/') || uid.includes('/')) throw new RangeError('ユーザー・目標IDが不正です');
  const goal = buildGoalDocument(params.draft, params.now);
  // Stable reference across Firestore transaction retries; never reuse the old document.
  const { ref: newRef, id: goalId } = deps.createGoalDocRef(uid);
  if (!goalId || goalId === oldId) throw new GoalReplacementConflictError();
  const userRef = deps.getUserDocRef(uid);
  const oldRef = deps.getGoalDocRef(uid, oldId);
  try {
    await deps.runTransaction(async (tx) => {
      guardAuth();
      const userDoc = await tx.get(userRef);
      guardAuth();
      const oldDoc = await tx.get(oldRef);
      guardAuth();
      const user = userDoc.exists() ? userDoc.data() : undefined;
      const old = oldDoc.exists() ? oldDoc.data() : undefined;
      if (!user || user.deletionInProgress === true || user.activeGoalId !== oldId
        || !old || old.status !== 'active') {
        throw new GoalReplacementConflictError();
      }

      // retryごとに現在のmetadataと旧goalから作成する。
      const revisions = replacementGoalRevisions(user, deps.history);
      const entry = revisions ? {
        schemaVersion: 1,
        revision: revisions.goal + 1,
        committedAt: deps.history!.serverTimestamp(),
        before: replacementGoalSnapshot(oldId, old),
        after: replacementGoalSnapshot(goalId, goal),
      } : null;
      const entryRef = entry ? deps.history!.getEntryDocRef(uid, entry.revision) : undefined;

      guardAuth();
      tx.update(oldRef, { status: 'replaced' });
      tx.set(newRef, goal);
      if (revisions && entry) {
        tx.update(userRef, {
          activeGoalId: goalId,
          judgementRevisions: { ...revisions, goal: entry.revision },
        });
        tx.set(entryRef!, entry);
      } else {
        tx.update(userRef, { activeGoalId: goalId });
      }
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.endsWith('permission-denied')) throw new GoalRejectedByServerError(error);
    throw error;
  }
  return { goalId, goal };
}
