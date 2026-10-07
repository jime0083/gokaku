import {
  aggregateEffectiveDailyStudyMinutes,
  aggregateEffectiveDailyStudyMs,
  type CheckedStudySession,
  resolveSessionEnd,
  STUDY_CHECK_INTERVAL_MS,
  STUDY_CHECK_RESPONSE_WINDOW_MS,
  toEffectiveSession,
} from '../studyCheck';
import { aggregateDailyStudyMinutes } from '../studyTime';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const MIN = 60 * 1000;

const START = jst('2026-10-07T09:00:00');
/** k 回目の確認時刻(開始 + k × 60分) */
const checkAt = (k: number, startAt = START): number => startAt + k * 60 * MIN;

const session = (overrides: Partial<CheckedStudySession> = {}): CheckedStudySession => ({
  startAt: START,
  stopAt: null,
  checkEnabled: true,
  confirmations: [],
  ...overrides,
});

describe('確認の数値(requirements 3-2)', () => {
  it('確認は60分ごと、応答期限は10分', () => {
    expect(STUDY_CHECK_INTERVAL_MS).toBe(60 * MIN);
    expect(STUDY_CHECK_RESPONSE_WINDOW_MS).toBe(10 * MIN);
  });
});

describe('resolveSessionEnd: 応答あり', () => {
  it('各確認に応答していれば手動停止の時刻まで計測する', () => {
    const stopAt = checkAt(3) + 20 * MIN;
    expect(
      resolveSessionEnd(
        session({
          stopAt,
          confirmations: [checkAt(1) + 1 * MIN, checkAt(2) + 9 * MIN, checkAt(3)],
        }),
        stopAt,
      ),
    ).toEqual({ endAt: stopAt, endReason: 'manual' });
  });

  it('応答期限ちょうど(確認 + 10分)の応答は有効', () => {
    const stopAt = checkAt(1) + 30 * MIN;
    expect(
      resolveSessionEnd(session({ stopAt, confirmations: [checkAt(1) + 10 * MIN] }), stopAt),
    ).toEqual({ endAt: stopAt, endReason: 'manual' });
  });

  it('計測中で全ての確認に応答していれば now まで計測中', () => {
    const now = checkAt(2) + 30 * MIN;
    expect(
      resolveSessionEnd(
        session({ confirmations: [checkAt(2) + 2 * MIN, checkAt(1) + 5 * MIN] }),
        now,
      ),
    ).toEqual({ endAt: now, endReason: 'running' });
  });
});

describe('resolveSessionEnd: 応答なし', () => {
  it('無応答の確認があれば、その確認を出した時刻で停止する(無応答の10分は加算しない)', () => {
    const now = checkAt(1) + 11 * MIN;
    expect(resolveSessionEnd(session(), now)).toEqual({
      endAt: checkAt(1),
      endReason: 'check_timeout',
    });
  });

  it('1回目は応答・2回目は無応答なら2回目の確認時刻で停止する', () => {
    const now = checkAt(5);
    expect(resolveSessionEnd(session({ confirmations: [checkAt(1) + 3 * MIN] }), now)).toEqual({
      endAt: checkAt(2),
      endReason: 'check_timeout',
    });
  });

  it('応答期限を1ミリ秒でも過ぎた応答・確認前の応答は無視する', () => {
    const now = checkAt(3);
    const late = checkAt(1) + 10 * MIN + 1;
    const early = checkAt(1) - 1;
    expect(resolveSessionEnd(session({ confirmations: [early, late] }), now)).toEqual({
      endAt: checkAt(1),
      endReason: 'check_timeout',
    });
  });

  it('開始前・前回の確認への応答で次の確認を満たすことはない', () => {
    const now = checkAt(2) + 11 * MIN;
    // checkAt(1)+5分 は1回目への応答。2回目(checkAt(2))には応答していない
    expect(
      resolveSessionEnd(session({ confirmations: [START - MIN, checkAt(1) + 5 * MIN] }), now),
    ).toEqual({
      endAt: checkAt(2),
      endReason: 'check_timeout',
    });
  });

  it('計測中で now が応答期限を過ぎていなければ未確定とし、停止扱いにしない', () => {
    expect(resolveSessionEnd(session(), checkAt(1) + 5 * MIN)).toEqual({
      endAt: checkAt(1) + 5 * MIN,
      endReason: 'running',
    });
    // 応答期限ちょうどはまだ応答できるため未確定
    expect(resolveSessionEnd(session(), checkAt(1) + 10 * MIN)).toEqual({
      endAt: checkAt(1) + 10 * MIN,
      endReason: 'running',
    });
    // 応答期限を過ぎたら確定
    expect(resolveSessionEnd(session(), checkAt(1) + 10 * MIN + 1)).toEqual({
      endAt: checkAt(1),
      endReason: 'check_timeout',
    });
  });

  it('停止時刻より前に無応答が確定していれば、手動停止より check_timeout を優先する', () => {
    const stopAt = checkAt(3) + 15 * MIN;
    expect(
      resolveSessionEnd(session({ stopAt, confirmations: [checkAt(1) + MIN] }), stopAt + 60 * MIN),
    ).toEqual({
      endAt: checkAt(2),
      endReason: 'check_timeout',
    });
  });
});

describe('resolveSessionEnd: 途中で停止', () => {
  it('最初の確認より前に停止した場合は確認なしで手動停止', () => {
    const stopAt = START + 59 * MIN;
    expect(resolveSessionEnd(session({ stopAt }), stopAt)).toEqual({
      endAt: stopAt,
      endReason: 'manual',
    });
  });

  it('確認時刻ちょうどに停止した場合、その確認は出ていないので手動停止', () => {
    const stopAt = checkAt(1);
    expect(resolveSessionEnd(session({ stopAt }), stopAt + 30 * MIN)).toEqual({
      endAt: stopAt,
      endReason: 'manual',
    });
  });

  it('確認の応答期限内(期限ちょうどを含む)に、応答せず手動停止した場合は手動停止の時刻', () => {
    const during = checkAt(1) + 5 * MIN;
    expect(resolveSessionEnd(session({ stopAt: during }), during + 60 * MIN)).toEqual({
      endAt: during,
      endReason: 'manual',
    });
    const atDeadline = checkAt(1) + 10 * MIN;
    expect(resolveSessionEnd(session({ stopAt: atDeadline }), atDeadline)).toEqual({
      endAt: atDeadline,
      endReason: 'manual',
    });
  });

  it('アプリが記録した自動停止(stopAt = 確認時刻)を再計算しても終了時刻は変わらない', () => {
    const recorded = toEffectiveSession(session(), checkAt(1) + 11 * MIN);
    expect(recorded).toEqual({ startAt: START, stopAt: checkAt(1) });
    expect(resolveSessionEnd(session({ stopAt: recorded.stopAt }), checkAt(5)).endAt).toBe(
      checkAt(1),
    );
  });
});

describe('resolveSessionEnd: 確認OFF', () => {
  it('確認なし・上限なし(応答がなくても停止しない)', () => {
    const now = START + 30 * 60 * MIN;
    expect(resolveSessionEnd(session({ checkEnabled: false }), now)).toEqual({
      endAt: now,
      endReason: 'running',
    });
    const stopAt = START + 10 * 60 * MIN;
    expect(resolveSessionEnd(session({ checkEnabled: false, stopAt }), now)).toEqual({
      endAt: stopAt,
      endReason: 'manual',
    });
  });
});

describe('resolveSessionEnd: 入力チェック', () => {
  it('不正な時刻・停止が開始より前・計測中で now が開始より前は RangeError', () => {
    expect(() => resolveSessionEnd(session({ startAt: NaN }), START)).toThrow(RangeError);
    expect(() => resolveSessionEnd(session(), Infinity)).toThrow(RangeError);
    expect(() => resolveSessionEnd(session({ stopAt: START - 1 }), START)).toThrow(RangeError);
    expect(() => resolveSessionEnd(session(), START - 1)).toThrow(RangeError);
    expect(() => resolveSessionEnd(session({ confirmations: [NaN] }), START)).toThrow(RangeError);
  });

  it('入力を変更しない', () => {
    const input = session({ confirmations: [checkAt(1) + MIN] });
    const snapshot = JSON.parse(JSON.stringify(input));
    resolveSessionEnd(input, checkAt(3));
    toEffectiveSession(input, checkAt(3));
    expect(input).toEqual(snapshot);
  });
});

describe('0:00 またぎ', () => {
  const start = jst('2026-10-07T23:00:00');
  const midnight = jst('2026-10-08T00:00:00');

  it('確認に応答して 0:00 をまたいだ計測は 0:00 で分割して各日に加算する', () => {
    const stopAt = jst('2026-10-08T00:30:00');
    const s = session({ startAt: start, stopAt, confirmations: [jst('2026-10-08T00:02:00')] });
    expect(resolveSessionEnd(s, stopAt)).toEqual({ endAt: stopAt, endReason: 'manual' });
    expect(aggregateEffectiveDailyStudyMinutes([s], stopAt)).toEqual({
      '2026-10-07': 60,
      '2026-10-08': 30,
    });
  });

  it('0:00 の確認(23:00開始)に無応答なら 0:00 で停止し、当日分は加算しない', () => {
    const now = jst('2026-10-08T01:00:00');
    const s = session({ startAt: start });
    expect(resolveSessionEnd(s, now)).toEqual({ endAt: midnight, endReason: 'check_timeout' });
    expect(aggregateEffectiveDailyStudyMinutes([s], now)).toEqual({ '2026-10-07': 60 });
  });

  describe('0:00 判定(now = 0:00)で 23:55 の確認の応答期限(0:05)が来ていない場合', () => {
    const start2255 = jst('2026-10-07T22:55:00'); // 確認は 23:55、期限は 0:05

    it('0:00 時点では未確定のため計測中とみなし、前日分は 0:00 まで加算する', () => {
      const s = session({ startAt: start2255 });
      expect(resolveSessionEnd(s, midnight)).toEqual({ endAt: midnight, endReason: 'running' });
      expect(aggregateEffectiveDailyStudyMinutes([s], midnight)).toEqual({ '2026-10-07': 65 });
    });

    it('後で無応答が確定すると停止時刻は 23:55 になり、再計算すると前日分は 60分・当日分は 0', () => {
      const s = session({ startAt: start2255 });
      const later = jst('2026-10-08T00:06:00');
      expect(resolveSessionEnd(s, later)).toEqual({
        endAt: jst('2026-10-07T23:55:00'),
        endReason: 'check_timeout',
      });
      expect(aggregateEffectiveDailyStudyMinutes([s], later)).toEqual({ '2026-10-07': 60 });
    });

    it('後で応答があれば計測は継続し、当日分にも加算される', () => {
      const s = session({ startAt: start2255, confirmations: [jst('2026-10-08T00:03:00')] });
      const later = jst('2026-10-08T00:20:00');
      expect(resolveSessionEnd(s, later)).toEqual({ endAt: later, endReason: 'running' });
      expect(aggregateEffectiveDailyStudyMinutes([s], later)).toEqual({
        '2026-10-07': 65,
        '2026-10-08': 20,
      });
    });
  });
});

describe('aggregateEffectiveDailyStudyMs / Minutes', () => {
  it('確認による停止を反映し、確認OFF・停止済みのセッションと合わせて日ごとに集計する', () => {
    const now = jst('2026-10-07T23:00:00');
    const sessions: CheckedStudySession[] = [
      // 確認ON・無応答: 9:00〜10:00 の60分のみ(本来の停止 12:00 ではなく 10:00 で停止)
      session({ startAt: START, stopAt: jst('2026-10-07T12:00:00') }),
      // 確認OFF: 13:00〜16:00 の180分
      session({
        startAt: jst('2026-10-07T13:00:00'),
        stopAt: jst('2026-10-07T16:00:00'),
        checkEnabled: false,
      }),
      // 確認ON・計測中で応答期限前: 21:30〜23:00(now) の90分
      session({ startAt: jst('2026-10-07T21:30:00'), confirmations: [jst('2026-10-07T22:31:00')] }),
    ];
    expect(aggregateEffectiveDailyStudyMs(sessions, now)).toEqual({ '2026-10-07': 330 * MIN });
    expect(aggregateEffectiveDailyStudyMinutes(sessions, now)).toEqual({ '2026-10-07': 330 });
  });

  it('確認OFFのみなら 2-1 の集計と同じ結果', () => {
    const now = jst('2026-10-08T02:00:00');
    const sessions: CheckedStudySession[] = [
      session({ startAt: jst('2026-10-07T20:00:00'), checkEnabled: false }),
    ];
    expect(aggregateEffectiveDailyStudyMinutes(sessions, now)).toEqual(
      aggregateDailyStudyMinutes(sessions, now),
    );
  });

  it('セッションなしは空', () => {
    expect(aggregateEffectiveDailyStudyMinutes([], START)).toEqual({});
  });
});

describe('境界の追加ケース(レビュー追加)', () => {
  it('無応答のまま応答期限 + 1ms に停止した場合は check_timeout(確認時刻で停止)', () => {
    const stopAt = checkAt(1) + 10 * MIN + 1;
    expect(resolveSessionEnd(session({ stopAt }), stopAt)).toEqual({
      endAt: checkAt(1),
      endReason: 'check_timeout',
    });
  });

  it('確認時刻ちょうどの応答は有効(計測中)', () => {
    const now = checkAt(1) + 30 * MIN;
    expect(resolveSessionEnd(session({ confirmations: [checkAt(1)] }), now)).toEqual({
      endAt: now,
      endReason: 'running',
    });
  });

  it('now = 0:00 ちょうどに確認が出る場合(23:00開始)は未確定で、前日分は 0:00 まで(60分)', () => {
    const start = jst('2026-10-07T23:00:00');
    const midnight = jst('2026-10-08T00:00:00');
    const s = session({ startAt: start });
    expect(resolveSessionEnd(s, midnight)).toEqual({ endAt: midnight, endReason: 'running' });
    expect(aggregateEffectiveDailyStudyMinutes([s], midnight)).toEqual({ '2026-10-07': 60 });
  });

  it('23:55 の確認に応答せず 0:03 に手動停止した場合は 0:03 まで記録(前日65分・当日3分)', () => {
    const s = session({
      startAt: jst('2026-10-07T22:55:00'),
      stopAt: jst('2026-10-08T00:03:00'),
    });
    const later = jst('2026-10-08T01:00:00');
    expect(resolveSessionEnd(s, later)).toEqual({
      endAt: jst('2026-10-08T00:03:00'),
      endReason: 'manual',
    });
    expect(aggregateEffectiveDailyStudyMinutes([s], later)).toEqual({
      '2026-10-07': 65,
      '2026-10-08': 3,
    });
  });

  it('確認OFFは日をまたぐ長時間の計測でも停止せず、0:00 で分割して加算する', () => {
    const s = session({ startAt: jst('2026-10-07T20:00:00'), checkEnabled: false });
    const now = jst('2026-10-09T02:00:00');
    expect(resolveSessionEnd(s, now)).toEqual({ endAt: now, endReason: 'running' });
    expect(aggregateEffectiveDailyStudyMinutes([s], now)).toEqual({
      '2026-10-07': 240,
      '2026-10-08': 1440,
      '2026-10-09': 120,
    });
  });
});
