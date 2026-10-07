/**
 * 「勉強中？」確認による計測の自動停止(requirements 3-2)。
 *
 * 仕様:
 * - 確認ON: 計測開始から STUDY_CHECK_INTERVAL_MS ごとに確認を出す(k 回目 = 開始 + k × 間隔、k ≥ 1)。
 *   確認から STUDY_CHECK_RESPONSE_WINDOW_MS 以内に応答がなければ、その確認を出した時刻で計測を停止する
 *   (無応答の時間は加算しない)
 * - 確認OFF: 確認なし・上限なし
 *
 * 応答の対応づけ:
 * - 確認時刻 t_k に対し、t_k ≤ 応答時刻 ≤ t_k + 応答期限 の応答を「t_k への応答」とみなす(両端を含む)
 * - どの確認の範囲にも入らない応答(確認前・期限後・開始前など)は無視する
 *   (間隔 > 応答期限 のため、1つの応答が2つの確認に対応することはない)
 *
 * 無応答の確定:
 * - 応答期限(t_k + 応答期限)を「過ぎた」時点で無応答が確定する(期限ちょうどの応答は有効)
 * - 停止済み: 停止時刻が応答期限より後なら無応答が確定し、check_timeout(停止時刻 = t_k)が手動停止より優先する。
 *   応答期限より前(期限ちょうどを含む)に手動停止した場合は、自動停止は起きていないので manual
 * - 計測中: now が応答期限を過ぎていない確認は未確定とし、停止扱いにしない(now まで計測中)
 *
 * 0:00 判定(now = 0:00)で応答期限が 0:00 以降の確認(例: 23:55 の確認、期限 0:05)は未確定のため、
 * 0:00 時点では計測中として扱い、前日分は 0:00 まで加算する(requirements 3-3「0:00 時点で計測中の
 * セッションは 0:00 までの分を前日分として判定に含める」)。後で無応答が確定した場合、再計算すると停止時刻は
 * 確認時刻(23:55)になるが、0:00 判定の結果は確定済みとして変えない。
 */

import {
  aggregateDailyStudyMinutes,
  aggregateDailyStudyMs,
  type DailyTotals,
  MS_PER_MINUTE,
  type StudySession,
} from './studyTime';

/** 「勉強中？」確認の間隔(計測開始から60分ごと) */
export const STUDY_CHECK_INTERVAL_MS = 60 * MS_PER_MINUTE;

/** 「勉強中？」確認の応答期限(確認から10分以内) */
export const STUDY_CHECK_RESPONSE_WINDOW_MS = 10 * MS_PER_MINUTE;

/** 確認設定と応答時刻を持つ計測セッション(Firestore の sessions に対応) */
export type CheckedStudySession = StudySession & {
  /** 計測開始時点の「勉強中？」確認の ON/OFF */
  checkEnabled: boolean;
  /** 「勉強中」と応答した時刻(epoch ミリ秒)の配列。順不同 */
  confirmations: readonly number[];
};

/** 終了理由。running は now 時点で計測中(終了時刻は now) */
export type SessionEndReason = 'manual' | 'check_timeout' | 'running';

/** 実効的な終了時刻と終了理由 */
export type SessionEnd = { endAt: number; endReason: SessionEndReason };

function assertFiniteTime(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} は有限の数値(epoch ミリ秒)である必要があります: ${value}`);
  }
}

function assertSession(session: CheckedStudySession, now: number): void {
  assertFiniteTime(session.startAt, 'startAt');
  assertFiniteTime(now, 'now');
  if (session.stopAt !== null) {
    assertFiniteTime(session.stopAt, 'stopAt');
    if (session.stopAt < session.startAt) {
      throw new RangeError(`停止時刻が開始時刻より前です: ${session.startAt}〜${session.stopAt}`);
    }
  } else if (now < session.startAt) {
    throw new RangeError(
      `計測中のセッションで now が開始時刻より前です: ${session.startAt}〜${now}`,
    );
  }
  session.confirmations.forEach((at) => assertFiniteTime(at, 'confirmations の要素'));
}

/**
 * 確認による自動停止を反映した、実効的な終了時刻と終了理由を求める。
 * - 停止済みで、停止時刻より前に無応答が確定した確認があれば、最初のその確認時刻で check_timeout
 * - それ以外の停止済みは停止時刻で manual
 * - 計測中で無応答が確定した確認がなければ now で running
 */
export function resolveSessionEnd(session: CheckedStudySession, now: number): SessionEnd {
  assertSession(session, now);
  const { startAt, stopAt, checkEnabled, confirmations } = session;
  const fallback: SessionEnd =
    stopAt === null ? { endAt: now, endReason: 'running' } : { endAt: stopAt, endReason: 'manual' };
  if (!checkEnabled) {
    return fallback;
  }
  // 無応答が確定する境界: 停止済みは停止時刻、計測中は now。この時刻より前に期限を過ぎた確認だけを判定する
  const decidedUntil = stopAt ?? now;
  for (
    let checkAt = startAt + STUDY_CHECK_INTERVAL_MS;
    checkAt < decidedUntil;
    checkAt += STUDY_CHECK_INTERVAL_MS
  ) {
    const deadline = checkAt + STUDY_CHECK_RESPONSE_WINDOW_MS;
    const answered = confirmations.some((at) => at >= checkAt && at <= deadline);
    if (answered) {
      continue;
    }
    if (deadline < decidedUntil) {
      return { endAt: checkAt, endReason: 'check_timeout' };
    }
    // 応答期限前に停止した、または now が応答期限を過ぎていない(未確定)。以降の確認は出ていない
    break;
  }
  return fallback;
}

/**
 * 確認による自動停止を反映したセッション(2-1 の集計関数にそのまま渡せる形)。
 * 計測中(running)は stopAt を null のまま返す。入力は変更しない。
 */
export function toEffectiveSession(session: CheckedStudySession, now: number): StudySession {
  const { endAt, endReason } = resolveSessionEnd(session, now);
  return { startAt: session.startAt, stopAt: endReason === 'running' ? null : endAt };
}

/** 複数セッション → 確認による自動停止を反映した日付キーごとの勉強時間(ミリ秒) */
export function aggregateEffectiveDailyStudyMs(
  sessions: readonly CheckedStudySession[],
  now: number,
): DailyTotals {
  return aggregateDailyStudyMs(
    sessions.map((session) => toEffectiveSession(session, now)),
    now,
  );
}

/**
 * 複数セッション → 確認による自動停止を反映した日付キーごとの勉強時間(分・整数)。
 * 日割り・重なりの扱い・分への切り捨ては aggregateDailyStudyMinutes(requirements 3-1)と同じ。
 */
export function aggregateEffectiveDailyStudyMinutes(
  sessions: readonly CheckedStudySession[],
  now: number,
): DailyTotals {
  return aggregateDailyStudyMinutes(
    sessions.map((session) => toEffectiveSession(session, now)),
    now,
  );
}
