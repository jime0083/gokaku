import {
  calculateExamEstimatedHours,
  DEVIATION_RANGE,
  resolveInitialTargetHours,
  SUBJECT_COUNT_RANGE,
  TARGET_HOURS_RANGE,
} from '../estimatedHours';

describe('calculateExamEstimatedHours', () => {
  it('mokuhyo.txt の計算例: 3科目 50.0→60.0 = 1,080〜1,800', () => {
    expect(
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 3 }),
    ).toEqual({ status: 'ok', lowerHours: 1080, upperHours: 1800 });
  });

  it('mokuhyo.txt の計算例: 3科目 45.0→55.0 = 990〜1,650(帯をまたぐ)', () => {
    expect(
      calculateExamEstimatedHours({ currentDeviation: 45.0, targetDeviation: 55.0, subjectCount: 3 }),
    ).toEqual({ status: 'ok', lowerHours: 990, upperHours: 1650 });
  });

  it('目標 ≤ 現在 の場合は概算なし', () => {
    expect(
      calculateExamEstimatedHours({ currentDeviation: 60.0, targetDeviation: 60.0, subjectCount: 3 }),
    ).toEqual({ status: 'not_needed' });
    expect(
      calculateExamEstimatedHours({ currentDeviation: 60.0, targetDeviation: 55.0, subjectCount: 3 }),
    ).toEqual({ status: 'not_needed' });
  });

  it('境目ちょうど: 50.0→70.0(50と60の境目をまたぐ。1科目)', () => {
    // [50,60) 係数1.2: 10*30*1*1.2=360 / 10*50*1*1.2=600
    // [60,70) 係数1.5: 10*30*1*1.5=450 / 10*50*1*1.5=750
    // 合計: 下限810 / 上限1350
    expect(
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 70.0, subjectCount: 1 }),
    ).toEqual({ status: 'ok', lowerHours: 810, upperHours: 1350 });
  });

  it('境目ちょうど: 70.0→75.0(70以上の係数2.0。1科目)', () => {
    // 5*30*1*2.0=300 / 5*50*1*2.0=500
    expect(
      calculateExamEstimatedHours({ currentDeviation: 70.0, targetDeviation: 75.0, subjectCount: 1 }),
    ).toEqual({ status: 'ok', lowerHours: 300, upperHours: 500 });
  });

  it('境目直前: 49.9→50.0(50未満の係数1.0のまま。1科目。四捨五入の境界: ちょうど5時間は10に丸める)', () => {
    // 幅0.1点、1.0*1科目: 下限 0.1*30=3時間→四捨五入で0、上限 0.1*50=5時間→ちょうど半分は上に丸めて10
    expect(
      calculateExamEstimatedHours({ currentDeviation: 49.9, targetDeviation: 50.0, subjectCount: 1 }),
    ).toEqual({ status: 'ok', lowerHours: 0, upperHours: 10 });
  });

  it('科目数1(最小)', () => {
    expect(
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 1 }),
    ).toEqual({ status: 'ok', lowerHours: 360, upperHours: 600 });
  });

  it('科目数8(最大)', () => {
    expect(
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 8 }),
    ).toEqual({ status: 'ok', lowerHours: 2880, upperHours: 4800 });
  });

  it('係数1.2の帯内での計算(50.0→52.5、1科目)', () => {
    // 幅2.5点、係数1.2: 下限 2.5*30*1.2=90、上限 2.5*50*1.2=150(いずれも丸め不要)
    const result = calculateExamEstimatedHours({
      currentDeviation: 50.0,
      targetDeviation: 52.5,
      subjectCount: 1,
    });
    expect(result).toEqual({ status: 'ok', lowerHours: 90, upperHours: 150 });
  });

  it('偏差値の範囲外は RangeError', () => {
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 24.9, targetDeviation: 60.0, subjectCount: 3 }),
    ).toThrow(RangeError);
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 80.1, subjectCount: 3 }),
    ).toThrow(RangeError);
  });

  it('偏差値が 0.1 刻みでない場合は RangeError', () => {
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 50.05, targetDeviation: 60.0, subjectCount: 3 }),
    ).toThrow(RangeError);
  });

  it('科目数の範囲外は RangeError', () => {
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 9 }),
    ).toThrow(RangeError);
    expect(() =>
      calculateExamEstimatedHours({ currentDeviation: 50.0, targetDeviation: 60.0, subjectCount: 3.5 }),
    ).toThrow(RangeError);
  });

  it('入力範囲の定数が mokuhyo.txt 1 と一致する', () => {
    expect(DEVIATION_RANGE).toEqual({ min: 25.0, max: 80.0, step: 0.1 });
    expect(SUBJECT_COUNT_RANGE).toEqual({ min: 1, max: 8, default: 3 });
    expect(TARGET_HOURS_RANGE).toEqual({ min: 1, max: 20_000 });
  });
});

describe('resolveInitialTargetHours', () => {
  it('上限をそのまま初期値にする', () => {
    expect(resolveInitialTargetHours(1800)).toBe(1800);
    expect(resolveInitialTargetHours(1)).toBe(1);
  });

  it('20,000時間を超える場合は20,000にする', () => {
    expect(resolveInitialTargetHours(20_000)).toBe(20_000);
    expect(resolveInitialTargetHours(20_010)).toBe(20_000);
    expect(resolveInitialTargetHours(100_000)).toBe(20_000);
  });

  it('不正な値は RangeError', () => {
    expect(() => resolveInitialTargetHours(0)).toThrow(RangeError);
    expect(() => resolveInitialTargetHours(-1)).toThrow(RangeError);
    expect(() => resolveInitialTargetHours(1.5)).toThrow(RangeError);
  });
});
