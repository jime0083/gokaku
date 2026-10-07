import {
  type DailyJudgement,
  type DailyJudgementInput,
  isSubscriptionActiveAt,
  judgeDailyResult,
  type JudgementSession,
} from '../dailyJudgement';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const MIN = 60 * 1000;

/** 判定時刻: 2026-10-08 0:00(2026-10-07 分を判定) */
const MIDNIGHT = jst('2026-10-08T00:00:00');
const TARGET = '2026-10-07';
const GOAL_ID = 'goal-1';

const session = (overrides: Partial<JudgementSession> = {}): JudgementSession => ({
  goalId: GOAL_ID,
  startAt: jst('2026-10-07T09:00:00'),
  stopAt: jst('2026-10-07T10:00:00'),
  checkEnabled: false,
  confirmations: [],
  ...overrides,
});

/** 指定した分だけ 2026-10-07 9:00 から勉強したセッション */
const studied = (minutes: number, goalId = GOAL_ID): JudgementSession =>
  session({ goalId, stopAt: jst('2026-10-07T09:00:00') + minutes * MIN });

const input = (overrides: Partial<DailyJudgementInput> = {}): DailyJudgementInput => ({
  goalId: GOAL_ID,
  goal: {
    startDate: '2026-10-01',
    examDate: '2027-02-01',
    minDailyMinutes: 60,
    goalDailyMinutes: 120,
  },
  user: {
    xPostEnabled: true,
    xLinked: true,
    subscription: { expiresAt: jst('2026-11-01T00:00:00') },
  },
  sessions: [],
  judgedAt: MIDNIGHT,
  ...overrides,
});

type Judged = Extract<DailyJudgement, { judged: true }>;

const judged = (overrides: Partial<DailyJudgementInput> = {}): Judged => {
  const result = judgeDailyResult(input(overrides));
  if (!result.judged) {
    throw new Error(`判定しない日になりました: ${result.reason}`);
  }
  return result;
};

describe('達成/未達成', () => {
  it('最低・努力目標とも達成: 投稿不要(none)', () => {
    const r = judged({ sessions: [studied(120)] });
    expect(r.date).toBe(TARGET);
    expect(r.result).toEqual({
      goalId: GOAL_ID,
      studiedMinutes: 120,
      metMin: true,
      metGoal: true,
      postStatus: 'none',
      postSkipReasons: [],
    });
    expect(r.excludedSessions).toEqual([]);
    expect(r.otherGoalSessionCount).toBe(0);
  });

  it('最低のみ達成(ちょうど最低時間): 努力目標は未達成、投稿不要', () => {
    const r = judged({ sessions: [studied(60)] });
    expect(r.result).toMatchObject({
      studiedMinutes: 60,
      metMin: true,
      metGoal: false,
      postStatus: 'none',
      postSkipReasons: [],
    });
  });

  it('最低未達成で投稿条件をすべて満たす: 投稿待ち(pending)', () => {
    const r = judged({ sessions: [studied(59)] });
    expect(r.result).toMatchObject({
      studiedMinutes: 59,
      metMin: false,
      metGoal: false,
      postStatus: 'pending',
      postSkipReasons: [],
    });
  });

  it('1日の合計を分に切り捨てて比較する(59分40秒は 59分で未達成)', () => {
    const start = jst('2026-10-07T09:00:00');
    const r = judged({
      sessions: [
        session({ startAt: start, stopAt: start + 30 * MIN + 20 * 1000 }),
        session({ startAt: start + 60 * MIN, stopAt: start + 89 * MIN + 20 * 1000 }),
      ],
    });
    expect(r.result).toMatchObject({ studiedMinutes: 59, metMin: false });
  });

  it('セッションなしは 0分で未達成', () => {
    const r = judged();
    expect(r.result).toMatchObject({ studiedMinutes: 0, metMin: false, metGoal: false, postStatus: 'pending' });
  });

  it('前日以外の日の勉強時間は含めない', () => {
    const r = judged({
      sessions: [
        session({ startAt: jst('2026-10-06T09:00:00'), stopAt: jst('2026-10-06T12:00:00') }),
        studied(30),
      ],
    });
    expect(r.result.studiedMinutes).toBe(30);
  });
});

describe('判定の対象日(開始日〜試験日の前日)', () => {
  it('試験日の前日は判定する', () => {
    const r = judged({ goal: { ...input().goal, examDate: '2026-10-08' } });
    expect(r.date).toBe(TARGET);
  });

  it('試験日当日は判定しない', () => {
    expect(judgeDailyResult(input({ goal: { ...input().goal, examDate: TARGET } }))).toEqual({
      judged: false,
      date: TARGET,
      reason: 'exam_date_reached',
    });
  });

  it('試験日より後は判定しない', () => {
    expect(judgeDailyResult(input({ goal: { ...input().goal, examDate: '2026-10-05' } }))).toEqual({
      judged: false,
      date: TARGET,
      reason: 'exam_date_reached',
    });
  });

  it('開始日より前は判定しない', () => {
    expect(judgeDailyResult(input({ goal: { ...input().goal, startDate: '2026-10-08' } }))).toEqual({
      judged: false,
      date: TARGET,
      reason: 'before_start_date',
    });
  });

  it('開始日(登録日)は判定して達成を記録する', () => {
    const r = judged({ goal: { ...input().goal, startDate: TARGET }, sessions: [studied(120)] });
    expect(r.result).toMatchObject({ metMin: true, metGoal: true, postStatus: 'none' });
  });

  it('開始日(登録日)は未達成でも投稿しない(skipped / start_date)', () => {
    const r = judged({ goal: { ...input().goal, startDate: TARGET }, sessions: [studied(10)] });
    expect(r.result).toMatchObject({
      studiedMinutes: 10,
      metMin: false,
      postStatus: 'skipped',
      postSkipReasons: ['start_date'],
    });
  });

  it('判定処理が 0:00 より遅れて動いても前日分を判定する', () => {
    const r = judged({ judgedAt: MIDNIGHT + 5 * MIN, sessions: [studied(59)] });
    expect(r.date).toBe(TARGET);
    expect(r.result.studiedMinutes).toBe(59);
  });
});

describe('課金切れの日は判定しない', () => {
  const notJudged = { judged: false, date: TARGET, reason: 'subscription_inactive' };

  it('判定日の 0:00 時点で有効期限切れなら判定しない(未達成でも達成でも)', () => {
    const user = { ...input().user, subscription: { expiresAt: jst('2026-10-07T23:59:59') } };
    expect(judgeDailyResult(input({ user, sessions: [studied(30)] }))).toEqual(notJudged);
    expect(judgeDailyResult(input({ user, sessions: [studied(120)] }))).toEqual(notJudged);
  });

  it('課金状態なし(subscription null / expiresAt null)なら判定しない', () => {
    expect(judgeDailyResult(input({ user: { ...input().user, subscription: null } }))).toEqual(notJudged);
    expect(
      judgeDailyResult(input({ user: { ...input().user, subscription: { expiresAt: null } } })),
    ).toEqual(notJudged);
  });

  it('課金状態は判定日の 0:00 時点で判定する(有効期限 0:00 ちょうどは切れ、0:00 より後なら課金中)', () => {
    const at = (expiresAt: number) =>
      judgeDailyResult(
        input({
          sessions: [studied(30)],
          judgedAt: MIDNIGHT + 3 * MIN,
          user: { ...input().user, subscription: { expiresAt } },
        }),
      );
    expect(at(MIDNIGHT)).toEqual(notJudged);
    expect(at(MIDNIGHT + 1)).toMatchObject({ judged: true, result: { postStatus: 'pending' } });
  });

  it('試験日当日以降は課金切れでも exam_date_reached', () => {
    expect(
      judgeDailyResult(
        input({ goal: { ...input().goal, examDate: TARGET }, user: { ...input().user, subscription: null } }),
      ),
    ).toMatchObject({ judged: false, reason: 'exam_date_reached' });
  });
});

describe('投稿要否(最低未達成 かつ X投稿ON かつ X連携済み かつ 課金中 のみ投稿)', () => {
  const unmet = [studied(30)];

  it('X投稿OFF: 投稿しない(skipped / x_post_disabled)', () => {
    const r = judged({ sessions: unmet, user: { ...input().user, xPostEnabled: false } });
    expect(r.result).toMatchObject({ postStatus: 'skipped', postSkipReasons: ['x_post_disabled'] });
  });

  it('X未連携: 投稿しない(skipped / x_not_linked)', () => {
    const r = judged({ sessions: unmet, user: { ...input().user, xLinked: false } });
    expect(r.result).toMatchObject({ postStatus: 'skipped', postSkipReasons: ['x_not_linked'] });
  });

  it('投稿しない理由が複数ある場合はすべて返す', () => {
    const r = judged({
      sessions: unmet,
      goal: { ...input().goal, startDate: TARGET },
      user: { ...input().user, xPostEnabled: false, xLinked: false },
    });
    expect(r.result).toMatchObject({
      postStatus: 'skipped',
      postSkipReasons: ['start_date', 'x_post_disabled', 'x_not_linked'],
    });
  });

  it('最低達成なら X投稿OFF・未連携でも none(理由なし)', () => {
    const r = judged({
      sessions: [studied(60)],
      user: { ...input().user, xPostEnabled: false, xLinked: false },
    });
    expect(r.result).toMatchObject({ postStatus: 'none', postSkipReasons: [] });
  });
});

describe('判定時点の設定値を使う', () => {
  it('渡された最低/努力目標の値で判定する(当日中に変更した場合も判定時点の値)', () => {
    const sessions = [studied(90)];
    expect(judged({ sessions }).result).toMatchObject({ metMin: true, metGoal: false });
    const raised = judged({
      sessions,
      goal: { ...input().goal, minDailyMinutes: 100, goalDailyMinutes: 100 },
    });
    expect(raised.result).toMatchObject({
      studiedMinutes: 90,
      metMin: false,
      metGoal: false,
      postStatus: 'pending',
    });
    const lowered = judged({
      sessions,
      goal: { ...input().goal, minDailyMinutes: 30, goalDailyMinutes: 90 },
    });
    expect(lowered.result).toMatchObject({ metMin: true, metGoal: true });
  });
});

describe('その目標(goalId)のセッションだけを使う', () => {
  it('他の目標のセッションは含めず、不正データとは別に件数を返す', () => {
    const r = judged({
      sessions: [studied(30), studied(120, 'old-goal'), studied(45, 'other-goal')],
    });
    expect(r.result.studiedMinutes).toBe(30);
    expect(r.otherGoalSessionCount).toBe(2);
    expect(r.excludedSessions).toEqual([]);
  });

  it('目標変更日は変更後の目標で測った分だけで判定し、開始日なので未達成でも投稿しない', () => {
    // 9:00〜11:00 旧目標で計測 → 12:00 に目標変更 → 13:00〜13:30 新目標で計測
    const r = judged({
      goalId: 'new-goal',
      goal: { ...input().goal, startDate: TARGET },
      sessions: [
        session({ goalId: 'old-goal', stopAt: jst('2026-10-07T11:00:00') }),
        session({
          goalId: 'new-goal',
          startAt: jst('2026-10-07T13:00:00'),
          stopAt: jst('2026-10-07T13:30:00'),
        }),
      ],
    });
    expect(r.result).toEqual({
      goalId: 'new-goal',
      studiedMinutes: 30,
      metMin: false,
      metGoal: false,
      postStatus: 'skipped',
      postSkipReasons: ['start_date'],
    });
    expect(r.otherGoalSessionCount).toBe(1);
  });

  it('他の目標の不正なセッションは不正データとして数えない(対象外)', () => {
    const r = judged({ sessions: [studied(30), session({ goalId: 'old-goal', startAt: NaN })] });
    expect(r.excludedSessions).toEqual([]);
    expect(r.otherGoalSessionCount).toBe(1);
  });
});

describe('0:00 時点で計測中のセッション', () => {
  it('計測中(stopAt null)は 0:00 までを前日分に含める', () => {
    const r = judged({
      judgedAt: MIDNIGHT + 2 * MIN,
      sessions: [session({ startAt: jst('2026-10-07T23:00:00'), stopAt: null })],
    });
    expect(r.result).toMatchObject({ studiedMinutes: 60, metMin: true });
  });

  it('0:00 より後に停止したセッションも 0:00 までを前日分に含める', () => {
    const r = judged({
      judgedAt: MIDNIGHT + 40 * MIN,
      sessions: [session({ startAt: jst('2026-10-07T23:30:00'), stopAt: MIDNIGHT + 30 * MIN })],
    });
    expect(r.result.studiedMinutes).toBe(30);
  });

  it('確認の応答期限が 0:00 時点で来ていない場合は計測中とみなし 0:00 まで含める(後の無応答確定は反映しない)', () => {
    // 22:55 開始 → 23:55 に確認(期限 0:05)。応答なしのまま 0:20 に停止(本来は 23:55 で check_timeout)
    const r = judged({
      judgedAt: MIDNIGHT + 30 * MIN,
      sessions: [
        session({
          startAt: jst('2026-10-07T22:55:00'),
          stopAt: MIDNIGHT + 20 * MIN,
          checkEnabled: true,
        }),
      ],
    });
    expect(r.result.studiedMinutes).toBe(65);
  });

  it('0:00 より前に無応答が確定した確認は確認時刻で停止する', () => {
    // 22:00 開始 → 23:00 の確認に無応答(期限 23:10)。23:00 で停止扱い
    const r = judged({
      sessions: [session({ startAt: jst('2026-10-07T22:00:00'), stopAt: null, checkEnabled: true })],
    });
    expect(r.result.studiedMinutes).toBe(60);
  });

  it('0:00 以降に開始したセッションは対象外(計測中でもエラーにしない)', () => {
    const r = judged({
      judgedAt: MIDNIGHT + 10 * MIN,
      sessions: [studied(30), session({ startAt: MIDNIGHT + 1 * MIN, stopAt: null })],
    });
    expect(r.result.studiedMinutes).toBe(30);
    expect(r.excludedSessions).toEqual([]);
  });
});

describe('不正なセッションの混在', () => {
  it('不正なセッションを除外して判定を続け、除外したセッションを返す', () => {
    const r = judged({
      sessions: [
        studied(70),
        session({ stopAt: jst('2026-10-07T08:00:00'), id: 'bad-stop' }),
        session({ startAt: NaN }),
        session({ confirmations: [NaN], id: 'bad-confirmation' }),
      ],
    });
    expect(r.result).toMatchObject({ studiedMinutes: 70, metMin: true });
    expect(r.excludedSessions.map(({ index, id }) => ({ index, id }))).toEqual([
      { index: 1, id: 'bad-stop' },
      { index: 2, id: undefined },
      { index: 3, id: 'bad-confirmation' },
    ]);
    expect('id' in r.excludedSessions[1]).toBe(false);
    expect(r.excludedSessions.every(({ message }) => message.length > 0)).toBe(true);
    expect(r.otherGoalSessionCount).toBe(0);
  });

  it('すべて不正なら 0分として判定する', () => {
    const r = judged({ sessions: [session({ startAt: Infinity, stopAt: null })] });
    expect(r.result.studiedMinutes).toBe(0);
    expect(r.excludedSessions).toHaveLength(1);
  });

  it('RangeError 以外の例外は握りつぶさない', () => {
    const broken = { ...session(), confirmations: null } as unknown as JudgementSession;
    expect(() => judgeDailyResult(input({ sessions: [broken] }))).toThrow(TypeError);
  });

  it('入力のセッション配列を変更しない', () => {
    const sessions = Object.freeze([
      Object.freeze(session({ startAt: jst('2026-10-07T23:30:00'), stopAt: MIDNIGHT + 10 * MIN })),
    ]);
    expect(() => judged({ judgedAt: MIDNIGHT + 20 * MIN, sessions })).not.toThrow();
    expect(sessions[0].stopAt).toBe(MIDNIGHT + 10 * MIN);
  });
});

describe('入力チェック', () => {
  it('判定時刻・目標・課金状態が不正なら RangeError', () => {
    expect(() => judgeDailyResult(input({ judgedAt: NaN }))).toThrow(RangeError);
    expect(() => judgeDailyResult(input({ goal: { ...input().goal, startDate: '2026-02-30' } }))).toThrow(
      RangeError,
    );
    expect(() => judgeDailyResult(input({ goal: { ...input().goal, examDate: '2027/02/01' } }))).toThrow(
      RangeError,
    );
    expect(() => judgeDailyResult(input({ goal: { ...input().goal, minDailyMinutes: -1 } }))).toThrow(
      RangeError,
    );
    expect(() => judgeDailyResult(input({ goal: { ...input().goal, goalDailyMinutes: 1.5 } }))).toThrow(
      RangeError,
    );
    expect(() =>
      judgeDailyResult(input({ user: { ...input().user, subscription: { expiresAt: NaN } } })),
    ).toThrow(RangeError);
  });

  it('isSubscriptionActiveAt: 有効期限より前のみ課金中', () => {
    expect(isSubscriptionActiveAt({ expiresAt: 1000 }, 999)).toBe(true);
    expect(isSubscriptionActiveAt({ expiresAt: 1000 }, 1000)).toBe(false);
    expect(isSubscriptionActiveAt({ expiresAt: null }, 0)).toBe(false);
    expect(isSubscriptionActiveAt(null, 0)).toBe(false);
  });
});
