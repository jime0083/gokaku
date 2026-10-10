import { floorPercentTenths } from '@shared/index';

/**
 * 進み具合を 0〜1 の比率にする(requirements 4-6: バーは100%で満タン)。
 * 100% を超えても 1 のまま(バーがあふれない)。studiedMinutes は 0 以上、targetMinutes は 1 以上の整数
 */
export function calcProgressRatio(studiedMinutes: number, targetMinutes: number): number {
  return Math.min(floorPercentTenths(studiedMinutes, targetMinutes) / 1000, 1);
}
