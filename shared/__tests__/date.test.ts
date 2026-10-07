import {
  addDays,
  diffDays,
  isValidDateKey,
  JST_OFFSET_MS,
  jstStartOfDay,
  jstStartOfNextDay,
  MS_PER_DAY,
  toJstDateKey,
} from '../date';

/** 日本時間の日時 → epoch ms(テスト用。ISO 文字列の +09:00 で指定する) */
const jst = (iso: string): number => Date.parse(`${iso}+09:00`);

// `npm run test:tz` は TZ を日本以外にして同じテストを実行する。TZ が実際に反映されていることを確認する
describe('実行環境のタイムゾーン', () => {
  it('TZ 環境変数が実行時に反映されている', () => {
    const tz = process.env.TZ;
    if (tz) {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
    }
  });
});

describe('定数', () => {
  it('JST は UTC+9 固定、1日は 24 時間', () => {
    expect(JST_OFFSET_MS).toBe(9 * 3600 * 1000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});

describe('toJstDateKey', () => {
  it('日本時間の 0:00 ちょうどはその日に属する', () => {
    expect(toJstDateKey(jst('2026-10-07T00:00:00.000'))).toBe('2026-10-07');
  });

  it('日本時間の 23:59:59.999 はその日に属する', () => {
    expect(toJstDateKey(jst('2026-10-07T23:59:59.999'))).toBe('2026-10-07');
  });

  it('UTC では前日でも日本時間の日付を返す(UTC 15:00 = JST 翌0:00)', () => {
    expect(toJstDateKey(Date.parse('2026-10-06T15:00:00.000Z'))).toBe('2026-10-07');
    expect(toJstDateKey(Date.parse('2026-10-06T14:59:59.999Z'))).toBe('2026-10-06');
  });

  it('年・月またぎ、うるう日', () => {
    expect(toJstDateKey(jst('2027-01-01T00:00:00.000'))).toBe('2027-01-01');
    expect(toJstDateKey(jst('2026-12-31T23:59:59.999'))).toBe('2026-12-31');
    expect(toJstDateKey(jst('2028-02-29T12:00:00.000'))).toBe('2028-02-29');
  });

  it('米国の夏時間切り替え日でも影響を受けない', () => {
    // 2026-03-08 / 2026-11-01 は America/Los_Angeles の夏時間切り替え日
    expect(toJstDateKey(Date.parse('2026-03-08T10:30:00.000Z'))).toBe('2026-03-08');
    expect(toJstDateKey(Date.parse('2026-11-01T09:30:00.000Z'))).toBe('2026-11-01');
  });

  it('有限でない値は RangeError', () => {
    expect(() => toJstDateKey(Number.NaN)).toThrow(RangeError);
    expect(() => toJstDateKey(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('jstStartOfDay / jstStartOfNextDay', () => {
  it('その日の日本時間 0:00 の epoch ms を返す', () => {
    expect(jstStartOfDay('2026-10-07')).toBe(Date.parse('2026-10-06T15:00:00.000Z'));
    expect(jstStartOfNextDay('2026-10-07')).toBe(Date.parse('2026-10-07T15:00:00.000Z'));
  });

  it('toJstDateKey と往復できる', () => {
    expect(toJstDateKey(jstStartOfDay('2026-03-08'))).toBe('2026-03-08');
    expect(toJstDateKey(jstStartOfNextDay('2026-03-08') - 1)).toBe('2026-03-08');
  });

  it('不正な日付キーは RangeError', () => {
    ['2026-02-30', '2026-13-01', '2026-1-01', '20261007', '', '2026-10-07T00:00'].forEach(
      (key) => {
        expect(() => jstStartOfDay(key)).toThrow(RangeError);
      },
    );
  });
});

describe('isValidDateKey', () => {
  it('実在する YYYY-MM-DD のみ true', () => {
    expect(isValidDateKey('2028-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
    expect(isValidDateKey('2026-10-7')).toBe(false);
  });
});

describe('addDays / diffDays', () => {
  it('月・年をまたいで日数を足し引きできる', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-07', 0)).toBe('2026-10-07');
  });

  it('整数でない日数は RangeError', () => {
    expect(() => addDays('2026-10-07', 0.5)).toThrow(RangeError);
  });

  it('to − from の日数を返す', () => {
    expect(diffDays('2026-10-07', '2026-10-07')).toBe(0);
    expect(diffDays('2026-10-07', '2026-10-08')).toBe(1);
    expect(diffDays('2026-10-08', '2026-10-07')).toBe(-1);
    expect(diffDays('2026-10-07', '2027-10-07')).toBe(365);
    expect(diffDays('2028-01-01', '2029-01-01')).toBe(366);
  });
});
