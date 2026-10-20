import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';

import { saveGoalEdit, type GoalEditDraft, type GoalEditPatch } from './editGoal';
import type { GoalDocument } from './types';

/** Numeric-only, single updateDoc write. No merge-set that could create an incomplete goal. */
export async function updateGoalNumbers(
  goalId: string, type: GoalDocument['type'], draft: GoalEditDraft, now: number,
): Promise<GoalEditPatch> {
  const uid = getCurrentUid();
  if (!uid) throw new Error('ログインしていません');
  return saveGoalEdit({
    update: async (owner, id, patch) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
      const { getFirestore, doc, updateDoc } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/firestore') as typeof RNFBFirestore;
      await updateDoc(doc(getFirestore(getApp()), 'users', owner, 'goals', id), patch);
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
