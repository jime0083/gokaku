/**
 * 勉強時間の日割り(requirements 3-1)。
 *
 * - 0:00(日本時間)をまたいだ計測は 0:00 で分割し、それぞれの日に加算する
 * - 集計はミリ秒で行い、分への変換は「日ごとの合計」に対して切り捨てで1回だけ行う
 *   (セッションごとに丸めると、短い計測を繰り返した日に最大で「セッション数 − 1」分の取りこぼしが出るため)
 * - 重なったセッション(仕様上は起きないが、データ不正時)は時間帯の和集合を取り、同じ時間を二重に加算しない
 * - 現在時刻は引数で受け取る(計測中のセッションは now までを計測時間とする)
 */

import { type DateKey, jstStartOfNextDay, toJstDateKey } from './date';

/** 1分のミリ秒数 */
export const MS_PER_MINUTE = 60 * 1000;

/** 計測時間の区間(epoch ミリ秒。startAt を含み endAt を含まない) */
export type TimeRange = { startAt: number; endAt: number };

/** 計測セッション。stopAt が null のものは計測中 */
export type StudySession = { startAt: number; stopAt: number | null };

/** 1日分の計測時間 */
export type DailyPortion = { date: DateKey; ms: number };

/** 日付キーごとの値(キーは計測時間がある日のみ) */
export type DailyTotals = Readonly<Record<DateKey, number>>;

function assertRange({ startAt, endAt }: TimeRange): void {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    throw new RangeError(`計測区間の時刻は有限の数値である必要があります: ${startAt}〜${endAt}`);
  }
  if (endAt < startAt) {
    throw new RangeError(`計測区間の終了が開始より前です: ${startAt}〜${endAt}`);
  }
}

/**
 * 計測区間を日本時間の日ごとに分割する。日付の昇順で返す。
 * 長さ 0 の区間は空配列を返す。
 */
export function splitRangeByJstDay(range: TimeRange): DailyPortion[] {
  assertRange(range);
  const portions: DailyPortion[] = [];
  let cursor = range.startAt;
  while (cursor < range.endAt) {
    const date = toJstDateKey(cursor);
    const segmentEnd = Math.min(jstStartOfNextDay(date), range.endAt);
    portions.push({ date, ms: segmentEnd - cursor });
    cursor = segmentEnd;
  }
  return portions;
}

/**
 * セッションの計測区間を求める。計測中(stopAt が null)は now までとする。
 * 計測中なのに now が開始より前の場合は RangeError。
 */
export function sessionToRange(session: StudySession, now: number): TimeRange {
  const range = { startAt: session.startAt, endAt: session.stopAt ?? now };
  assertRange(range);
  return range;
}

/** 重なり・接する区間を結合し、開始時刻の昇順で返す(入力は変更しない) */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  ranges.forEach(assertRange);
  const sorted = [...ranges].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  return sorted.reduce<TimeRange[]>((merged, range) => {
    const last = merged[merged.length - 1];
    if (last && range.startAt <= last.endAt) {
      return [
        ...merged.slice(0, -1),
        { startAt: last.startAt, endAt: Math.max(last.endAt, range.endAt) },
      ];
    }
    return [...merged, { ...range }];
  }, []);
}

/** 複数セッション → 日付キーごとの勉強時間(ミリ秒)。重なった時間は1回だけ数える */
export function aggregateDailyStudyMs(
  sessions: readonly StudySession[],
  now: number,
): DailyTotals {
  if (!Number.isFinite(now)) {
    throw new RangeError(`now は有限の数値である必要があります: ${now}`);
  }
  const totals: Record<DateKey, number> = {};
  mergeRanges(sessions.map((session) => sessionToRange(session, now)))
    .flatMap(splitRangeByJstDay)
    .forEach(({ date, ms }) => {
      totals[date] = (totals[date] ?? 0) + ms;
    });
  return totals;
}

/** ミリ秒 → 分(1分未満は切り捨て) */
export function msToWholeMinutes(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`ms は 0 以上の有限の数値である必要があります: ${ms}`);
  }
  return Math.floor(ms / MS_PER_MINUTE);
}

/**
 * 複数セッション → 日付キーごとの勉強時間(分・整数)。
 * 日ごとのミリ秒合計を切り捨てで分にする。達成判定(Phase 2-3)はこの分の値で比較する。
 */
export function aggregateDailyStudyMinutes(
  sessions: readonly StudySession[],
  now: number,
): DailyTotals {
  return Object.fromEntries(
    Object.entries(aggregateDailyStudyMs(sessions, now)).map(([date, ms]) => [
      date,
      msToWholeMinutes(ms),
    ]),
  );
}
