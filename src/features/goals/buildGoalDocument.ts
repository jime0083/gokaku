import {
  calculateExamEstimatedHours,
  diffDays,
  getCertificationEstimate,
  isValidDailyMinutes,
  isValidDateKey,
  isValidDeviationValue,
  isValidSubjectCount,
  isValidTargetHours,
  toJstDateKey,
} from '@shared/index';

import { OTHER_CERTIFICATION_ID, type OnboardingDraft } from '../onboarding/types';
import { validateCertOtherName, validateUniversity } from '../onboarding/validation';
import type { CertGoalDocument, ExamGoalDocument, GoalDocument } from './types';

/**
 * 登録前の入力(OnboardingDraft)から goals ドキュメントの内容を組み立てる(requirements 4-2・4-3・5)。
 *
 * draft は各入力画面(受験ルート・資格ルート)で requirements 4-1・4-2・4-3 のチェックを経ているはずだが、
 * ここでも最終防御として shared/ の範囲チェックを行う(範囲外・未入力なら RangeError)。
 * 現在時刻(登録日)は呼び出し側から now(epoch ミリ秒)で渡す(テスト可能にするため)
 */
export function buildGoalDocument(draft: OnboardingDraft, now: number): GoalDocument {
  const examDate = draft.examDate;
  if (examDate === null || !isValidDateKey(examDate)) {
    throw new RangeError('試験日が未入力、または不正です');
  }

  const targetHours = parseIntegerText(draft.targetHoursText, '目標勉強時間');
  if (!isValidTargetHours(targetHours)) {
    throw new RangeError(`目標勉強時間が範囲外です: ${targetHours}`);
  }

  if (draft.minDailyMinutes === null || !isValidDailyMinutes(draft.minDailyMinutes)) {
    throw new RangeError(`1日の最低勉強時間が未入力、または範囲外です: ${draft.minDailyMinutes}`);
  }
  if (draft.goalDailyMinutes === null || !isValidDailyMinutes(draft.goalDailyMinutes)) {
    throw new RangeError(`1日の努力目標勉強時間が未入力、または範囲外です: ${draft.goalDailyMinutes}`);
  }
  if (draft.goalDailyMinutes < draft.minDailyMinutes) {
    throw new RangeError('1日の努力目標勉強時間は、1日の最低勉強時間以上である必要があります');
  }

  const startDate = toJstDateKey(now);
  if (diffDays(startDate, examDate) < 1) {
    throw new RangeError('試験日は登録日の翌日以降である必要があります');
  }

  const common = {
    estimatedHours: null,
    targetHours,
    examDate,
    minDailyMinutes: draft.minDailyMinutes,
    goalDailyMinutes: draft.goalDailyMinutes,
    startDate,
    status: 'active' as const,
    createdAt: now,
  };

  if (draft.type === 'exam') {
    return buildExamGoal(draft, common);
  }
  if (draft.type === 'cert') {
    return buildCertGoal(draft, common);
  }
  throw new RangeError(`draft.type は exam/cert である必要があります: ${draft.type}`);
}

function buildExamGoal(
  draft: OnboardingDraft,
  common: Omit<ExamGoalDocument, 'type' | 'university' | 'targetDeviation' | 'currentDeviation' | 'subjectCount'>,
): ExamGoalDocument {
  const universityError = validateUniversity(draft.university);
  if (universityError) {
    throw new RangeError(universityError);
  }

  const targetDeviation = parseDecimalText(draft.targetDeviationText, '目標偏差値');
  const currentDeviation = parseDecimalText(draft.currentDeviationText, '現在の偏差値');
  if (!isValidDeviationValue(targetDeviation) || !isValidDeviationValue(currentDeviation)) {
    throw new RangeError(`偏差値が範囲外です: 目標=${targetDeviation} 現在=${currentDeviation}`);
  }
  if (!isValidSubjectCount(draft.subjectCount)) {
    throw new RangeError(`受験科目数が範囲外です: ${draft.subjectCount}`);
  }

  const estimatedHours = calculateExamEstimatedHours({
    currentDeviation,
    targetDeviation,
    subjectCount: draft.subjectCount,
  });

  return {
    ...common,
    type: 'exam',
    university: draft.university.trim(),
    targetDeviation,
    currentDeviation,
    subjectCount: draft.subjectCount,
    estimatedHours,
  };
}

function buildCertGoal(
  draft: OnboardingDraft,
  common: Omit<CertGoalDocument, 'type' | 'certId' | 'certOtherName'>,
): CertGoalDocument {
  if (draft.certId === null) {
    throw new RangeError('目標資格が未選択です');
  }

  if (draft.certId === OTHER_CERTIFICATION_ID) {
    const certOtherNameError = validateCertOtherName(draft.certOtherName);
    if (certOtherNameError) {
      throw new RangeError(certOtherNameError);
    }
    return {
      ...common,
      type: 'cert',
      certId: draft.certId,
      certOtherName: draft.certOtherName.trim(),
      estimatedHours: null,
    };
  }

  // 一覧にない id は getCertificationEstimate が RangeError を投げる
  const certification = getCertificationEstimate(draft.certId);
  return {
    ...common,
    type: 'cert',
    certId: draft.certId,
    certOtherName: '',
    estimatedHours: {
      status: 'ok',
      lowerHours: certification.lowerHours,
      upperHours: certification.upperHours,
    },
  };
}

function parseIntegerText(text: string, label: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label}が未入力、または数値ではありません: ${text}`);
  }
  return value;
}

function parseDecimalText(text: string, label: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label}が未入力、または数値ではありません: ${text}`);
  }
  return value;
}
