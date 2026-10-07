/**
 * セッションを目標(goalId)で絞り、不正なセッションを除外する共通処理(判定 dailyJudgement とホーム homeSummary で共有)。
 *
 * - goalId が違うセッションは正常な対象外として除き、件数を otherGoalCount で返す
 * - toValid で各セッションを検証・変換する。RangeError を投げたセッションはそのセッションだけを除外して
 *   excluded に入れる(呼び出し側でログに出す)。null を返したセッションは対象外として何もしない
 * - RangeError 以外の例外(想定外の不具合)は握りつぶさずにそのまま投げる
 *
 * index.ts からは公開しない内部モジュール(ExcludedSession は dailyJudgement から再公開する)。
 */

/** 除外した不正なセッション(RangeError になったもの) */
export type ExcludedSession = {
  /** 入力配列の位置 */
  index: number;
  id?: string;
  /** RangeError のメッセージ */
  message: string;
};

export type PartitionedSessions<T> = {
  valid: T[];
  excluded: ExcludedSession[];
  /** 他の目標のセッションとして対象外にした件数(正常) */
  otherGoalCount: number;
};

export function partitionGoalSessions<S extends { goalId: string; id?: string }, T>(
  sessions: readonly S[],
  goalId: string,
  toValid: (session: S) => T | null,
): PartitionedSessions<T> {
  return sessions.reduce<PartitionedSessions<T>>(
    (acc, session, index) => {
      if (session.goalId !== goalId) {
        return { ...acc, otherGoalCount: acc.otherGoalCount + 1 };
      }
      try {
        const valid = toValid(session);
        return valid === null ? acc : { ...acc, valid: [...acc.valid, valid] };
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        const excluded: ExcludedSession = {
          index,
          ...(session.id !== undefined ? { id: session.id } : {}),
          message: error.message,
        };
        return { ...acc, excluded: [...acc.excluded, excluded] };
      }
    },
    { valid: [], excluded: [], otherGoalCount: 0 },
  );
}
