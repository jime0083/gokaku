/**
 * オンボーディング(受験ルート)の入力チェック(requirements 4-1・4-2、mokuhyo.txt 1)。
 *
 * - 範囲・刻みの判定は shared/ の定数・関数を使い、ここでは重複実装しない
 * - 戻り値はエラーメッセージ(文字列)。問題なければ null
 * - 日付の「今日」判定は呼び出し側から now(epoch ミリ秒)を渡してもらう(テスト可能にするため。requirements 3-1)
 */
import {
  DAILY_MINUTES_RANGE,
  DEVIATION_RANGE,
  TARGET_HOURS_RANGE,
  diffDays,
  isValidDailyMinutes,
  isValidDeviationValue,
  isValidTargetHours,
  isValidDateKey,
  toJstDateKey,
  type DateKey,
} from '@shared/index';

/** 自由入力(目標大学・資格名その他)の最大文字数(mokuhyo.txt 1) */
export const FREE_TEXT_MAX_LENGTH = 50;

/** 目標大学の入力チェック(1〜50文字、前後の空白は除く) */
export function validateUniversity(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '目標大学を入力してください';
  }
  if (trimmed.length > FREE_TEXT_MAX_LENGTH) {
    return `目標大学は${FREE_TEXT_MAX_LENGTH}文字以内で入力してください`;
  }
  return null;
}

/** 資格名(その他)の入力チェック(1〜50文字、前後の空白は除く。requirements 4-3) */
export function validateCertOtherName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '資格名を入力してください';
  }
  if (trimmed.length > FREE_TEXT_MAX_LENGTH) {
    return `資格名は${FREE_TEXT_MAX_LENGTH}文字以内で入力してください`;
  }
  return null;
}

/** 数字キーボードのテキストを数値に変換する(空文字・数値でない場合は null) */
function parseDecimal(text: string): number | null {
  if (text.trim().length === 0) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 偏差値(目標・現在共通)の入力チェック */
export function validateDeviation(text: string, label: string): string | null {
  const value = parseDecimal(text);
  if (value === null) {
    return `${label}を入力してください`;
  }
  if (!isValidDeviationValue(value)) {
    return `${label}は${DEVIATION_RANGE.min}〜${DEVIATION_RANGE.max}の範囲で、0.1刻みで入力してください`;
  }
  return null;
}

/** 目標偏差値が現在の偏差値以下か(概算を出さず「届いています」を表示する条件) */
export function isDeviationAlreadyReached(currentText: string, targetText: string): boolean {
  const current = parseDecimal(currentText);
  const target = parseDecimal(targetText);
  if (current === null || target === null) return false;
  return target <= current;
}

/** 目標勉強時間の入力チェック(1〜20,000時間の整数) */
export function validateTargetHours(text: string): string | null {
  const value = parseDecimal(text);
  if (value === null) {
    return '目標勉強時間を入力してください';
  }
  if (!isValidTargetHours(value)) {
    return `目標勉強時間は${TARGET_HOURS_RANGE.min}〜${TARGET_HOURS_RANGE.max}時間の整数で入力してください`;
  }
  return null;
}

/** 試験日(受験日)の入力チェック(明日以降。requirements 3-1 の日本時間判定を使う) */
export function validateExamDate(examDate: DateKey | null, now: number): string | null {
  if (examDate === null) {
    return '試験日を選択してください';
  }
  if (!isValidDateKey(examDate)) {
    return '試験日を選択してください';
  }
  const today = toJstDateKey(now);
  if (diffDays(today, examDate) < 1) {
    return '試験日は明日以降の日付を選択してください';
  }
  return null;
}

/** 1日の最低・努力目標勉強時間(分)の入力チェック(10分〜16時間、10分刻み) */
export function validateDailyMinutes(minutes: number | null, label: string): string | null {
  if (minutes === null) {
    return `${label}を選択してください`;
  }
  if (!isValidDailyMinutes(minutes)) {
    const maxHours = DAILY_MINUTES_RANGE.max / 60;
    return `${label}は${DAILY_MINUTES_RANGE.min}分〜${maxHours}時間の範囲で、10分刻みで選択してください`;
  }
  return null;
}

/** 努力目標勉強時間 ≥ 1日の最低勉強時間、のチェック(両方確定している場合のみ判定) */
export function validateGoalNotLessThanMin(
  minMinutes: number | null,
  goalMinutes: number | null,
): string | null {
  if (minMinutes === null || goalMinutes === null) return null;
  if (goalMinutes < minMinutes) {
    return '1日の努力目標勉強時間は、1日の最低勉強時間以上にしてください';
  }
  return null;
}
