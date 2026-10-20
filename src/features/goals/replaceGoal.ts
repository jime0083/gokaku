import { buildGoalDocument } from './buildGoalDocument';
import { GoalRejectedByServerError, type SaveGoalFirestoreDeps, type SaveGoalTransaction } from './saveGoal';
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
  getCurrentUid: () => string | null;
  getGoalDocRef: (uid: string, goalId: string) => Ref;
  runTransaction: <T>(body: (tx: ReplaceGoalTransaction<Ref>) => Promise<T>) => Promise<T>;
};
export type ReplaceGoalParams = {
  expectedUid: string; expectedGoalId: string; draft: OnboardingDraft; now: number;
};
export type ReplaceGoalResult = { goalId: string; goal: GoalDocument };

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
      const user = await tx.get(userRef);
      const old = await tx.get(oldRef);
      if (!user.exists() || user.data()?.activeGoalId !== oldId || !old.exists() || old.data()?.status !== 'active') {
        throw new GoalReplacementConflictError();
      }
      guardAuth();
      tx.update(oldRef, { status: 'replaced' });
      tx.set(newRef, goal);
      tx.update(userRef, { activeGoalId: goalId });
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.endsWith('permission-denied')) throw new GoalRejectedByServerError(error);
    throw error;
  }
  return { goalId, goal };
}
