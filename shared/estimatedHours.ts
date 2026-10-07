/**
 * 受験(偏差値)の必要勉強時間の概算(requirements 4-2、mokuhyo.txt 2)。
 *
 * 計算式(2026-10-07 承認。出典: 京都医塾コラム、鬼管理専門塾):
 * - 偏差値1上げるのに必要な時間(1科目あたり): 下限 30時間・上限 50時間
 * - 補正係数(偏差値の帯ごと): 50未満 ×1.0 / 50以上60未満 ×1.2 / 60以上70未満 ×1.5 / 70以上 ×2.0
 * - 現在の偏差値から目標偏差値までを帯の境目(50・60・70)で区切り、区間ごとに
 *   「区間の幅 × 時間 × 科目数 × その帯の係数」を合計する。下限・上限それぞれ10時間単位に四捨五入する
 * - 目標偏差値 ≤ 現在の偏差値の場合は概算を出さない
 *
 * 浮動小数点の誤差を避けるため、偏差値は 0.1 刻みであることを利用して 10 倍した整数(以下「tenths」)で計算する。
 * 係数も 10 倍した整数(coefficientTenTimes: 10/12/15/20)で扱い、最後にまとめて10時間単位に四捨五入する。
 *
 * 入力チェック(範囲外は RangeError。入力画面でのチェックは Phase 3):
 * - 偏差値: DEVIATION_RANGE(25.0〜80.0、0.1刻み)
 * - 科目数: SUBJECT_COUNT_RANGE(1〜8の整数)
 */
import { roundToStep } from './displayNumber';

/** 偏差値の入力範囲(目標・現在ともに共通。requirements 4-1, mokuhyo.txt 1) */
export const DEVIATION_RANGE = {
  min: 25.0,
  max: 80.0,
  step: 0.1,
} as const;

/** 受験科目数の入力範囲(mokuhyo.txt 1。2026-10-07 追加) */
export const SUBJECT_COUNT_RANGE = {
  min: 1,
  max: 8,
  default: 3,
} as const;

/** 目標勉強時間の入力範囲(mokuhyo.txt 1) */
export const TARGET_HOURS_RANGE = {
  min: 1,
  max: 20_000,
} as const;

/** 偏差値1上げるのに必要な時間(1科目あたり。時間) */
export const DEVIATION_HOURS_PER_POINT = { lower: 30, upper: 50 } as const;

/** 偏差値の帯の境目(この値未満/以上で帯が変わる) */
const BAND_BOUNDARIES_TENTHS = [500, 600, 700] as const;

/** 帯ごとの補正係数 × 10(整数で扱うため。10 = ×1.0, 12 = ×1.2, 15 = ×1.5, 20 = ×2.0) */
const BAND_COEFFICIENTS_TEN_TIMES = [10, 12, 15, 20] as const;

export type ExamEstimateResult =
  | { status: 'not_needed' }
  | { status: 'ok'; lowerHours: number; upperHours: number };

export type ExamEstimateInput = {
  /** 現在の偏差値 */
  currentDeviation: number;
  /** 目標偏差値 */
  targetDeviation: number;
  /** 受験科目数 */
  subjectCount: number;
};

/** 偏差値(25.0〜80.0、0.1刻み)を 10 倍した整数(tenths)に変換する。範囲外・0.1刻みでない値は RangeError */
function deviationToTenths(value: number, name: string): number {
  if (!Number.isFinite(value) || value < DEVIATION_RANGE.min || value > DEVIATION_RANGE.max) {
    throw new RangeError(
      `${name} は ${DEVIATION_RANGE.min}〜${DEVIATION_RANGE.max} の範囲である必要があります: ${value}`,
    );
  }
  const tenths = Math.round(value * 10);
  if (Math.abs(tenths / 10 - value) > 1e-6) {
    throw new RangeError(`${name} は 0.1 刻みである必要があります: ${value}`);
  }
  return tenths;
}

function assertSubjectCount(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < SUBJECT_COUNT_RANGE.min ||
    value > SUBJECT_COUNT_RANGE.max
  ) {
    throw new RangeError(
      `subjectCount は ${SUBJECT_COUNT_RANGE.min}〜${SUBJECT_COUNT_RANGE.max} の整数である必要があります: ${value}`,
    );
  }
}

/** tenths(偏差値 × 10)が属する帯の係数(× 10)を返す */
function bandCoefficientTenTimes(tenths: number): number {
  let band = 0;
  for (const boundary of BAND_BOUNDARIES_TENTHS) {
    if (tenths >= boundary) {
      band += 1;
    }
  }
  return BAND_COEFFICIENTS_TEN_TIMES[band];
}

/**
 * [lowTenths, highTenths) を帯の境目(50・60・70)で区切った区間の配列を返す(昇順、境目ちょうども正しく分割される)。
 */
function splitByBand(lowTenths: number, highTenths: number): { from: number; to: number }[] {
  const points = [
    lowTenths,
    ...BAND_BOUNDARIES_TENTHS.filter((boundary) => boundary > lowTenths && boundary < highTenths),
    highTenths,
  ];
  const intervals: { from: number; to: number }[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    intervals.push({ from: points[i], to: points[i + 1] });
  }
  return intervals;
}

/**
 * 区間ごとの「幅 × 時間 × 科目数 × 係数」の合計(÷100 する前の整数の和。÷10 は幅の tenths→実数化、÷10 は係数の×10 戻し分)を求める。
 */
function sumHoursNumerator(
  intervals: { from: number; to: number }[],
  hoursPerPoint: number,
  subjectCount: number,
): number {
  return intervals.reduce((sum, { from, to }) => {
    const widthTenths = to - from;
    const coefficientTenTimes = bandCoefficientTenTimes(from);
    return sum + widthTenths * hoursPerPoint * subjectCount * coefficientTenTimes;
  }, 0);
}

/** 受験(偏差値)の必要勉強時間の概算を求める */
export function calculateExamEstimatedHours(input: ExamEstimateInput): ExamEstimateResult {
  const currentTenths = deviationToTenths(input.currentDeviation, 'currentDeviation');
  const targetTenths = deviationToTenths(input.targetDeviation, 'targetDeviation');
  assertSubjectCount(input.subjectCount);

  if (targetTenths <= currentTenths) {
    return { status: 'not_needed' };
  }

  const intervals = splitByBand(currentTenths, targetTenths);
  const lowerNumerator = sumHoursNumerator(
    intervals,
    DEVIATION_HOURS_PER_POINT.lower,
    input.subjectCount,
  );
  const upperNumerator = sumHoursNumerator(
    intervals,
    DEVIATION_HOURS_PER_POINT.upper,
    input.subjectCount,
  );

  return {
    status: 'ok',
    lowerHours: roundToStep(lowerNumerator, 100, 10),
    upperHours: roundToStep(upperNumerator, 100, 10),
  };
}

/**
 * 目標勉強時間の初期値(mokuhyo.txt 1, 2)。概算の上限。20,000時間を超える場合は20,000。
 * upperHours は 1 以上の整数である必要がある(RangeError)。
 */
export function resolveInitialTargetHours(upperHours: number): number {
  if (!Number.isSafeInteger(upperHours) || upperHours < 1) {
    throw new RangeError(`upperHours は 1 以上の整数である必要があります: ${upperHours}`);
  }
  return Math.min(upperHours, TARGET_HOURS_RANGE.max);
}
