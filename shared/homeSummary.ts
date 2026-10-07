/**
 * ホーム画面の数値(requirements 4-6、3-3、3-5)。
 *
 * 積み上げ時間(分):
 * - 現在の目標の開始日〜今日の、日ごとの勉強時間の合計
 * - 判定済みの日(その目標の dailyResults がある日)は dailyResults.studiedMinutes(0:00 に確定した値)を正とする
 * - 判定していない日(dailyResults がない日。当日・0:00 の判定処理が終わる前の前日・課金切れで判定しなかった日)は、
 *   その目標(goalId)のセッションから計算して積み上げに含める(studyCheck の aggregateEffectiveDailyStudyMinutes。
 *   now 時点の状態)。達成日数・経過日数には数えない(requirements 3-3。2026-10-07 決定)
 * - 開始日より前の日付と今日より後の日付(端末時刻のずれ等)は、計測・dailyResults のどちらも数えない
 *   (dailyResults は今日の日付のものも数えない。今日はまだ判定していないためセッションから計算する)
 *
 * 達成率: 積み上げ ÷ 目標勉強時間 × 100 を小数点1桁で切り捨て(100% 超は実数)。スライダー用は 0〜1 に丸めた値
 * 達成日数: 判定済み(その目標の dailyResults)の metMin / metGoal の数。経過日数 = その目標の dailyResults の件数
 *   (課金切れで判定しなかった日は dailyResults がないため数えない)
 * あと○日: 今日から試験日までの日数。試験日当日以降は exam_date_reached(「お疲れさまでした」表示用)
 * 残り必要時間: 目標勉強時間 − 積み上げ。0 以下は 0 とし targetReached = true(「達成済み」表示用)
 *
 * 不正なセッション(時刻が不正などで RangeError)はそのセッションだけを除外して excludedSessions で返す(判定と同じ扱い)。
 * 目標・dailyResults・now が不正な場合は RangeError。
 */

import { type DateKey, diffDays, isValidDateKey, toJstDateKey } from './date';
import type { ExcludedSession, JudgementSession } from './dailyJudgement';
import { floorPercent } from './displayNumber';
import { targetHoursToMinutes } from './pace';
import { partitionGoalSessions } from './sessionFilter';
import { aggregateEffectiveDailyStudyMinutes, type CheckedStudySession, resolveSessionEnd } from './studyCheck';

/** ホームの計算に使う目標の値(users/{uid}/goals/{goalId} の該当項目) */
export type HomeGoal = {
  /** 目標の開始日(登録日) */
  startDate: DateKey;
  /** 試験日 */
  examDate: DateKey;
  /** 目標勉強時間(時間) */
  targetHours: number;
};

/** 確定した判定結果(users/{uid}/dailyResults/{date} の該当項目) */
export type HomeDailyResult = {
  /** ドキュメント ID(判定した日) */
  date: DateKey;
  goalId: string;
  studiedMinutes: number;
  metMin: boolean;
  metGoal: boolean;
};

export type HomeSummaryInput = {
  /** 現在の目標の goalId */
  goalId: string;
  goal: HomeGoal;
  /** dailyResults。他の目標のものが含まれていてもよい(goalId で絞る) */
  dailyResults: readonly HomeDailyResult[];
  /** セッション。他の目標のものが含まれていてもよい(goalId で絞る) */
  sessions: readonly JudgementSession[];
  /** 現在時刻(epoch ミリ秒) */
  now: number;
};

export type ExamCountdown =
  | { status: 'before_exam'; /** あと○日(1 以上) */ daysUntilExam: number }
  | { status: 'exam_date_reached' };

export type HomeSummary = {
  today: DateKey;
  /** 積み上げ時間(分) */
  accumulatedMinutes: number;
  /** 目標勉強時間(分) */
  targetMinutes: number;
  /** 達成率(%。小数点1桁で切り捨て。100% 超も実数) */
  achievementPercent: number;
  /** 進捗スライダー用の割合(0〜1。100% 超は 1) */
  sliderRatio: number;
  /** 最低勉強時間の達成日数(判定済みの日のみ) */
  metMinDays: number;
  /** 努力目標勉強時間の達成日数(判定済みの日のみ) */
  metGoalDays: number;
  /** 経過日数(判定済みの日数) */
  elapsedDays: number;
  exam: ExamCountdown;
  /** 残り必要時間(分。0 以上) */
  remainingMinutes: number;
  /** 積み上げ ≥ 目標勉強時間(「達成済み」) */
  targetReached: boolean;
  /** 不正データとして除外したセッション(呼び出し側でログに出す) */
  excludedSessions: readonly ExcludedSession[];
};

function assertGoal(goal: HomeGoal): void {
  if (!isValidDateKey(goal.startDate) || !isValidDateKey(goal.examDate)) {
    throw new RangeError(
      `startDate / examDate は実在する 'YYYY-MM-DD' である必要があります: ${goal.startDate} / ${goal.examDate}`,
    );
  }
}

function assertDailyResult(result: HomeDailyResult): void {
  if (!isValidDateKey(result.date)) {
    throw new RangeError(`dailyResults の date は実在する 'YYYY-MM-DD' である必要があります: ${result.date}`);
  }
  if (!Number.isSafeInteger(result.studiedMinutes) || result.studiedMinutes < 0) {
    throw new RangeError(
      `dailyResults(${result.date}) の studiedMinutes は 0 以上の整数である必要があります: ${result.studiedMinutes}`,
    );
  }
}

/**
 * 対象の目標の dailyResults(開始日〜今日の前日のみ)を日付ごとにする。同じ日付が重複したら RangeError。
 * 範囲外の日付のものも形式の検証はする(不正なら RangeError)
 */
function collectDailyResults(
  results: readonly HomeDailyResult[],
  goalId: string,
  startDate: DateKey,
  today: DateKey,
): ReadonlyMap<DateKey, HomeDailyResult> {
  return results
    .filter((result) => result.goalId === goalId)
    .reduce((map, result) => {
      assertDailyResult(result);
      if (diffDays(startDate, result.date) < 0 || diffDays(today, result.date) >= 0) {
        return map;
      }
      if (map.has(result.date)) {
        throw new RangeError(`dailyResults の日付が重複しています: ${result.date}`);
      }
      return new Map(map).set(result.date, result);
    }, new Map<DateKey, HomeDailyResult>());
}

/** ホーム画面の数値を求める */
export function calculateHomeSummary(input: HomeSummaryInput): HomeSummary {
  const { goalId, goal, dailyResults, sessions, now } = input;
  if (!Number.isFinite(now)) {
    throw new RangeError(`now は有限の数値(epoch ミリ秒)である必要があります: ${now}`);
  }
  assertGoal(goal);
  const targetMinutes = targetHoursToMinutes(goal.targetHours);
  const today = toJstDateKey(now);

  const judged = collectDailyResults(dailyResults, goalId, goal.startDate, today);
  const { valid, excluded } = partitionGoalSessions(sessions, goalId, (session): CheckedStudySession => {
    resolveSessionEnd(session, now);
    return session;
  });
  const sessionMinutes = aggregateEffectiveDailyStudyMinutes(valid, now);

  const judgedMinutes = [...judged.values()].reduce(
    (sum, result) => sum + result.studiedMinutes,
    0,
  );
  const unjudgedMinutes = Object.entries(sessionMinutes)
    .filter(
      ([date]) =>
        !judged.has(date) && diffDays(goal.startDate, date) >= 0 && diffDays(today, date) <= 0,
    )
    .reduce((sum, [, minutes]) => sum + minutes, 0);
  const accumulatedMinutes = judgedMinutes + unjudgedMinutes;

  const results = [...judged.values()];
  const daysUntilExam = diffDays(today, goal.examDate);
  const remaining = targetMinutes - accumulatedMinutes;

  return {
    today,
    accumulatedMinutes,
    targetMinutes,
    achievementPercent: floorPercent(accumulatedMinutes, targetMinutes),
    sliderRatio: Math.min(1, accumulatedMinutes / targetMinutes),
    metMinDays: results.filter((result) => result.metMin).length,
    metGoalDays: results.filter((result) => result.metGoal).length,
    elapsedDays: results.length,
    exam:
      daysUntilExam > 0
        ? { status: 'before_exam', daysUntilExam }
        : { status: 'exam_date_reached' },
    remainingMinutes: Math.max(0, remaining),
    targetReached: remaining <= 0,
    excludedSessions: excluded,
  };
}
