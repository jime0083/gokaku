import {
  aggregateDailyStudyMinutes,
  aggregateDailyStudyMs,
  mergeRanges,
  msToWholeMinutes,
  sessionToRange,
  splitRangeByJstDay,
  type StudySession,
} from '../studyTime';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// `npm run test:tz` は TZ を日本以外にして同じテストを実行する。TZ が実際に反映されていることを確認する
describe('実行環境のタイムゾーン', () => {
  it('TZ 環境変数が実行時に反映されている', () => {
    const tz = process.env.TZ;
    if (tz) {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
    }
  });
});

describe('splitRangeByJstDay', () => {
  it('同じ日の中の区間は分割しない', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T09:00:00'), endAt: jst('2026-10-07T10:30:00') }),
    ).toEqual([{ date: '2026-10-07', ms: 90 * MIN }]);
  });

  it('日本時間 0:00 をまたぐ区間は 0:00 で分割する', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T23:30:00'), endAt: jst('2026-10-08T00:45:00') }),
    ).toEqual([
      { date: '2026-10-07', ms: 30 * MIN },
      { date: '2026-10-08', ms: 45 * MIN },
    ]);
  });

  it('複数日にまたがる区間は日ごとに分割する(中間日は丸1日)', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T22:00:00'), endAt: jst('2026-10-09T01:00:00') }),
    ).toEqual([
      { date: '2026-10-07', ms: 2 * HOUR },
      { date: '2026-10-08', ms: 24 * HOUR },
      { date: '2026-10-09', ms: 1 * HOUR },
    ]);
  });

  it('0:00 ちょうどに終わる区間は前日のみ、0:00 ちょうどに始まる区間は当日のみ', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T23:00:00'), endAt: jst('2026-10-08T00:00:00') }),
    ).toEqual([{ date: '2026-10-07', ms: HOUR }]);
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-08T00:00:00'), endAt: jst('2026-10-08T01:00:00') }),
    ).toEqual([{ date: '2026-10-08', ms: HOUR }]);
  });

  it('長さ 0 の区間は空配列', () => {
    const t = jst('2026-10-07T12:00:00');
    expect(splitRangeByJstDay({ startAt: t, endAt: t })).toEqual([]);
  });

  it('終了が開始より前・有限でない値は RangeError', () => {
    const t = jst('2026-10-07T12:00:00');
    expect(() => splitRangeByJstDay({ startAt: t, endAt: t - 1 })).toThrow(RangeError);
    expect(() => splitRangeByJstDay({ startAt: Number.NaN, endAt: t })).toThrow(RangeError);
  });
});

describe('sessionToRange', () => {
  it('停止済みは stopAt まで、計測中は now まで', () => {
    const startAt = jst('2026-10-07T10:00:00');
    const stopAt = jst('2026-10-07T11:00:00');
    const now = jst('2026-10-07T12:00:00');
    expect(sessionToRange({ startAt, stopAt }, now)).toEqual({ startAt, endAt: stopAt });
    expect(sessionToRange({ startAt, stopAt: null }, now)).toEqual({ startAt, endAt: now });
  });

  it('計測中で now が開始より前なら RangeError', () => {
    const startAt = jst('2026-10-07T10:00:00');
    expect(() => sessionToRange({ startAt, stopAt: null }, startAt - 1)).toThrow(RangeError);
  });
});

describe('mergeRanges', () => {
  it('重なる・接する区間を結合し、入力を変更しない', () => {
    const input = [
      { startAt: 50, endAt: 60 },
      { startAt: 0, endAt: 10 },
      { startAt: 5, endAt: 20 },
      { startAt: 20, endAt: 30 },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(mergeRanges(input)).toEqual([
      { startAt: 0, endAt: 30 },
      { startAt: 50, endAt: 60 },
    ]);
    expect(input).toEqual(snapshot);
  });

  it('内包される区間は外側に吸収される', () => {
    expect(mergeRanges([{ startAt: 0, endAt: 100 }, { startAt: 10, endAt: 20 }])).toEqual([
      { startAt: 0, endAt: 100 },
    ]);
  });
});

describe('aggregateDailyStudyMs', () => {
  const now = jst('2026-10-09T12:00:00');

  it('セッションなしは空', () => {
    expect(aggregateDailyStudyMs([], now)).toEqual({});
  });

  it('複数セッションを日ごとに合計し、日またぎは 0:00 で分割して加算する', () => {
    const sessions: StudySession[] = [
      { startAt: jst('2026-10-07T09:00:00'), stopAt: jst('2026-10-07T10:00:00') },
      { startAt: jst('2026-10-07T20:00:00'), stopAt: jst('2026-10-07T20:30:00') },
      { startAt: jst('2026-10-07T23:00:00'), stopAt: jst('2026-10-08T01:15:00') },
      { startAt: jst('2026-10-08T21:00:00'), stopAt: jst('2026-10-08T22:00:00') },
    ];
    expect(aggregateDailyStudyMs(sessions, now)).toEqual({
      '2026-10-07': 2 * HOUR + 30 * MIN,
      '2026-10-08': 2 * HOUR + 15 * MIN,
    });
  });

  it('計測中のセッションは now までを加算する(0:00 時点の判定では now=0:00 で前日分のみになる)', () => {
    const sessions: StudySession[] = [{ startAt: jst('2026-10-07T23:20:00'), stopAt: null }];
    expect(aggregateDailyStudyMs(sessions, jst('2026-10-08T00:00:00'))).toEqual({
      '2026-10-07': 40 * MIN,
    });
    expect(aggregateDailyStudyMs(sessions, jst('2026-10-08T00:10:00'))).toEqual({
      '2026-10-07': 40 * MIN,
      '2026-10-08': 10 * MIN,
    });
  });

  it('重なったセッション(データ不正)は二重に加算しない', () => {
    const sessions: StudySession[] = [
      { startAt: jst('2026-10-07T10:00:00'), stopAt: jst('2026-10-07T12:00:00') },
      { startAt: jst('2026-10-07T11:00:00'), stopAt: jst('2026-10-07T13:00:00') },
      { startAt: jst('2026-10-07T10:00:00'), stopAt: jst('2026-10-07T12:00:00') },
    ];
    expect(aggregateDailyStudyMs(sessions, now)).toEqual({ '2026-10-07': 3 * HOUR });
  });

  it('入力の順序に依存しない', () => {
    const a = { startAt: jst('2026-10-08T21:00:00'), stopAt: jst('2026-10-08T22:00:00') };
    const b = { startAt: jst('2026-10-07T23:00:00'), stopAt: jst('2026-10-08T01:00:00') };
    expect(aggregateDailyStudyMs([a, b], now)).toEqual(aggregateDailyStudyMs([b, a], now));
  });

  it('不正なセッション・now は RangeError', () => {
    const t = jst('2026-10-07T10:00:00');
    expect(() => aggregateDailyStudyMs([{ startAt: t, stopAt: t - 1 }], now)).toThrow(RangeError);
    expect(() => aggregateDailyStudyMs([], Number.NaN)).toThrow(RangeError);
  });
});

describe('msToWholeMinutes', () => {
  it('1分未満を切り捨てる', () => {
    expect(msToWholeMinutes(0)).toBe(0);
    expect(msToWholeMinutes(59_999)).toBe(0);
    expect(msToWholeMinutes(60_000)).toBe(1);
    expect(msToWholeMinutes(119_999)).toBe(1);
  });

  it('負数・有限でない値は RangeError', () => {
    expect(() => msToWholeMinutes(-1)).toThrow(RangeError);
    expect(() => msToWholeMinutes(Number.NaN)).toThrow(RangeError);
  });
});

describe('aggregateDailyStudyMinutes', () => {
  const now = jst('2026-10-09T12:00:00');

  it('日ごとのミリ秒合計を切り捨てで分にする(セッションごとには丸めない)', () => {
    // 40秒 × 3 = 2分(セッションごとに切り捨てると 0 分になってしまう)
    const sessions: StudySession[] = [0, 1, 2].map((i) => ({
      startAt: jst('2026-10-07T10:00:00') + i * 10 * MIN,
      stopAt: jst('2026-10-07T10:00:40') + i * 10 * MIN,
    }));
    expect(aggregateDailyStudyMinutes(sessions, now)).toEqual({ '2026-10-07': 2 });
  });

  it('日またぎで分割した各日をそれぞれ切り捨てる', () => {
    const sessions: StudySession[] = [
      { startAt: jst('2026-10-07T23:59:30'), stopAt: jst('2026-10-08T00:30:30') },
    ];
    expect(aggregateDailyStudyMinutes(sessions, now)).toEqual({
      '2026-10-07': 0,
      '2026-10-08': 30,
    });
  });
});

// レビュー担当追加: 端末タイムゾーンの 0:00(UTC / America/Los_Angeles)をまたいでも、日本時間の 0:00 でしか分割しないこと
describe('日本以外のタイムゾーンの 0:00 で分割しない', () => {
  it('UTC の 0:00(JST 9:00)をまたぐ区間は分割しない', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T08:30:00'), endAt: jst('2026-10-07T09:30:00') }),
    ).toEqual([{ date: '2026-10-07', ms: HOUR }]);
  });

  it('America/Los_Angeles の 0:00(夏時間中は JST 16:00)をまたぐ区間は分割しない', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-07T15:30:00'), endAt: jst('2026-10-07T16:30:00') }),
    ).toEqual([{ date: '2026-10-07', ms: HOUR }]);
  });

  it('米国の夏時間終了日(2026-11-01)をまたぐ長時間セッションも日本時間の24時間単位で分割する', () => {
    expect(
      splitRangeByJstDay({ startAt: jst('2026-10-31T20:00:00'), endAt: jst('2026-11-02T03:00:00') }),
    ).toEqual([
      { date: '2026-10-31', ms: 4 * HOUR },
      { date: '2026-11-01', ms: 24 * HOUR },
      { date: '2026-11-02', ms: 3 * HOUR },
    ]);
  });
});

// レビュー担当追加: 0:00 判定時(now = 当日 0:00)の、停止済み複数セッション + 計測中セッションの前日分
describe('0:00 判定時点の前日分(複数セッション + 計測中)', () => {
  it('停止済みと計測中のセッションを合わせ、前日分のみを分で返す', () => {
    const sessions: StudySession[] = [
      { startAt: jst('2026-10-07T07:00:00'), stopAt: jst('2026-10-07T07:59:50') },
      { startAt: jst('2026-10-07T21:00:00'), stopAt: jst('2026-10-07T21:30:20') },
      { startAt: jst('2026-10-07T23:15:30'), stopAt: null },
    ];
    // 59分50秒 + 30分20秒 + 44分30秒 = 2時間14分40秒 → 134分
    expect(aggregateDailyStudyMinutes(sessions, jst('2026-10-08T00:00:00'))).toEqual({
      '2026-10-07': 134,
    });
  });
});
