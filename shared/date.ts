/**
 * 日本時間(Asia/Tokyo)の日付計算。
 *
 * - 時刻は UTC epoch ミリ秒(number)で扱う
 * - 日付は日本時間の 'YYYY-MM-DD' 文字列(DateKey)で扱う
 * - 端末のタイムゾーンに依存しないよう、Date のローカル時刻系メソッド
 *   (getHours / getDate / setHours など)は使わず、UTC 系メソッドのみを使う
 * - 現在時刻はこのモジュール内で取得しない(呼び出し側が引数で渡す)
 */

/**
 * 日本時間の UTC からのオフセット(+9時間)。
 * 日本は 1952年以降夏時間を実施していないため、UTC+9 固定で計算する前提とする。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 1日のミリ秒数(UTC+9 固定のため、日本時間の1日は常にこの長さ) */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 日本時間の日付キー 'YYYY-MM-DD' */
export type DateKey = string;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertEpochMs(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} は有限の数値(epoch ミリ秒)である必要があります: ${value}`);
  }
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** 'YYYY-MM-DD' を年月日に分解する。存在しない日付(2月30日など)は null */
function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** 正しい形式かつ実在する日付の DateKey か */
export function isValidDateKey(key: string): boolean {
  return parseDateKey(key) !== null;
}

function assertDateKey(key: string): { year: number; month: number; day: number } {
  const parsed = parseDateKey(key);
  if (!parsed) {
    throw new RangeError(`日付キーは実在する 'YYYY-MM-DD' である必要があります: ${key}`);
  }
  return parsed;
}

/** 時刻 → その時刻の日本時間の日付キー */
export function toJstDateKey(epochMs: number): DateKey {
  assertEpochMs(epochMs, 'epochMs');
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return [
    pad(shifted.getUTCFullYear(), 4),
    pad(shifted.getUTCMonth() + 1, 2),
    pad(shifted.getUTCDate(), 2),
  ].join('-');
}

/** 日付キー → その日の 0:00(日本時間)の epoch ミリ秒 */
export function jstStartOfDay(key: DateKey): number {
  const { year, month, day } = assertDateKey(key);
  return Date.UTC(year, month - 1, day) - JST_OFFSET_MS;
}

/** 日付キー → 翌日 0:00(日本時間)の epoch ミリ秒(その日の終わりの境界。この時刻自体は翌日に属する) */
export function jstStartOfNextDay(key: DateKey): number {
  return jstStartOfDay(key) + MS_PER_DAY;
}

/** 日付キーに日数を足す(負数で過去へ) */
export function addDays(key: DateKey, days: number): DateKey {
  if (!Number.isInteger(days)) {
    throw new RangeError(`days は整数である必要があります: ${days}`);
  }
  return toJstDateKey(jstStartOfDay(key) + days * MS_PER_DAY);
}

/** to − from の日数(同じ日なら 0、from が翌日なら -1) */
export function diffDays(from: DateKey, to: DateKey): number {
  return Math.round((jstStartOfDay(to) - jstStartOfDay(from)) / MS_PER_DAY);
}
