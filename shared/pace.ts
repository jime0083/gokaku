/**
 * ペース確認画面の計算(requirements 4-4)。
 *
 * - D = 今日から試験日の前日までの日数(今日を含む)。今日 = 登録日 = now の日本時間の日付。
 *   D = 試験日 − 今日(日数)。試験日が明日なら D = 1
 * - 最低ペースの合計 = 1日の最低勉強時間 × D、努力目標ペースの合計 = 1日の努力目標勉強時間 × D
 *   (いずれも分。目標勉強時間に対する%は小数点1桁で切り捨て)
 * - 最低ペースの合計 < 目標勉強時間 の場合は警告を出し、
 *   目標達成に必要な1日の時間 = 目標勉強時間 ÷ D を10分単位に切り上げた値を返す
 * - 警告が出ていても登録できる(登録可否はここでは扱わない)
 *
 * 不正な入力:
 * - 試験日が今日以前(D ≤ 0。画面表示中に日付が変わった場合など)は例外にせず
 *   { status: 'exam_date_not_future' } を返す(UI は入力画面に戻して試験日を選び直させる)
 * - 目標勉強時間・1日の時間が整数でない/0 以下、試験日が実在しない日付、now が不正 → RangeError
 *   (入力範囲(1〜20,000時間、10分〜16時間、努力目標 ≥ 最低)のチェックは入力画面の責務とし、ここでは行わない)
 */

import { type DateKey, diffDays, isValidDateKey, toJstDateKey } from './date';
import { ceilDivToStep, floorPercent } from './displayNumber';

/** 目標達成に必要な1日の時間の切り上げ単位(分) */
export const REQUIRED_DAILY_MINUTES_STEP = 10;

/** 1時間の分数 */
export const MINUTES_PER_HOUR = 60;

export type PaceInput = {
  /** 目標勉強時間(時間。goals.targetHours) */
  targetHours: number;
  /** 試験日(goals.examDate) */
  examDate: DateKey;
  /** 1日の最低勉強時間(分) */
  minDailyMinutes: number;
  /** 1日の努力目標勉強時間(分) */
  goalDailyMinutes: number;
};

/** 1日の時間 × D の合計 */
export type PaceTotal = {
  /** 合計(分) */
  totalMinutes: number;
  /** 目標勉強時間に対する%(小数点1桁で切り捨て。100% 超も実数) */
  percent: number;
};

export type PaceResult =
  | { status: 'exam_date_not_future'; today: DateKey }
  | {
      status: 'ok';
      today: DateKey;
      /** 今日から試験日の前日までの日数(今日を含む。1 以上) */
      days: number;
      /** 目標勉強時間(分) */
      targetMinutes: number;
      minPace: PaceTotal;
      goalPace: PaceTotal;
      /** 最低ペースの合計 < 目標勉強時間 */
      warning: boolean;
      /** 目標達成に必要な1日の時間(分。10分単位に切り上げ)。warning が false のときは null */
      requiredDailyMinutes: number | null;
    };

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} は 1 以上の整数である必要があります: ${value}`);
  }
}

/** 目標勉強時間(時間) → 分 */
export function targetHoursToMinutes(targetHours: number): number {
  assertPositiveInteger(targetHours, 'targetHours');
  return targetHours * MINUTES_PER_HOUR;
}

function paceTotal(dailyMinutes: number, days: number, targetMinutes: number): PaceTotal {
  const totalMinutes = dailyMinutes * days;
  if (!Number.isSafeInteger(totalMinutes)) {
    throw new RangeError(`ペースの合計が大きすぎます: ${dailyMinutes} × ${days}`);
  }
  return { totalMinutes, percent: floorPercent(totalMinutes, targetMinutes) };
}

/** ペース確認画面の数値を求める。now は epoch ミリ秒(登録する時点の現在時刻) */
export function calculatePace(input: PaceInput, now: number): PaceResult {
  const { targetHours, examDate, minDailyMinutes, goalDailyMinutes } = input;
  if (!Number.isFinite(now)) {
    throw new RangeError(`now は有限の数値(epoch ミリ秒)である必要があります: ${now}`);
  }
  if (!isValidDateKey(examDate)) {
    throw new RangeError(`examDate は実在する 'YYYY-MM-DD' である必要があります: ${examDate}`);
  }
  const targetMinutes = targetHoursToMinutes(targetHours);
  assertPositiveInteger(minDailyMinutes, 'minDailyMinutes');
  assertPositiveInteger(goalDailyMinutes, 'goalDailyMinutes');

  const today = toJstDateKey(now);
  const days = diffDays(today, examDate);
  if (days <= 0) {
    return { status: 'exam_date_not_future', today };
  }

  const minPace = paceTotal(minDailyMinutes, days, targetMinutes);
  const goalPace = paceTotal(goalDailyMinutes, days, targetMinutes);
  const warning = minPace.totalMinutes < targetMinutes;
  return {
    status: 'ok',
    today,
    days,
    targetMinutes,
    minPace,
    goalPace,
    warning,
    requiredDailyMinutes: warning
      ? ceilDivToStep(targetMinutes, days, REQUIRED_DAILY_MINUTES_STEP)
      : null,
  };
}
