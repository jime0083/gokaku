import { calculateYearlyDiscountPercent } from '@/features/billing/discount';

describe('calculateYearlyDiscountPercent(requirements 4-5 の 2)', () => {
  it('月額300円・年額3,000円は16%(mokuhyo.txt の例と同じ製品価格)', () => {
    expect(calculateYearlyDiscountPercent(300, 3000)).toBe(16);
  });

  it('年額が月額×12とちょうど同じなら0%', () => {
    expect(calculateYearlyDiscountPercent(300, 3600)).toBe(0);
  });

  it('年額が月額×12より高い場合は0%(マイナス表示にしない)', () => {
    expect(calculateYearlyDiscountPercent(300, 5000)).toBe(0);
  });

  it('小数点以下は切り捨てる(1/12=8.33...% → 8%)', () => {
    expect(calculateYearlyDiscountPercent(1, 11)).toBe(8);
  });

  it('月額が0以下なら0%(異常値の防御)', () => {
    expect(calculateYearlyDiscountPercent(0, 100)).toBe(0);
    expect(calculateYearlyDiscountPercent(-100, 100)).toBe(0);
  });

  it('月額100円・年額960円は20%(浮動小数点の誤差で19%にならないことを確認)', () => {
    expect(calculateYearlyDiscountPercent(100, 960)).toBe(20);
  });
});
