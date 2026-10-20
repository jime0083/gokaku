import AsyncStorage from '@react-native-async-storage/async-storage';

import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from './types';

/**
 * 登録前の入力の端末への一時保存(requirements 4-1)。
 * 登録(3-5)が成功したら clearOnboardingDraft で消す。
 */
export const ONBOARDING_DRAFT_STORAGE_KEY = 'onboarding:draft:v1';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 保存されていた値の形が壊れている場合に初期値へフォールバックする(壊れたデータで次へ進めなくなることを防ぐ) */
export function sanitizeOnboardingDraft(value: unknown): OnboardingDraft {
  if (!isPlainObject(value)) {
    return INITIAL_ONBOARDING_DRAFT;
  }
  const merged: OnboardingDraft = { ...INITIAL_ONBOARDING_DRAFT };
  if (value.type === 'exam' || value.type === 'cert') merged.type = value.type;
  if (typeof value.university === 'string') merged.university = value.university;
  if (typeof value.targetDeviationText === 'string') {
    merged.targetDeviationText = value.targetDeviationText;
  }
  if (typeof value.currentDeviationText === 'string') {
    merged.currentDeviationText = value.currentDeviationText;
  }
  if (Number.isSafeInteger(value.subjectCount)) {
    merged.subjectCount = value.subjectCount as number;
  }
  if (typeof value.certId === 'string' || value.certId === null) {
    merged.certId = value.certId as string | null;
  }
  if (typeof value.certOtherName === 'string') merged.certOtherName = value.certOtherName;
  if (typeof value.targetHoursText === 'string') merged.targetHoursText = value.targetHoursText;
  // 古い形式の保存データ(このフィールドがまだ無い時期に保存されたもの)は undefined になるため、
  // その場合は初期値(null = 自動入力の記録なし)のままにする(壊れたデータとして扱わない)
  if (typeof value.autoFilledTargetHoursText === 'string' || value.autoFilledTargetHoursText === null) {
    merged.autoFilledTargetHoursText = value.autoFilledTargetHoursText as string | null;
  }
  if (typeof value.examDate === 'string' || value.examDate === null) {
    merged.examDate = value.examDate as string | null;
  }
  if (typeof value.minDailyMinutes === 'number' || value.minDailyMinutes === null) {
    merged.minDailyMinutes = value.minDailyMinutes as number | null;
  }
  if (typeof value.goalDailyMinutes === 'number' || value.goalDailyMinutes === null) {
    merged.goalDailyMinutes = value.goalDailyMinutes as number | null;
  }
  return merged;
}

/** 端末に一時保存された入力を読み込む(保存がない・壊れている場合は初期値) */
export async function loadOnboardingDraft(): Promise<OnboardingDraft> {
  const raw = await AsyncStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);
  if (raw === null) {
    return INITIAL_ONBOARDING_DRAFT;
  }
  try {
    return sanitizeOnboardingDraft(JSON.parse(raw));
  } catch {
    return INITIAL_ONBOARDING_DRAFT;
  }
}

/** 入力中の値を端末に一時保存する */
export async function saveOnboardingDraft(draft: OnboardingDraft): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

/** 登録できたら一時保存を消す(3-5 で呼ぶ) */
export async function clearOnboardingDraft(): Promise<void> {
  await AsyncStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
}
