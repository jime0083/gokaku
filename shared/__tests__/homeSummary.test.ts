import type { JudgementSession } from '../dailyJudgement';
import { calculateHomeSummary, type HomeDailyResult, type HomeSummaryInput } from '../homeSummary';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const MIN = 60 * 1000;

const GOAL_ID = 'goal-1';
/** 現在時刻: 2026-10-07 10:00(日本時間) */
const NOW = jst('2026-10-07T10:00:00');

const result = (
  date: string,
  studiedMinutes: number,
  overrides: Partial<HomeDailyResult> = {},
): HomeDailyResult => ({
  date,
  goalId: GOAL_ID,
  studiedMinutes,
  metMin: studiedMinutes >= 60,
  metGoal: studiedMinutes >= 120,
  ...overrides,
});

/** 指定した日の 9:00 から minutes 分勉強したセッション */
const studied = (date: string, minutes: number, overrides: Partial<JudgementSession> = {}): JudgementSession => ({
  goalId: GOAL_ID,
  startAt: jst(`${date}T09:00:00`),
  stopAt: jst(`${date}T09:00:00`) + minutes * MIN,
  checkEnabled: false,
  confirmations: [],
  ...overrides,
});

const input = (overrides: Partial<HomeSummaryInput> = {}): HomeSummaryInput => ({
  goalId: GOAL_ID,
  goal: { startDate: '2026-10-01', examDate: '2026-10-20', targetHours: 10 },
  dailyResults: [],
  sessions: [],
  now: NOW,
  ...overrides,
});

describe('calculateHomeSummary', () => {
  it('0件(開始日当日・記録なし)', () => {
    expect(
      calculateHomeSummary(input({ goal: { startDate: '2026-10-07', examDate: '2026-10-20', targetHours: 10 } })),
    ).toEqual({
      today: '2026-10-07',
      accumulatedMinutes: 0,
      targetMinutes: 600,
      achievementPercent: 0,
      sliderRatio: 0,
      metMinDays: 0,
      metGoalDays: 0,
      elapsedDays: 0,
      exam: { status: 'before_exam', daysUntilExam: 13 },
      remainingMinutes: 600,
      targetReached: false,
      excludedSessions: [],
    });
  });

  it('判定済みの日は dailyResults、当日分はセッションから計算して合算する', () => {
    const summary = calculateHomeSummary(
      input({
        dailyResults: [
          result('2026-10-01', 30),
          result('2026-10-02', 60),
          result('2026-10-03', 120),
          result('2026-10-04', 0),
          result('2026-10-05', 90),
          result('2026-10-06', 61),
        ],
        sessions: [
          // 判定済みの日のセッション(dailyResults の値と違っても dailyResults を正とする)
          studied('2026-10-06', 200),
          // 当日分
          studied('2026-10-07', 45),
        ],
      }),
    );
    expect(summary).toMatchObject({
      accumulatedMinutes: 30 + 60 + 120 + 0 + 90 + 61 + 45,
      achievementPercent: 67.6, // 406 / 600 = 67.66…
      metMinDays: 4,
      metGoalDays: 1,
      elapsedDays: 6,
      remainingMinutes: 194,
      targetReached: false,
    });
    expect(summary.sliderRatio).toBeCloseTo(406 / 600);
  });

  it('当日の計測中のセッションは now までを数える(確認による自動停止を反映)', () => {
    const running = studied('2026-10-07', 0, { startAt: jst('2026-10-07T08:00:00'), stopAt: null });
    expect(calculateHomeSummary(input({ sessions: [running] })).accumulatedMinutes).toBe(120);
    // 確認ON で 9:00 の確認に無応答(9:10 を過ぎた) → 9:00 で停止扱い
    const checked = { ...running, checkEnabled: true };
    expect(calculateHomeSummary(input({ sessions: [checked] })).accumulatedMinutes).toBe(60);
    // 9:05 に応答 → 継続(次の 10:00 の確認は now = 10:00 時点で未確定)
    expect(
      calculateHomeSummary(input({ sessions: [{ ...checked, confirmations: [jst('2026-10-07T09:05:00')] }] }))
        .accumulatedMinutes,
    ).toBe(120);
  });

  it('0:00 をまたいだ当日の計測は当日分(0:00 以降)だけをセッションから足す', () => {
    const overnight = studied('2026-10-06', 0, {
      startAt: jst('2026-10-06T23:30:00'),
      stopAt: jst('2026-10-07T00:20:00'),
    });
    const summary = calculateHomeSummary(
      input({ dailyResults: [result('2026-10-06', 30)], sessions: [overnight] }),
    );
    expect(summary.accumulatedMinutes).toBe(30 + 20);
  });

  it('他の目標の dailyResults・セッションは数えない', () => {
    const summary = calculateHomeSummary(
      input({
        dailyResults: [result('2026-10-05', 100), result('2026-10-06', 300, { goalId: 'old-goal' })],
        sessions: [studied('2026-10-07', 30), studied('2026-10-07', 30, { goalId: 'old-goal', startAt: jst('2026-10-07T07:00:00'), stopAt: jst('2026-10-07T07:30:00') })],
      }),
    );
    expect(summary).toMatchObject({ accumulatedMinutes: 130, elapsedDays: 1, metMinDays: 1, metGoalDays: 0 });
  });

  it('dailyResults がない過去日(判定前・課金切れで判定しなかった日)はセッションから積み上げに含め、達成日数・経過日数には数えない', () => {
    const summary = calculateHomeSummary(
      input({
        dailyResults: [result('2026-10-05', 60)],
        sessions: [studied('2026-10-06', 90), studied('2026-10-07', 10)],
      }),
    );
    expect(summary).toMatchObject({ accumulatedMinutes: 160, elapsedDays: 1, metMinDays: 1 });
  });

  it('開始日より前・今日より後の日付の計測と、今日以降の日付の dailyResults は数えない', () => {
    const summary = calculateHomeSummary(
      input({
        dailyResults: [result('2026-10-07', 500), result('2026-10-08', 500)],
        sessions: [studied('2026-09-30', 100), studied('2026-10-08', 100), studied('2026-10-07', 5)],
      }),
    );
    expect(summary).toMatchObject({ accumulatedMinutes: 5, elapsedDays: 0 });
  });

  it('開始日より前の日付の dailyResults は積み上げ・達成日数・経過日数に数えない(P-009)', () => {
    // 開始日 2026-10-01。前日 09-30 と、さらに前の 09-25 の dailyResults は数えず、開始日 10-01 は数える
    const summary = calculateHomeSummary(
      input({
        dailyResults: [result('2026-09-25', 200), result('2026-09-30', 150), result('2026-10-01', 30), result('2026-10-06', 60)],
        sessions: [studied('2026-10-07', 5)],
      }),
    );
    expect(summary).toMatchObject({
      accumulatedMinutes: 95,
      metMinDays: 1,
      metGoalDays: 0,
      elapsedDays: 2,
    });
  });

  it('開始日より前の日付の dailyResults が不正な値なら RangeError(範囲外でも形式は検証する)', () => {
    expect(() =>
      calculateHomeSummary(input({ dailyResults: [result('2026-09-30', -1)] })),
    ).toThrow(RangeError);
  });

  it('100%超: 達成率は実数、スライダーは 1、残り必要時間 0 で達成済み', () => {
    const summary = calculateHomeSummary(
      input({ dailyResults: [result('2026-10-05', 500), result('2026-10-06', 400)], sessions: [studied('2026-10-07', 1)] }),
    );
    expect(summary).toMatchObject({
      accumulatedMinutes: 901,
      achievementPercent: 150.1,
      sliderRatio: 1,
      remainingMinutes: 0,
      targetReached: true,
    });
  });

  it('ちょうど 100% は達成済み、1分足りなければ未達成', () => {
    expect(calculateHomeSummary(input({ dailyResults: [result('2026-10-06', 600)] }))).toMatchObject({
      achievementPercent: 100,
      sliderRatio: 1,
      remainingMinutes: 0,
      targetReached: true,
    });
    expect(calculateHomeSummary(input({ dailyResults: [result('2026-10-06', 599)] }))).toMatchObject({
      achievementPercent: 99.8,
      remainingMinutes: 1,
      targetReached: false,
    });
  });

  it('達成率は整数演算で切り捨て(浮動小数点の誤差なし)', () => {
    // 目標 2時間 = 120分、積み上げ 69分 → 57.5%(浮動小数点で計算すると 57.4)
    expect(
      calculateHomeSummary(
        input({ goal: { startDate: '2026-10-01', examDate: '2026-10-20', targetHours: 2 }, dailyResults: [result('2026-10-06', 69)] }),
      ).achievementPercent,
    ).toBe(57.5);
  });

  it('あと○日: 試験日が明日なら 1、当日・以降は exam_date_reached', () => {
    const goal = (examDate: string) => ({ startDate: '2026-10-01', examDate, targetHours: 10 });
    expect(calculateHomeSummary(input({ goal: goal('2026-10-08') })).exam).toEqual({
      status: 'before_exam',
      daysUntilExam: 1,
    });
    expect(calculateHomeSummary(input({ goal: goal('2026-10-07') })).exam).toEqual({ status: 'exam_date_reached' });
    expect(calculateHomeSummary(input({ goal: goal('2026-10-03') })).exam).toEqual({ status: 'exam_date_reached' });
    // 日本時間の 0:00 で切り替わる
    expect(
      calculateHomeSummary(input({ goal: goal('2026-10-08'), now: jst('2026-10-07T23:59:59') })).exam,
    ).toEqual({ status: 'before_exam', daysUntilExam: 1 });
    expect(
      calculateHomeSummary(input({ goal: goal('2026-10-08'), now: jst('2026-10-08T00:00:00') })).exam,
    ).toEqual({ status: 'exam_date_reached' });
  });

  it('不正なセッションは除外して続行し、excludedSessions で返す', () => {
    const summary = calculateHomeSummary(
      input({
        sessions: [
          studied('2026-10-07', 30),
          { ...studied('2026-10-07', 0), id: 'bad', startAt: jst('2026-10-07T11:00:00'), stopAt: null },
        ],
      }),
    );
    expect(summary.accumulatedMinutes).toBe(30);
    expect(summary.excludedSessions).toEqual([{ index: 1, id: 'bad', message: expect.any(String) }]);
  });

  it('不正な目標・dailyResults・now は RangeError', () => {
    expect(() => calculateHomeSummary(input({ now: NaN }))).toThrow(RangeError);
    expect(() =>
      calculateHomeSummary(input({ goal: { startDate: '2026-10-01', examDate: '2026-10-20', targetHours: 0 } })),
    ).toThrow(RangeError);
    expect(() =>
      calculateHomeSummary(input({ goal: { startDate: 'x', examDate: '2026-10-20', targetHours: 10 } })),
    ).toThrow(RangeError);
    expect(() => calculateHomeSummary(input({ dailyResults: [result('2026-10-05', -1)] }))).toThrow(RangeError);
    expect(() => calculateHomeSummary(input({ dailyResults: [result('2026-10-05', 1.5)] }))).toThrow(RangeError);
    expect(() =>
      calculateHomeSummary(input({ dailyResults: [result('2026-10-05', 10), result('2026-10-05', 20)] })),
    ).toThrow(RangeError);
  });
});
