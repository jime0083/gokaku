import { isValidSubjectCount, type DateKey } from '@shared/index';

import {
  validateDailyMinutes, validateDeviation, validateExamDate, validateGoalNotLessThanMin, validateTargetHours,
} from '../onboarding/validation';
import type { GoalDocument } from './types';

/** Popup-local values. Never written into onboarding storage. */
export type GoalEditDraft = {
  targetHoursText: string;
  examDate: DateKey;
  minDailyMinutes: number;
  goalDailyMinutes: number;
  targetDeviationText: string;
  currentDeviationText: string;
  subjectCount: number;
};
export type GoalEditPatch = {
  targetHours: number;
  examDate: DateKey;
  minDailyMinutes: number;
  goalDailyMinutes: number;
  targetDeviation?: number;
  currentDeviation?: number;
  subjectCount?: number;
};

export function createGoalEditDraft(goal: GoalDocument): GoalEditDraft {
  return {
    targetHoursText: String(goal.targetHours), examDate: goal.examDate,
    minDailyMinutes: goal.minDailyMinutes, goalDailyMinutes: goal.goalDailyMinutes,
    targetDeviationText: goal.type === 'exam' ? String(goal.targetDeviation) : '',
    currentDeviationText: goal.type === 'exam' ? String(goal.currentDeviation) : '',
    subjectCount: goal.type === 'exam' ? goal.subjectCount : 0,
  };
}

export function validateGoalEditDraft(type: GoalDocument['type'], draft: GoalEditDraft, now: number) {
  return {
    targetHours: validateTargetHours(draft.targetHoursText),
    examDate: validateExamDate(draft.examDate, now),
    minDailyMinutes: validateDailyMinutes(draft.minDailyMinutes, '1日の最低勉強時間'),
    goalDailyMinutes: validateDailyMinutes(draft.goalDailyMinutes, '1日の努力目標勉強時間'),
    dailyOrder: validateGoalNotLessThanMin(draft.minDailyMinutes, draft.goalDailyMinutes),
    targetDeviation: type === 'exam' ? validateDeviation(draft.targetDeviationText, '目標偏差値') : null,
    currentDeviation: type === 'exam' ? validateDeviation(draft.currentDeviationText, '現在の偏差値') : null,
    subjectCount: type === 'exam' && !isValidSubjectCount(draft.subjectCount) ? '受験科目数は1〜8科目で選択してください' : null,
  };
}

/** Construct an explicit allowlist patch; no spreading goal documents or caller input into writes. */
export function buildGoalEditPatch(type: GoalDocument['type'], draft: GoalEditDraft, now: number): GoalEditPatch {
  const errors = validateGoalEditDraft(type, draft, now);
  const error = Object.values(errors).find((value) => value !== null);
  if (error) throw new RangeError(error);
  const patch: GoalEditPatch = {
    targetHours: Number(draft.targetHoursText), examDate: draft.examDate,
    minDailyMinutes: draft.minDailyMinutes, goalDailyMinutes: draft.goalDailyMinutes,
  };
  if (type === 'exam') {
    patch.targetDeviation = Number(draft.targetDeviationText);
    patch.currentDeviation = Number(draft.currentDeviationText);
    patch.subjectCount = draft.subjectCount;
  }
  return patch;
}

export type GoalEditDeps = {
  update: (uid: string, goalId: string, patch: GoalEditPatch) => Promise<void>;
};

export async function saveGoalEdit(deps: GoalEditDeps, params: {
  uid: string; goalId: string; type: GoalDocument['type']; draft: GoalEditDraft; now: number;
}): Promise<GoalEditPatch> {
  if (!params.uid || !params.goalId) throw new Error('有効な目標がありません');
  const patch = buildGoalEditPatch(params.type, params.draft, params.now);
  // A single document update is atomic, and never creates/replaces a goal or touches history.
  await deps.update(params.uid, params.goalId, patch);
  return patch;
}
