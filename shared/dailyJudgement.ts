/**
 * 0:00 の達成判定と X 投稿要否の判定(requirements 3-3)。
 *
 * 判定する日:
 * - 判定時刻(judgedAt)の日本時間の日付の前日を判定する(0:00 に前日分を判定)
 * - 判定対象は 目標の開始日(登録日)〜試験日の前日。範囲外の日は判定しない(dailyResults を作らない)
 * - 判定日の 0:00 時点で課金切れの場合も判定しない(dailyResults を作らず、達成日数・経過日数にも数えない)
 *   課金中 = 判定日の 0:00 時点で subscription.expiresAt より前であること
 *
 * 勉強時間:
 * - その目標(goalId)で計測したセッションだけを使う(目標変更日は変更後の目標で測った分のみ)。
 *   goalId が違うセッションは正常な対象外として除き、件数を otherGoalSessionCount で返す
 * - 判定は「判定日の 0:00(日本時間)」時点の状態で行う(判定処理が 0:00 より遅れて動いても結果を変えない)
 *   - 0:00 より後に停止したセッションは 0:00 時点では計測中として扱う
 *   - 0:00 以降に開始したセッションは判定する日に関係しないため対象外
 *   - 「勉強中？」確認の応答期限が 0:00 時点で来ていないセッションも計測中とみなし、0:00 までを前日分に含める
 *     (studyCheck の resolveSessionEnd に now = 0:00 を渡した扱い)
 * - その日の勉強時間は aggregateEffectiveDailyStudyMinutes(1日の合計を分に切り捨て)の値
 *
 * 不正なセッション:
 * - 時刻が不正などで RangeError になるセッションはそのセッションだけを除外して判定を続け、
 *   除外したセッションを結果の excludedSessions に入れる(呼び出し側でログに出す)
 * - RangeError 以外の例外(想定外の不具合)は握りつぶさずにそのまま投げる
 *
 * 判定に使う値:
 * - 最低/努力目標の値・X 投稿許可・X 連携・課金状態は、呼び出し側が 0:00 の判定時点で読み取った値を渡す
 *
 * dailyResults.postStatus の初期値(requirements 5):
 * - 'none'   : 投稿不要(最低達成)
 * - 'pending': 投稿待ち(最低未達成 かつ 投稿条件をすべて満たす)
 * - 'skipped': 最低未達成だが投稿しない。理由を postSkipReasons に入れる(開始日・X投稿OFF・X未連携)
 * - 'posted' / 'failed' は投稿処理(Phase 7)が書く
 */

import { addDays, type DateKey, diffDays, isValidDateKey, jstStartOfDay, toJstDateKey } from './date';
import {
  aggregateEffectiveDailyStudyMinutes,
  type CheckedStudySession,
  resolveSessionEnd,
} from './studyCheck';
import { type ExcludedSession, partitionGoalSessions } from './sessionFilter';

/** dailyResults.postStatus */
export type PostStatus = 'none' | 'pending' | 'posted' | 'failed' | 'skipped';

/** 判定に使う目標の値(users/{uid}/goals/{goalId} の該当項目。0:00 の判定時点の値) */
export type JudgementGoal = {
  /** 目標の開始日(登録日) */
  startDate: DateKey;
  /** 試験日 */
  examDate: DateKey;
  /** 1日の最低勉強時間(分) */
  minDailyMinutes: number;
  /** 1日の努力目標勉強時間(分) */
  goalDailyMinutes: number;
};

/** 課金状態(users/{uid}.subscription の該当項目)。expiresAt は epoch ミリ秒 */
export type JudgementSubscription = { expiresAt: number | null };

/** 判定に使うユーザー設定(users/{uid} の該当項目。0:00 の判定時点の値) */
export type JudgementUser = {
  xPostEnabled: boolean;
  xLinked: boolean;
  /** 未購入などで課金状態がない場合は null */
  subscription: JudgementSubscription | null;
};

/** 判定に渡すセッション(users/{uid}/sessions)。id はログ用(Firestore のドキュメント ID) */
export type JudgementSession = CheckedStudySession & { goalId: string; id?: string };

export type DailyJudgementInput = {
  goalId: string;
  goal: JudgementGoal;
  user: JudgementUser;
  /** 判定する日に関係するセッション。範囲外・他の目標のものが含まれていてもよい */
  sessions: readonly JudgementSession[];
  /** 判定時刻(epoch ミリ秒)。この時刻の日本時間の日付の前日を判定する */
  judgedAt: number;
};

/** 最低未達成だが投稿しない理由(dailyResults.postSkipReasons) */
export type PostSkipReason =
  | 'start_date' // 目標の開始日(登録日。目標変更日を含む)
  | 'x_post_disabled' // X 投稿許可 OFF
  | 'x_not_linked'; // X 未連携

/** dailyResults/{date} に書く内容 */
export type DailyResultDraft = {
  goalId: string;
  studiedMinutes: number;
  metMin: boolean;
  metGoal: boolean;
  postStatus: PostStatus;
  /** postStatus が 'skipped' のときだけ理由が入る(該当するものをすべて、上の型の定義順で)。それ以外は空 */
  postSkipReasons: readonly PostSkipReason[];
};

/** 除外した不正なセッション(RangeError になったもの)。定義は sessionFilter(判定とホームで共有) */
export type { ExcludedSession };

/** 判定しない理由 */
export type NotJudgedReason =
  | 'before_start_date' // 判定する日が目標の開始日より前
  | 'exam_date_reached' // 判定する日が試験日当日以降
  | 'subscription_inactive'; // 判定日の 0:00 時点で課金切れ(有効期限切れ・課金状態なし)

export type DailyJudgement =
  | { judged: false; date: DateKey; reason: NotJudgedReason }
  | {
      judged: true;
      date: DateKey;
      result: DailyResultDraft;
      /** 不正データとして除外したセッション(呼び出し側でログに出す) */
      excludedSessions: readonly ExcludedSession[];
      /** 他の目標のセッションとして対象外にした件数(正常) */
      otherGoalSessionCount: number;
    };

function assertMinutes(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} は 0 以上の整数(分)である必要があります: ${value}`);
  }
}

function assertGoal(goal: JudgementGoal): void {
  if (!isValidDateKey(goal.startDate) || !isValidDateKey(goal.examDate)) {
    throw new RangeError(
      `startDate / examDate は実在する 'YYYY-MM-DD' である必要があります: ${goal.startDate} / ${goal.examDate}`,
    );
  }
  assertMinutes(goal.minDailyMinutes, 'minDailyMinutes');
  assertMinutes(goal.goalDailyMinutes, 'goalDailyMinutes');
}

/** その時刻に課金中か(有効期限より前か)。expiresAt が数値でない不正値は RangeError */
export function isSubscriptionActiveAt(
  subscription: JudgementSubscription | null,
  at: number,
): boolean {
  if (subscription === null || subscription.expiresAt === null) {
    return false;
  }
  if (!Number.isFinite(subscription.expiresAt)) {
    throw new RangeError(
      `subscription.expiresAt は有限の数値(epoch ミリ秒)である必要があります: ${subscription.expiresAt}`,
    );
  }
  return at < subscription.expiresAt;
}

/**
 * セッションを判定の基準時刻(0:00)時点の状態にする。
 * - 基準時刻以降に開始したものは null(判定する日に関係しない)
 * - 基準時刻より後に停止したものは計測中(stopAt = null)にする
 * 不正なセッションは RangeError。
 */
function snapshotSession(
  session: JudgementSession,
  cutoff: number,
): CheckedStudySession | null {
  if (Number.isFinite(session.startAt) && session.startAt >= cutoff) {
    return null;
  }
  // 入力チェック(不正なら RangeError)。基準時刻での終了の扱いは集計側で同じ now を使って求める
  resolveSessionEnd(session, cutoff);
  const stoppedBeforeCutoff = session.stopAt !== null && session.stopAt <= cutoff;
  return {
    startAt: session.startAt,
    stopAt: stoppedBeforeCutoff ? session.stopAt : null,
    checkEnabled: session.checkEnabled,
    confirmations: session.confirmations,
  };
}

function decidePost(
  metMin: boolean,
  isStartDate: boolean,
  user: JudgementUser,
): Pick<DailyResultDraft, 'postStatus' | 'postSkipReasons'> {
  if (metMin) {
    return { postStatus: 'none', postSkipReasons: [] };
  }
  const reasons: PostSkipReason[] = [
    ...(isStartDate ? (['start_date'] as const) : []),
    ...(!user.xPostEnabled ? (['x_post_disabled'] as const) : []),
    ...(!user.xLinked ? (['x_not_linked'] as const) : []),
  ];
  return reasons.length === 0
    ? { postStatus: 'pending', postSkipReasons: [] }
    : { postStatus: 'skipped', postSkipReasons: reasons };
}

/**
 * 判定時刻の前日分の達成判定と投稿要否を求める。
 * 判定しない日(開始日より前・試験日当日以降・課金切れ)は judged: false を返す。
 * 目標・課金状態・判定時刻が不正な場合は RangeError(セッションの不正は除外して続行)。
 */
export function judgeDailyResult(input: DailyJudgementInput): DailyJudgement {
  const { goalId, goal, user, sessions, judgedAt } = input;
  if (!Number.isFinite(judgedAt)) {
    throw new RangeError(`judgedAt は有限の数値(epoch ミリ秒)である必要があります: ${judgedAt}`);
  }
  assertGoal(goal);
  const judgeDate = toJstDateKey(judgedAt);
  const date = addDays(judgeDate, -1);
  if (diffDays(goal.startDate, date) < 0) {
    return { judged: false, date, reason: 'before_start_date' };
  }
  if (diffDays(goal.examDate, date) >= 0) {
    return { judged: false, date, reason: 'exam_date_reached' };
  }
  const cutoff = jstStartOfDay(judgeDate);
  if (!isSubscriptionActiveAt(user.subscription, cutoff)) {
    return { judged: false, date, reason: 'subscription_inactive' };
  }

  const { valid, excluded, otherGoalCount } = partitionGoalSessions(sessions, goalId, (session) =>
    snapshotSession(session, cutoff),
  );
  const studiedMinutes = aggregateEffectiveDailyStudyMinutes(valid, cutoff)[date] ?? 0;
  const metMin = studiedMinutes >= goal.minDailyMinutes;
  const metGoal = studiedMinutes >= goal.goalDailyMinutes;

  return {
    judged: true,
    date,
    result: {
      goalId,
      studiedMinutes,
      metMin,
      metGoal,
      ...decidePost(metMin, date === goal.startDate, user),
    },
    excludedSessions: excluded,
    otherGoalSessionCount: otherGoalCount,
  };
}
