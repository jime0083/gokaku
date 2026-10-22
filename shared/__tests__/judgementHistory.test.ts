import {
  compareTimestamps,
  isTimestampLike,
  isJudgementSnapshot,
  isJudgementHistoryEntry,
  selectJudgementHistory,
} from '../judgementHistory';

const ts = (seconds: number, nanoseconds = 0) => ({ seconds, nanoseconds });
const START = ts(100);
const CUTOFF = ts(200);
const OFF = { xPostEnabled: false };
const ON = { xPostEnabled: true };
const GOAL = {
  goalId: 'goal-1',
  startDate: '2026-10-01',
  examDate: '2027-02-01',
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
};

const entry = (
  revision: number,
  committedAt = START,
  before: unknown = OFF,
  after: unknown = before,
) => ({ schemaVersion: 1, revision, committedAt, before, after });

type SelectionInput = Parameters<typeof selectJudgementHistory>[0];
const select = (overrides: Partial<SelectionInput> = {}) =>
  selectJudgementHistory({
    stream: 'settings',
    parentRevision: 1,
    coverageStart: START,
    cutoff: CUTOFF,
    entries: [entry(1)],
    ...overrides,
  });

const expectInvalid = (overrides: Partial<SelectionInput>) => {
  const result = select(overrides);
  expect(result.status).toBe('missingOrInvalid');
  if (result.status === 'missingOrInvalid') {
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  }
};

describe('TimestampLike: SDK非依存・秒/ナノ秒精度', () => {
  it.each([
    ts(0), ts(-1, 999999999), ts(1, 1),
    ts(Number.MAX_SAFE_INTEGER + 1),
  ])('整数secondsと範囲内nanosecondsを受理する: %p', (value) => {
    expect(isTimestampLike(value)).toBe(true);
  });

  it.each([
    null, undefined, {}, 100, new Date(0),
    { seconds: 1 }, { nanoseconds: 0 },
    ts(1.5), ts(NaN), ts(Infinity),
    ts(1, -1), ts(1, 1000000000), ts(1, 0.5),
    { seconds: '1', nanoseconds: 0 },
    { seconds: 1, nanoseconds: '0' },
  ])('不正Timestampを拒否する: %p', (value) => {
    expect(isTimestampLike(value)).toBe(false);
  });

  it('同一ミリ秒内の1ns差と秒境界を保持する', () => {
    expect(compareTimestamps(ts(100, 1), ts(100, 2))).toBe(-1);
    expect(compareTimestamps(ts(100, 2), ts(100, 1))).toBe(1);
    expect(compareTimestamps(ts(100, 2), ts(100, 2))).toBe(0);
    expect(compareTimestamps(ts(99, 999999999), ts(100))).toBe(-1);
  });

  it('SDKメソッドに依存せず構造だけで比較する', () => {
    const value = {
      seconds: 100,
      nanoseconds: 2,
      toMillis: () => { throw new Error('呼んではいけない'); },
    };
    expect(isTimestampLike(value)).toBe(true);
    expect(compareTimestamps(value, ts(100, 1))).toBe(1);
  });
});

describe('4streamの最小snapshot検査', () => {
  it('明示nullと4streamの正しい値を受理する', () => {
    expect(isJudgementSnapshot('goal', null)).toBe(true);
    expect(isJudgementSnapshot('goal', GOAL)).toBe(true);
    expect(isJudgementSnapshot('settings', OFF)).toBe(true);
    expect(isJudgementSnapshot('xLink', { xLinked: true })).toBe(true);
    expect(isJudgementSnapshot('subscription', null)).toBe(true);
    expect(isJudgementSnapshot('subscription', { expiresAt: null })).toBe(true);
    expect(isJudgementSnapshot('subscription', { expiresAt: 123.5 })).toBe(true);
  });

  it('既存sharedの目標入力範囲を狭めない', () => {
    // dailyJudgementの検査と同じ: 実在日付と0以上の整数分。
    // フォーム専用の10分刻み/960分上限等をここへ追加しない。
    expect(isJudgementSnapshot('goal', {
      ...GOAL, minDailyMinutes: 0, goalDailyMinutes: 0,
    })).toBe(true);
    expect(isJudgementSnapshot('goal', {
      ...GOAL, minDailyMinutes: 1001, goalDailyMinutes: 1,
    })).toBe(true);
  });

  it.each([
    ['goal', undefined],
    ['goal', {}],
    ['goal', { ...GOAL, goalId: '' }],
    ['goal', { ...GOAL, startDate: '2026-02-30' }],
    ['goal', { ...GOAL, examDate: null }],
    ['goal', { ...GOAL, minDailyMinutes: -1 }],
    ['goal', { ...GOAL, minDailyMinutes: '60' }],
    ['goal', { ...GOAL, goalDailyMinutes: 1.5 }],
    ['goal', { ...GOAL, goalDailyMinutes: Infinity }],
    ['goal', { ...GOAL, targetHours: 100 }],
    ['settings', null],
    ['settings', {}],
    ['settings', { xPostEnabled: 0 }],
    ['settings', { xPostEnabled: false, xLinked: true }],
    ['xLink', null],
    ['xLink', { xLinked: 'true' }],
    ['xLink', { xLinked: false, token: 'forbidden' }],
    ['subscription', undefined],
    ['subscription', {}],
    ['subscription', { expiresAt: undefined }],
    ['subscription', { expiresAt: '123' }],
    ['subscription', { expiresAt: NaN }],
    ['subscription', { expiresAt: Infinity }],
    ['subscription', { expiresAt: ts(123) }],
    ['subscription', { expiresAt: null, jws: 'forbidden' }],
  ] as const)('%sの欠落/不正/余分な項目を拒否する: %p', (stream, value) => {
    expect(isJudgementSnapshot(stream, value)).toBe(false);
  });

  it('streamの取り違えを拒否する', () => {
    expect(isJudgementSnapshot('xLink', OFF)).toBe(false);
    expect(isJudgementSnapshot('settings', { xLinked: false })).toBe(false);
  });
});

describe('履歴entryの固定形式', () => {
  it('schemaVersion/revision/committedAt/before/afterのみを受理する', () => {
    expect(isJudgementHistoryEntry('settings', entry(1))).toBe(true);
    expect(isJudgementHistoryEntry('goal', entry(2, START, null, GOAL))).toBe(true);
    expect(isJudgementHistoryEntry(
      'subscription', entry(2, START, null, { expiresAt: null }),
    )).toBe(true);
  });

  it.each([
    null, undefined, {},
    { ...entry(1), schemaVersion: 2 },
    { ...entry(1), schemaVersion: '1' },
    { ...entry(1), revision: 0 },
    { ...entry(1), revision: -1 },
    { ...entry(1), revision: 1.5 },
    { ...entry(1), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...entry(1), committedAt: ts(1, 1000000000) },
    { ...entry(1), before: undefined },
    { ...entry(1), after: null },
    { ...entry(1), token: 'forbidden' },
    { schemaVersion: 1, revision: 1, committedAt: START, after: OFF },
  ])('不正entryを拒否する: %p', (value) => {
    expect(isJudgementHistoryEntry('settings', value)).toBe(false);
  });

  it('引数streamに対応したbefore/afterを検査する', () => {
    expect(isJudgementHistoryEntry('xLink', entry(1))).toBe(false);
    expect(isJudgementHistoryEntry(
      'settings', entry(2, START, OFF, { xLinked: false }),
    )).toBe(false);
  });
});

describe('cutoff直前値の選択', () => {
  it('baseline後の最初のcutoffから復元できる', () => {
    expect(select()).toEqual({ status: 'available', snapshot: OFF });
    expect(select({ cutoff: ts(100, 1) }))
      .toEqual({ status: 'available', snapshot: OFF });
  });

  it.each([CUTOFF, ts(200, 1), ts(201)])(
    'coverageStart>=cutoffは導入前として扱う: %p', (coverageStart) => {
      expect(select({ coverageStart, entries: [] }))
        .toEqual({ status: 'beforeCoverage' });
    },
  );

  it('cutoff等号の変更を含めず、1ns前のafterを返す', () => {
    expect(select({
      parentRevision: 3,
      entries: [
        entry(1),
        entry(2, ts(199, 999999999), OFF, ON),
        entry(3, CUTOFF, ON, OFF),
      ],
    })).toEqual({ status: 'available', snapshot: ON });
  });

  it('同一Timestampはrevision順。入力順を変更しない', () => {
    const entries = Object.freeze([
      Object.freeze(entry(3, ts(150), ON, OFF)),
      Object.freeze(entry(1)),
      Object.freeze(entry(2, ts(150), OFF, ON)),
    ]);
    expect(select({ parentRevision: 3, entries }))
      .toEqual({ status: 'available', snapshot: OFF });
    expect(entries.map((value) => value.revision)).toEqual([3, 1, 2]);
  });

  it('全履歴不要: cutoff前の最大rと最初の後続r+1で検証する', () => {
    expect(select({
      parentRevision: 100,
      entries: [
        entry(41, ts(190), OFF, ON),
        entry(42, CUTOFF, ON, OFF),
      ],
    })).toEqual({ status: 'available', snapshot: ON });
  });

  it('r==親counterなら後続なしで復元する', () => {
    expect(select({
      parentRevision: 41,
      entries: [entry(41, ts(190), OFF, ON)],
    })).toEqual({ status: 'available', snapshot: ON });
  });

  it('既知の目標なし/未購入nullをavailableとして返す', () => {
    for (const stream of ['goal', 'subscription'] as const) {
      expect(select({ stream, entries: [entry(1, START, null, null)] }))
        .toEqual({ status: 'available', snapshot: null });
    }
  });

  it('objectのプロパティ順によらずsnapshotの連続性を比較する', () => {
    const reordered = {
      goalDailyMinutes: 120, minDailyMinutes: 60,
      examDate: '2027-02-01', startDate: '2026-10-01', goalId: 'goal-1',
    };
    expect(select({
      stream: 'goal',
      parentRevision: 2,
      entries: [
        entry(1, START, GOAL, reordered),
        entry(2, CUTOFF, GOAL, null),
      ],
    })).toEqual({ status: 'available', snapshot: reordered });
  });
});

describe('導入後の欠損・不正・整合違反をエラー結果にする', () => {
  it.each([
    { entries: [] },
    { entries: undefined },
    { entries: {} },
    { coverageStart: undefined },
    { coverageStart: ts(100, -1) },
    { cutoff: ts(200, 1000000000) },
    { parentRevision: undefined },
    { parentRevision: 0 },
    { parentRevision: 1.5 },
    { parentRevision: Number.MAX_SAFE_INTEGER + 1 },
    { entries: [undefined] },
    { entries: [entry(1), entry(1)] },
    { entries: [entry(1, ts(99))] },
    { entries: [entry(1, START, OFF, ON)] },
    { entries: [entry(1, ts(101))] },
    { entries: [entry(1, CUTOFF)] },
    { entries: [entry(1, START, OFF, { xPostEnabled: 'false' })] },
    { stream: 'subscription', entries: [{ ...entry(1, START, null, null), after: undefined }] },
    { parentRevision: 2, entries: [entry(1)] },
    { parentRevision: 1, entries: [entry(1), entry(2, CUTOFF, OFF, ON)] },
    { parentRevision: 3, entries: [entry(1), entry(3, CUTOFF, OFF, ON)] },
    {
      parentRevision: 2,
      entries: [entry(1), entry(2, CUTOFF, ON, OFF)],
    },
    {
      parentRevision: 2,
      entries: [entry(1), entry(2, ts(99), OFF, ON)],
    },
    {
      parentRevision: 4,
      entries: [
        entry(2, ts(150), OFF, ON),
        entry(3, ts(140), ON, OFF),
        entry(4, CUTOFF, OFF, ON),
      ],
    },
    {
      parentRevision: 4,
      entries: [
        entry(2, ts(150), OFF, ON),
        entry(4, ts(190), ON, OFF),
      ],
    },
    {
      parentRevision: 3,
      entries: [entry(2, ts(190), OFF, ON), entry(3, CUTOFF, OFF, ON)],
    },
  ] satisfies Partial<SelectionInput>[])('不正入力を正常値へ潰さない: %p', (overrides) => {
    expectInvalid(overrides);
  });

  it('最新直前entryが消えてr+2だけ残る場合、古いafterを返さない', () => {
    expectInvalid({
      parentRevision: 44,
      entries: [
        entry(41, ts(190), OFF, ON),
        entry(43, CUTOFF, ON, OFF),
      ],
    });
  });

  it('後続候補がcutoff前なら、さらにr+1が必要になる', () => {
    expectInvalid({
      parentRevision: 43,
      entries: [
        entry(41, ts(190), OFF, ON),
        entry(42, ts(199, 999999999), ON, OFF),
      ],
    });
  });

  it('候補内の不正な後続を無視しない', () => {
    expectInvalid({
      parentRevision: 2,
      entries: [
        entry(1),
        { ...entry(2, CUTOFF, OFF, ON), schemaVersion: 2 },
      ],
    });
  });

  it('有効なxLink snapshotを選択する', () => {
    const snapshot = { xLinked: false };
    expect(select({
      stream: 'xLink',
      entries: [entry(1, START, snapshot, snapshot)],
    })).toEqual({ status: 'available', snapshot });
  });
});
