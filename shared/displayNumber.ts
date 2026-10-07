/**
 * 表示用の数値計算(requirements 4-4・4-6)。
 *
 * - 時間の表示は「○時間○分」。日本語の文言は UI 側で組み立て、ここでは時間と分の数値を返す
 * - %は小数点1桁で切り捨てる(例: 12.3%)。浮動小数点の誤差で 12.3 が 12.2 にならないよう、
 *   分(整数)のまま整数演算で「0.1% 単位の値」を求め、最後に 10 で割る
 */

/** 「○時間○分」の時間と分 */
export type HoursMinutes = { hours: number; minutes: number };

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} は 0 以上の整数である必要があります: ${value}`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} は 1 以上の整数である必要があります: ${value}`);
  }
}

/** 分(0 以上の整数) → 時間と分(例: 7425 → { hours: 123, minutes: 45 }) */
export function splitHoursMinutes(totalMinutes: number): HoursMinutes {
  assertNonNegativeSafeInteger(totalMinutes, 'totalMinutes');
  const minutes = totalMinutes % 60;
  return { hours: (totalMinutes - minutes) / 60, minutes };
}

/** 整数の割り算(切り捨て)。a ≥ 0, b > 0 の整数。浮動小数点の割り算の丸めに依存しないよう余りで補正する */
function floorDiv(a: number, b: number): number {
  const remainder = a % b;
  return (a - remainder) / b;
}

/**
 * numerator ÷ denominator × 100 を小数点1桁で切り捨てた値を、0.1% 単位の整数で返す
 * (例: 123 ÷ 1000 → 123 = 12.3%)。100% 超もそのまま返す。
 * numerator は 0 以上の整数、denominator は 1 以上の整数(分などの整数値)。
 */
export function floorPercentTenths(numerator: number, denominator: number): number {
  assertNonNegativeSafeInteger(numerator, 'numerator');
  assertPositiveSafeInteger(denominator, 'denominator');
  const scaled = numerator * 1000;
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError(`numerator が大きすぎます: ${numerator}`);
  }
  return floorDiv(scaled, denominator);
}

/**
 * numerator ÷ denominator × 100 を小数点1桁で切り捨てた%(例: 123 ÷ 1000 → 12.3)。
 * 整数演算で求めた 0.1% 単位の値を 10 で割るため、表示(String / toFixed(1))で 12.3 になる。
 */
export function floorPercent(numerator: number, denominator: number): number {
  return floorPercentTenths(numerator, denominator) / 10;
}

/**
 * numerator ÷ denominator を step 単位に切り上げる(例: 6000 ÷ 59 を 10 単位 → 110)。
 * 全て整数。numerator ≥ 0、denominator ≥ 1、step ≥ 1。
 */
export function ceilDivToStep(numerator: number, denominator: number, step: number): number {
  assertNonNegativeSafeInteger(numerator, 'numerator');
  assertPositiveSafeInteger(denominator, 'denominator');
  assertPositiveSafeInteger(step, 'step');
  const unit = denominator * step;
  if (!Number.isSafeInteger(unit)) {
    throw new RangeError(`denominator × step が大きすぎます: ${denominator} × ${step}`);
  }
  const quotient = floorDiv(numerator, unit);
  const units = quotient * unit < numerator ? quotient + 1 : quotient;
  return units * step;
}

/**
 * numerator ÷ denominator を step 単位に四捨五入する(ちょうど半分は上に丸める)。
 * 全て整数の演算のみで行う(浮動小数点の割り算をしない)。numerator ≥ 0、denominator ≥ 1、step ≥ 1。
 * (例: roundToStep(1080 * 100, 100, 10) = 1080、roundToStep(1085 * 100, 100, 10) = 1090)
 */
export function roundToStep(numerator: number, denominator: number, step: number): number {
  assertNonNegativeSafeInteger(numerator, 'numerator');
  assertPositiveSafeInteger(denominator, 'denominator');
  assertPositiveSafeInteger(step, 'step');
  const unit = denominator * step;
  if (!Number.isSafeInteger(unit)) {
    throw new RangeError(`denominator × step が大きすぎます: ${denominator} × ${step}`);
  }
  const quotient = floorDiv(numerator, unit);
  const remainder = numerator - quotient * unit;
  const units = remainder * 2 >= unit ? quotient + 1 : quotient;
  return units * step;
}
