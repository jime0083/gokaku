import { formatElapsedClock, formatJstHourMinute } from '../format';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);

describe('formatElapsedClock(requirements 4-6: 計測していないときは 00:00:00)', () => {
  it('0 ms は 00:00:00', () => {
    expect(formatElapsedClock(0)).toBe('00:00:00');
  });

  it('負の値も 00:00:00(計測していない状態として扱う)', () => {
    expect(formatElapsedClock(-1000)).toBe('00:00:00');
  });

  it('59秒は 00:00:59', () => {
    expect(formatElapsedClock(59_000)).toBe('00:00:59');
  });

  it('1分は 00:01:00', () => {
    expect(formatElapsedClock(60_000)).toBe('00:01:00');
  });

  it('1時間2分3秒は 01:02:03', () => {
    expect(formatElapsedClock((60 * 60 + 2 * 60 + 3) * 1000)).toBe('01:02:03');
  });

  it('24時間を超えても時をそのまま表示する(25時間)', () => {
    expect(formatElapsedClock(25 * 60 * 60 * 1000)).toBe('25:00:00');
  });

  it('1秒未満は切り捨てる', () => {
    expect(formatElapsedClock(999)).toBe('00:00:00');
  });
});

describe('formatJstHourMinute(requirements 3-2, 2026-10-10 追記: 自動停止のお知らせ「○時○分」)', () => {
  it('時は0〜23のまま(ゼロ埋めしない)、分は2桁ゼロ埋め', () => {
    expect(formatJstHourMinute(jst('2026-10-07T14:05:00'))).toBe('14時05分');
  });

  it('1桁の時は先頭を0埋めしない', () => {
    expect(formatJstHourMinute(jst('2026-10-07T09:00:00'))).toBe('9時00分');
  });

  it('0時0分', () => {
    expect(formatJstHourMinute(jst('2026-10-07T00:00:00'))).toBe('0時00分');
  });
});
