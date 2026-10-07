import { calculatePace, type PaceInput, targetHoursToMinutes } from '../pace';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);

/** 登録時刻: 2026-10-07 10:00(日本時間) */
const NOW = jst('2026-10-07T10:00:00');

const input = (overrides: Partial<PaceInput> = {}): PaceInput => ({
  targetHours: 10,
  examDate: '2026-10-17', // D = 10(10/7〜10/16)
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
  ...overrides,
});

describe('calculatePace', () => {
  it('届く: 最低ペースの合計がちょうど目標勉強時間なら警告なし', () => {
    expect(calculatePace(input(), NOW)).toEqual({
      status: 'ok',
      today: '2026-10-07',
      days: 10,
      targetMinutes: 600,
      minPace: { totalMinutes: 600, percent: 100 },
      goalPace: { totalMinutes: 1200, percent: 200 },
      warning: false,
      requiredDailyMinutes: null,
    });
  });

  it('届く: 最低ペースの合計が目標を超える', () => {
    const result = calculatePace(input({ targetHours: 5 }), NOW);
    expect(result).toMatchObject({
      status: 'ok',
      minPace: { totalMinutes: 600, percent: 200 },
      warning: false,
      requiredDailyMinutes: null,
    });
  });

  it('届かない: 警告と必要な1日の時間(10分単位に切り上げ)', () => {
    // 目標 20時間 = 1200分、D = 10、最低 60分 × 10 = 600分(50%)
    const result = calculatePace(input({ targetHours: 20, minDailyMinutes: 60, goalDailyMinutes: 90 }), NOW);
    expect(result).toEqual({
      status: 'ok',
      today: '2026-10-07',
      days: 10,
      targetMinutes: 1200,
      minPace: { totalMinutes: 600, percent: 50 },
      goalPace: { totalMinutes: 900, percent: 75 },
      warning: true,
      requiredDailyMinutes: 120,
    });
  });

  it('届かない: 最低は届かないが努力目標は届く', () => {
    const result = calculatePace(input({ targetHours: 15, minDailyMinutes: 60, goalDailyMinutes: 120 }), NOW);
    expect(result).toMatchObject({
      minPace: { totalMinutes: 600, percent: 66.6 },
      goalPace: { totalMinutes: 1200, percent: 133.3 },
      warning: true,
      requiredDailyMinutes: 90,
    });
  });

  it('最低ペースの合計 = 目標は警告なし、下回ると警告', () => {
    // D = 7(10/7〜10/13)、目標 21時間 = 1260分。最低 180分 × 7 = 1260分 → 警告なし
    expect(
      calculatePace(input({ targetHours: 21, examDate: '2026-10-14', minDailyMinutes: 180, goalDailyMinutes: 180 }), NOW),
    ).toMatchObject({ days: 7, warning: false, requiredDailyMinutes: null });
    // 最低 170分 × 7 = 1190分 < 1260分 → 警告、1260 ÷ 7 = 180 ちょうど → 180分
    expect(
      calculatePace(input({ targetHours: 21, examDate: '2026-10-14', minDailyMinutes: 170, goalDailyMinutes: 180 }), NOW),
    ).toMatchObject({ days: 7, warning: true, requiredDailyMinutes: 180, minPace: { percent: 94.4 } });
  });

  it('10分単位の切り上げの境界', () => {
    const required = (targetHours: number, examDate: string): number | null => {
      const result = calculatePace(input({ targetHours, examDate, minDailyMinutes: 10, goalDailyMinutes: 10 }), NOW);
      if (result.status !== 'ok') throw new Error('unexpected');
      return result.requiredDailyMinutes;
    };
    // D = 6: 600 ÷ 6 = 100 ちょうど → 100
    expect(required(10, '2026-10-13')).toBe(100);
    // D = 7: 1320 ÷ 7 = 188.57… → 190
    expect(required(22, '2026-10-14')).toBe(190);
    // D = 7: 1260 ÷ 7 = 180 ちょうど → 180(190 にならない)
    expect(required(21, '2026-10-14')).toBe(180);
    // D = 59: 6000 ÷ 59 = 101.69… → 110
    expect(required(100, '2026-12-05')).toBe(110);
    // D = 3: 60 ÷ 3 = 20 ちょうど → 20
    expect(required(1, '2026-10-10')).toBe(20);
    // D = 9: 120 ÷ 9 = 13.33… → 20
    expect(required(2, '2026-10-16')).toBe(20);
  });

  it('残り1日(試験日が明日): D = 1', () => {
    const result = calculatePace(input({ targetHours: 10, examDate: '2026-10-08', minDailyMinutes: 60, goalDailyMinutes: 960 }), NOW);
    expect(result).toEqual({
      status: 'ok',
      today: '2026-10-07',
      days: 1,
      targetMinutes: 600,
      minPace: { totalMinutes: 60, percent: 10 },
      goalPace: { totalMinutes: 960, percent: 160 },
      warning: true,
      requiredDailyMinutes: 600,
    });
  });

  it('100%超は実数の%', () => {
    const result = calculatePace(input({ targetHours: 1, minDailyMinutes: 960, goalDailyMinutes: 960 }), NOW);
    expect(result).toMatchObject({
      minPace: { totalMinutes: 9600, percent: 16000 },
      warning: false,
    });
  });

  it('%は小数点1桁で切り捨て(浮動小数点の誤差なし)', () => {
    // D = 10、目標 120時間 = 7200分。最低 690分 × 10 = 6900分 → 95.833…% → 95.8
    expect(
      calculatePace(input({ targetHours: 120, minDailyMinutes: 690, goalDailyMinutes: 690 }), NOW),
    ).toMatchObject({ minPace: { percent: 95.8 } });
    // D = 1、目標 2時間 = 120分。最低 69分 → 57.5%(浮動小数点で計算すると 57.4 になる値)
    expect(
      calculatePace(input({ targetHours: 2, examDate: '2026-10-08', minDailyMinutes: 69, goalDailyMinutes: 69 }), NOW),
    ).toMatchObject({ minPace: { percent: 57.5 } });
  });

  it('D は日本時間の日付で数える(0:00 の前後)', () => {
    const before = calculatePace(input(), jst('2026-10-07T23:59:59'));
    const after = calculatePace(input(), jst('2026-10-08T00:00:00'));
    expect(before).toMatchObject({ today: '2026-10-07', days: 10 });
    expect(after).toMatchObject({ today: '2026-10-08', days: 9 });
    // UTC では前日の 15:00 = 日本時間 0:00
    expect(calculatePace(input(), Date.parse('2026-10-07T15:00:00Z'))).toMatchObject({
      today: '2026-10-08',
      days: 9,
    });
  });

  it('試験日が今日以前(D ≤ 0)は exam_date_not_future', () => {
    expect(calculatePace(input({ examDate: '2026-10-07' }), NOW)).toEqual({
      status: 'exam_date_not_future',
      today: '2026-10-07',
    });
    expect(calculatePace(input({ examDate: '2026-10-01' }), NOW)).toEqual({
      status: 'exam_date_not_future',
      today: '2026-10-07',
    });
    // 画面表示中に日付が変わり、試験日が「今日」になった場合
    expect(calculatePace(input({ examDate: '2026-10-08' }), jst('2026-10-08T00:00:00'))).toEqual({
      status: 'exam_date_not_future',
      today: '2026-10-08',
    });
  });

  it.each<[string, Partial<PaceInput>]>([
    ['目標勉強時間 0', { targetHours: 0 }],
    ['目標勉強時間 小数', { targetHours: 1.5 }],
    ['目標勉強時間 NaN', { targetHours: NaN }],
    ['最低 0', { minDailyMinutes: 0 }],
    ['最低 負数', { minDailyMinutes: -10 }],
    ['努力目標 小数', { goalDailyMinutes: 10.5 }],
    ['試験日 不正な形式', { examDate: '2026/10/17' }],
    ['試験日 実在しない日付', { examDate: '2026-02-30' }],
  ])('不正な入力(%s)は RangeError', (_label, overrides) => {
    expect(() => calculatePace(input(overrides), NOW)).toThrow(RangeError);
  });

  it('now が不正なら RangeError', () => {
    expect(() => calculatePace(input(), NaN)).toThrow(RangeError);
  });
});

describe('targetHoursToMinutes', () => {
  it('時間 → 分', () => {
    expect(targetHoursToMinutes(1)).toBe(60);
    expect(targetHoursToMinutes(20_000)).toBe(1_200_000);
  });
});
