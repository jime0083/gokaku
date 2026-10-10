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
