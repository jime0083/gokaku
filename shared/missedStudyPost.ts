/**
 * 承認済みの未達成投稿文と投稿素材の組み立て(requirements 3-3)。
 * Nは同月の全目標、Mは投稿対象goalIdの確定した未達成日を数える。
 * 投稿可否の判定・通信・現在時刻の取得は行わない。
 */
import type { DailyResultDraft } from './dailyJudgement';
import { type DateKey, isValidDateKey } from './date';

export type MissedStudyDailyResult = Readonly<
  Pick<DailyResultDraft, 'goalId' | 'metMin'> & { date: DateKey }
>;

export type MissedStudyPostInput = {
  goalId: string;
  date: DateKey;
  /** 同一ユーザーの確定結果。dateは全goalを通じて一意。 */
  dailyResults: readonly MissedStudyDailyResult[];
};

export type MissedStudyPost = {
  text: string;
  mediaIds: readonly string[];
  counts: {
    monthlyMissedDays: number;
    totalMissedDays: number;
  };
};

const MISSED_STUDY_POST_TEXT = [
  '本日の最低目標学習時間を達成できませんでした',
  'また明日から頑張ります',
  '勉強時間をフォロワーがチェックし勉強をサボれなくするアプリ',
  '#合格ウォッチ',
].join('\n');

function assertDate(value: unknown): asserts value is DateKey {
  if (typeof value !== 'string' || !isValidDateKey(value)) {
    throw new RangeError('date は実在する YYYY-MM-DD の文字列である必要があります');
  }
}

function assertGoalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError('goalId は空白以外を含む文字列である必要があります');
  }
}

/**
 * 対象日の対象goalに未達成結果があることを前提に、固定6行と画像IDを返す。
 * 同date・goalId・metMinの重複は1日とし、同dateの矛盾はRangeErrorにする。
 * 対象期間外も含め、入力結果のdate・goalId・metMinを検証する。
 */
export function buildMissedStudyPost(input: MissedStudyPostInput): MissedStudyPost {
  const { goalId, date, dailyResults } = input;
  assertGoalId(goalId);
  assertDate(date);

  const resultsByDate = new Map<DateKey, MissedStudyDailyResult>();
  for (const result of dailyResults) {
    assertDate(result.date);
    assertGoalId(result.goalId);
    if (typeof result.metMin !== 'boolean') {
      throw new RangeError('metMin は boolean である必要があります');
    }
    const previous = resultsByDate.get(result.date);
    if (previous !== undefined) {
      if (previous.goalId !== result.goalId || previous.metMin !== result.metMin) {
        throw new RangeError('同じdateの判定結果が矛盾しています');
      }
    } else {
      resultsByDate.set(result.date, result);
    }
  }

  const target = resultsByDate.get(date);
  if (target === undefined || target.goalId !== goalId || target.metMin) {
    throw new RangeError('対象日の対象goalに確定した未達成結果が必要です');
  }

  const month = date.slice(0, 7);
  let monthlyMissedDays = 0;
  let totalMissedDays = 0;
  for (const result of resultsByDate.values()) {
    if (result.date > date || result.metMin) continue;
    if (result.date.slice(0, 7) === month) monthlyMissedDays += 1;
    if (result.goalId === goalId) totalMissedDays += 1;
  }

  return {
    text: `${MISSED_STUDY_POST_TEXT}\n#今月${monthlyMissedDays}回目\n#累計${totalMissedDays}回目`,
    mediaIds: [],
    counts: { monthlyMissedDays, totalMissedDays },
  };
}
