import { generateLocalId } from '../id';

describe('generateLocalId(5-1b-2。sessionId・idempotencyKey の生成)', () => {
  it('サーバーが受け付ける形式(^[A-Za-z0-9_-]{1,128}$)に合う', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateLocalId()).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  it('連続して呼んでも重複しない', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateLocalId()));
    expect(ids.size).toBe(200);
  });
});
