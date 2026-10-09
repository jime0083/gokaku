import { DAILY_MINUTES_RANGE, DEVIATION_RANGE, TARGET_HOURS_RANGE } from '@shared/index';

import {
  FREE_TEXT_MAX_LENGTH,
  isDeviationAlreadyReached,
  validateCertOtherName,
  validateDailyMinutes,
  validateDeviation,
  validateExamDate,
  validateGoalNotLessThanMin,
  validateTargetHours,
  validateUniversity,
} from '../validation';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
/** 「今日」: 2026-10-07(日本時間) */
const NOW = jst('2026-10-07T10:00:00');

describe('validateUniversity', () => {
  it('1〜50文字は null(エラーなし)', () => {
    expect(validateUniversity('〇〇大学')).toBeNull();
    expect(validateUniversity('あ'.repeat(FREE_TEXT_MAX_LENGTH))).toBeNull();
  });

  it('前後の空白を除いて判定する', () => {
    expect(validateUniversity('  〇〇大学  ')).toBeNull();
  });

  it('空文字・空白のみはエラー', () => {
    expect(validateUniversity('')).not.toBeNull();
    expect(validateUniversity('   ')).not.toBeNull();
  });

  it(`${FREE_TEXT_MAX_LENGTH}文字を超えるとエラー`, () => {
    expect(validateUniversity('あ'.repeat(FREE_TEXT_MAX_LENGTH + 1))).not.toBeNull();
  });
});

describe('validateCertOtherName(3-2a レビュー指摘: 境界値。requirements 4-3, mokuhyo.txt 1)', () => {
  it(`ちょうど${FREE_TEXT_MAX_LENGTH}文字は null(エラーなし)`, () => {
    expect(validateCertOtherName('あ'.repeat(FREE_TEXT_MAX_LENGTH))).toBeNull();
  });

  it(`${FREE_TEXT_MAX_LENGTH + 1}文字はエラー`, () => {
    expect(validateCertOtherName('あ'.repeat(FREE_TEXT_MAX_LENGTH + 1))).not.toBeNull();
  });

  it('空白のみはエラー', () => {
    expect(validateCertOtherName('   ')).not.toBeNull();
  });

  it('前後の空白は除いて文字数を数える(前後の空白込みで51文字でも、除けば50文字なら null)', () => {
    expect(validateCertOtherName(` ${'あ'.repeat(FREE_TEXT_MAX_LENGTH)} `)).toBeNull();
  });
});

describe('validateDeviation', () => {
  it('範囲内・0.1刻みは null', () => {
    expect(validateDeviation(String(DEVIATION_RANGE.min), '目標偏差値')).toBeNull();
    expect(validateDeviation(String(DEVIATION_RANGE.max), '目標偏差値')).toBeNull();
    expect(validateDeviation('60.5', '目標偏差値')).toBeNull();
  });

  it('空文字は必須エラー', () => {
    expect(validateDeviation('', '目標偏差値')).toBe('目標偏差値を入力してください');
  });

  it('数値でない場合はエラー', () => {
    expect(validateDeviation('abc', '目標偏差値')).not.toBeNull();
  });

  it('範囲外・0.1刻みでない場合はエラー', () => {
    expect(validateDeviation(String(DEVIATION_RANGE.min - 0.1), '目標偏差値')).not.toBeNull();
    expect(validateDeviation(String(DEVIATION_RANGE.max + 0.1), '目標偏差値')).not.toBeNull();
    expect(validateDeviation('60.55', '目標偏差値')).not.toBeNull();
  });
});

describe('isDeviationAlreadyReached', () => {
  it('目標 ≤ 現在 の場合は true', () => {
    expect(isDeviationAlreadyReached('60.0', '55.0')).toBe(true);
    expect(isDeviationAlreadyReached('60.0', '60.0')).toBe(true);
  });

  it('目標 > 現在 の場合は false', () => {
    expect(isDeviationAlreadyReached('50.0', '60.0')).toBe(false);
  });

  it('未入力の場合は false', () => {
    expect(isDeviationAlreadyReached('', '60.0')).toBe(false);
    expect(isDeviationAlreadyReached('50.0', '')).toBe(false);
  });
});

describe('validateTargetHours', () => {
  it('範囲内の整数は null', () => {
    expect(validateTargetHours(String(TARGET_HOURS_RANGE.min))).toBeNull();
    expect(validateTargetHours(String(TARGET_HOURS_RANGE.max))).toBeNull();
  });

  it('空文字は必須エラー', () => {
    expect(validateTargetHours('')).toBe('目標勉強時間を入力してください');
  });

  it('範囲外・整数でない場合はエラー', () => {
    expect(validateTargetHours('0')).not.toBeNull();
    expect(validateTargetHours(String(TARGET_HOURS_RANGE.max + 1))).not.toBeNull();
    expect(validateTargetHours('100.5')).not.toBeNull();
  });
});

describe('validateExamDate', () => {
  it('明日以降は null', () => {
    expect(validateExamDate('2026-10-08', NOW)).toBeNull();
    expect(validateExamDate('2027-01-01', NOW)).toBeNull();
  });

  it('未選択(null)は必須エラー', () => {
    expect(validateExamDate(null, NOW)).toBe('試験日を選択してください');
  });

  it('今日・過去はエラー', () => {
    expect(validateExamDate('2026-10-07', NOW)).not.toBeNull();
    expect(validateExamDate('2026-10-06', NOW)).not.toBeNull();
  });
});

describe('validateDailyMinutes', () => {
  it('範囲内・10分刻みは null', () => {
    expect(validateDailyMinutes(DAILY_MINUTES_RANGE.min, '1日の最低勉強時間')).toBeNull();
    expect(validateDailyMinutes(DAILY_MINUTES_RANGE.max, '1日の最低勉強時間')).toBeNull();
  });

  it('未選択(null)は必須エラー', () => {
    expect(validateDailyMinutes(null, '1日の最低勉強時間')).toBe('1日の最低勉強時間を選択してください');
  });

  it('0分・範囲外・10分刻みでない場合はエラー', () => {
    expect(validateDailyMinutes(0, '1日の最低勉強時間')).not.toBeNull();
    expect(validateDailyMinutes(DAILY_MINUTES_RANGE.max + 10, '1日の最低勉強時間')).not.toBeNull();
    expect(validateDailyMinutes(25, '1日の最低勉強時間')).not.toBeNull();
  });
});

describe('validateGoalNotLessThanMin', () => {
  it('努力目標 ≥ 最低 は null', () => {
    expect(validateGoalNotLessThanMin(60, 60)).toBeNull();
    expect(validateGoalNotLessThanMin(60, 120)).toBeNull();
  });

  it('努力目標 < 最低 はエラー', () => {
    expect(validateGoalNotLessThanMin(120, 60)).not.toBeNull();
  });

  it('どちらか未確定(null)なら判定しない', () => {
    expect(validateGoalNotLessThanMin(null, 60)).toBeNull();
    expect(validateGoalNotLessThanMin(60, null)).toBeNull();
    expect(validateGoalNotLessThanMin(null, null)).toBeNull();
  });
});
