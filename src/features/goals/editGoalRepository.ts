import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';
import {
  isJudgementSnapshot, isTimestampLike, type JudgementSnapshots,
} from '@shared/judgementHistory';

import { getCurrentUid } from '@/config/firebase';

import { saveGoalEdit, type GoalEditDraft, type GoalEditPatch } from './editGoal';
import type { GoalDocument } from './types';

const JUDGEMENT_STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

function assertGoalEditUid(uid: string): void {
  if (getCurrentUid() !== uid) throw new Error('ログイン状態が変更されました');
}

/** 両metadata absentだけがlegacy。部分metadataや不正counterは書込み前に拒否する。 */
function goalEditRevisions(
  user: Record<string, unknown>,
  isTimestamp: (value: unknown) => boolean,
): (Record<string, unknown> & { goal: number }) | null {
  const hasStartedAt = Object.prototype.hasOwnProperty.call(user, 'judgementHistoryStartedAt');
  const hasRevisions = Object.prototype.hasOwnProperty.call(user, 'judgementRevisions');
  if (!hasStartedAt && !hasRevisions) return null;

  const revisions = user.judgementRevisions;
  if (
    !hasStartedAt || !hasRevisions
    || !isTimestamp(user.judgementHistoryStartedAt)
    || !isTimestampLike(user.judgementHistoryStartedAt)
    || typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)
  ) {
    throw new Error('判定履歴のmetadataが不正です');
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

/** raw goalの最小projection。欠損・不正値をnullや画面初期値へ置き換えない。 */
function goalHistorySnapshot(
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

/** Numeric-only partial update; initialized users also save history in the same transaction. */
export async function updateGoalNumbers(
  goalId: string, type: GoalDocument['type'], draft: GoalEditDraft, now: number,
): Promise<GoalEditPatch> {
  const uid = getCurrentUid();
  if (!uid) throw new Error('ログインしていません');
  return saveGoalEdit({
    update: async (owner, id, patch) => {
      assertGoalEditUid(owner);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
      const { getFirestore, doc, runTransaction, serverTimestamp, Timestamp } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/firestore') as typeof RNFBFirestore;
      const db = getFirestore(getApp());
      const userRef = doc(db, 'users', owner);
      const goalRef = doc(db, 'users', owner, 'goals', id);

      await runTransaction(db, async (tx) => {
        // SDK retryごとにUID・親・現在goal・counterを読み直す。
        assertGoalEditUid(owner);
        const userDoc = await tx.get(userRef);
        assertGoalEditUid(owner);
        const user = userDoc.exists() ? userDoc.data() : undefined;
        if (!user || user.deletionInProgress === true || user.activeGoalId !== id) {
          throw new Error('有効な目標がありません');
        }

        assertGoalEditUid(owner);
        const goalDoc = await tx.get(goalRef);
        assertGoalEditUid(owner);
        const current = goalDoc.exists() ? goalDoc.data() : undefined;
        if (!current || current.status !== 'active' || current.type !== type) {
          throw new Error('有効な目標がありません');
        }

        const revisions = goalEditRevisions(user, (value) => value instanceof Timestamp);
        const entry = revisions ? {
          schemaVersion: 1,
          revision: revisions.goal + 1,
          committedAt: serverTimestamp(),
          before: goalHistorySnapshot(id, current),
          after: goalHistorySnapshot(id, { ...current, ...patch }),
        } : null;

        assertGoalEditUid(owner);
        // updateなので既存goalを作成せず、開始日・登録時概算等も上書きしない。
        tx.update(goalRef, patch);
        if (revisions && entry) {
          tx.update(userRef, {
            judgementRevisions: { ...revisions, goal: entry.revision },
          });
          tx.set(doc(
            db, 'users', owner, 'judgementHistory', 'goal', 'entries', String(entry.revision),
          ), entry);
        }
      });
    },
  }, { uid, goalId, type, draft, now });
}

/** Read enough of the existing goal to prefill edits, without applying creation-date validation. */
export function parseEditableGoal(data: Record<string, unknown> | undefined): GoalDocument | undefined {
  if (!data || data.status !== 'active' || typeof data.startDate !== 'string' || typeof data.examDate !== 'string'
    || typeof data.createdAt !== 'number' || !('estimatedHours' in data)
    || !['targetHours', 'minDailyMinutes', 'goalDailyMinutes'].every((key) => typeof data[key] === 'number')) {
    return undefined;
  }
  if (data.type === 'exam' && typeof data.university === 'string'
    && ['targetDeviation', 'currentDeviation', 'subjectCount'].every((key) => typeof data[key] === 'number')) {
    return data as GoalDocument;
  }
  if (data.type === 'cert' && typeof data.certId === 'string' && typeof data.certOtherName === 'string') {
    return data as GoalDocument;
  }
  return undefined;
}
