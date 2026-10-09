/**
 * 年額プランの「○%お得」の計算(requirements 4-5 の 2)。
 * (月額×12 − 年額) ÷ (月額×12) を小数点以下切り捨て。価格は StoreKit から取得した値を渡す。
 * 例: 月額300円・年額3,000円 → 16%
 */
export function calculateYearlyDiscountPercent(monthlyPrice: number, yearlyPrice: number): number {
  if (!Number.isFinite(monthlyPrice) || !Number.isFinite(yearlyPrice) || monthlyPrice <= 0) {
    return 0;
  }
  const yearlyAtMonthlyRate = monthlyPrice * 12;
  const diff = yearlyAtMonthlyRate - yearlyPrice;
  if (diff <= 0) {
    return 0;
  }
  const percent = (diff * 100) / yearlyAtMonthlyRate;
  // 浮動小数点の誤差で、本来ちょうど整数になる値がわずかに下回ることがあるため、
  // ごく小さい値を加えてから切り捨てる(300/3000 等の実測で誤差が出ないことを確認済み。保険として追加)
  return Math.floor(percent + 1e-9);
}
