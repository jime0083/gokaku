import { partitionGoalSessions } from '../sessionFilter';

type Session = { goalId: string; id?: string; value: number };

const toValid = (session: Session): number | null => {
  if (session.value < 0) {
    throw new RangeError(`不正な値: ${session.value}`);
  }
  return session.value === 0 ? null : session.value * 10;
};

describe('partitionGoalSessions', () => {
  it('他の目標は件数だけ数え、null は対象外、RangeError は位置・id・メッセージ付きで除外する', () => {
    const sessions: Session[] = [
      { goalId: 'g1', id: 'a', value: 1 },
      { goalId: 'g2', id: 'b', value: 2 },
      { goalId: 'g1', id: 'c', value: -1 },
      { goalId: 'g1', value: 0 },
      { goalId: 'g1', value: -2 },
      { goalId: 'g1', value: 3 },
    ];
    expect(partitionGoalSessions(sessions, 'g1', toValid)).toEqual({
      valid: [10, 30],
      excluded: [
        { index: 2, id: 'c', message: '不正な値: -1' },
        { index: 4, message: '不正な値: -2' },
      ],
      otherGoalCount: 1,
    });
  });

  it('他の目標のセッションは検証しない(不正でも除外リストに入れない)', () => {
    expect(partitionGoalSessions([{ goalId: 'g2', value: -1 }], 'g1', toValid)).toEqual({
      valid: [],
      excluded: [],
      otherGoalCount: 1,
    });
  });

  it('RangeError 以外の例外はそのまま投げる', () => {
    expect(() =>
      partitionGoalSessions([{ goalId: 'g1', value: 1 }], 'g1', () => {
        throw new TypeError('想定外');
      }),
    ).toThrow(TypeError);
  });
});
