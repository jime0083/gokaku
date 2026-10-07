import {
  ceilDivToStep,
  floorPercent,
  floorPercentTenths,
  roundToStep,
  splitHoursMinutes,
} from '../displayNumber';

describe('splitHoursMinutes', () => {
  it.each([
    [0, 0, 0],
    [59, 0, 59],
    [60, 1, 0],
    [61, 1, 1],
    [7425, 123, 45],
    [1_200_000, 20_000, 0],
  ])('%i 分 → %i 時間 %i 分', (total, hours, minutes) => {
    expect(splitHoursMinutes(total)).toEqual({ hours, minutes });
  });

  it.each([-1, 1.5, NaN, Infinity])('不正な値 %p は RangeError', (value) => {
    expect(() => splitHoursMinutes(value)).toThrow(RangeError);
  });
});

describe('floorPercent', () => {
  it('小数点1桁で切り捨てる', () => {
    expect(floorPercent(123, 1000)).toBe(12.3);
    expect(floorPercent(1239, 10000)).toBe(12.3);
    expect(floorPercent(1, 3)).toBe(33.3);
    expect(floorPercent(2, 3)).toBe(66.6);
  });

  it('境界: ちょうど 0.1% 単位の値はそのまま、わずかに足りない値は1つ下', () => {
    expect(floorPercentTenths(1, 1000)).toBe(1);
    expect(floorPercentTenths(999, 1_000_000)).toBe(0);
    expect(floorPercentTenths(1000, 1_000_000)).toBe(1);
    expect(floorPercent(99_999, 100_000)).toBe(99.9);
    expect(floorPercent(100_000, 100_000)).toBe(100);
  });

  it('浮動小数点の誤差で切り捨てが1つ下にならない', () => {
    // 浮動小数点で a / b * 100 を切り捨てると1つ下になる例(57 / 100 * 100 = 56.99999999999999)
    expect(Math.floor((57 / 100) * 100 * 10) / 10).toBe(56.9);
    expect(floorPercent(57, 100)).toBe(57);
    // 69分 / 120分 = 57.5%(浮動小数点では 57.4 になる)
    expect(Math.floor((69 / 120) * 100 * 10) / 10).toBe(57.4);
    expect(floorPercent(69, 120)).toBe(57.5);
    expect(floorPercent(29, 100)).toBe(29);
    // 0.1 + 0.2 系: 3 / 10 * 100 = 30.000000000000004 でも 30 のまま
    expect(floorPercent(3, 10)).toBe(30);
    // 12.3% は表示しても 12.3
    expect(floorPercent(7380, 60000)).toBe(12.3);
    expect(String(floorPercent(7380, 60000))).toBe('12.3');
  });

  it('0% と 100% 超(実数)', () => {
    expect(floorPercent(0, 60)).toBe(0);
    expect(floorPercent(150, 100)).toBe(150);
    expect(floorPercent(12345, 6000)).toBe(205.7);
  });

  it('不正な値は RangeError', () => {
    expect(() => floorPercent(1, 0)).toThrow(RangeError);
    expect(() => floorPercent(-1, 10)).toThrow(RangeError);
    expect(() => floorPercent(1.5, 10)).toThrow(RangeError);
    expect(() => floorPercent(1, 2.5)).toThrow(RangeError);
    expect(() => floorPercent(Number.MAX_SAFE_INTEGER, 10)).toThrow(RangeError);
  });
});

describe('ceilDivToStep', () => {
  it('10 単位に切り上げる', () => {
    expect(ceilDivToStep(6000, 100, 10)).toBe(60);
    expect(ceilDivToStep(6001, 100, 10)).toBe(70);
    expect(ceilDivToStep(5999, 100, 10)).toBe(60);
    expect(ceilDivToStep(6000, 59, 10)).toBe(110);
    expect(ceilDivToStep(0, 7, 10)).toBe(0);
  });

  it('不正な値は RangeError', () => {
    expect(() => ceilDivToStep(10, 0, 10)).toThrow(RangeError);
    expect(() => ceilDivToStep(10, 1, 0)).toThrow(RangeError);
    expect(() => ceilDivToStep(-1, 1, 10)).toThrow(RangeError);
  });
});

describe('roundToStep', () => {
  it('10 単位に四捨五入する', () => {
    expect(roundToStep(1080 * 100, 100, 10)).toBe(1080);
    expect(roundToStep(1084 * 100, 100, 10)).toBe(1080);
    expect(roundToStep(1085 * 100, 100, 10)).toBe(1090);
    expect(roundToStep(1086 * 100, 100, 10)).toBe(1090);
    expect(roundToStep(0, 100, 10)).toBe(0);
  });

  it('ちょうど半分は上に丸める(四捨五入)', () => {
    expect(roundToStep(5, 1, 10)).toBe(10);
    expect(roundToStep(15, 1, 10)).toBe(20);
    expect(roundToStep(4, 1, 10)).toBe(0);
  });

  it('不正な値は RangeError', () => {
    expect(() => roundToStep(10, 0, 10)).toThrow(RangeError);
    expect(() => roundToStep(10, 1, 0)).toThrow(RangeError);
    expect(() => roundToStep(-1, 1, 10)).toThrow(RangeError);
  });
});
