import { calcProgressRatio } from '../progress';

describe('calcProgressRatio(requirements 4-6: バーは100%で満タン)', () => {
  it('0分は 0', () => {
    expect(calcProgressRatio(0, 60)).toBe(0);
  });

  it('目標と同じ分数は 1', () => {
    expect(calcProgressRatio(60, 60)).toBe(1);
  });

  it('目標の半分は 0.5', () => {
    expect(calcProgressRatio(30, 60)).toBe(0.5);
  });

  it('目標を超えても 1 のまま(150%)', () => {
    expect(calcProgressRatio(90, 60)).toBe(1);
  });

  it('目標にわずかに届かない場合は 1 未満', () => {
    expect(calcProgressRatio(59, 60)).toBeLessThan(1);
    expect(calcProgressRatio(59, 60)).toBeGreaterThan(0.9);
  });
});
