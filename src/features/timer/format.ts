import { toJstHourMinute } from '@shared/index';

/**
 * タイマー画面の経過時間の表示(requirements 4-6: 計測していないときは 00:00:00)。
 * 時・分・秒とも2桁ゼロ埋め。時は24を超えても(例: 25時間)そのまま表示する
 */
export function formatElapsedClock(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 自動停止のお知らせの「○時○分」(requirements 3-2, 2026-10-10 追記)。
 * 時は 0〜23 のまま(ゼロ埋めしない)、分は2桁ゼロ埋め(例: 14時05分)
 */
export function formatJstHourMinute(epochMs: number): string {
  const { hour, minute } = toJstHourMinute(epochMs);
  return `${hour}時${String(minute).padStart(2, '0')}分`;
}
