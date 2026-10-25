import {
  DocumentReference,
  Timestamp,
  type Firestore,
} from 'firebase-admin/firestore';

import {
  judgeDailyResult,
  type JudgementSession,
  type NotJudgedReason,
} from '../../../shared/dailyJudgement';
import { isValidDateKey, jstStartOfNextDay } from '../../../shared/date';
import {
  readJudgementHistory,
  type JudgementHistoryReadResult,
} from './historyReader';

/** raw保存値・例外メッセージは返さず、診断に必要なIDと定型理由だけを返す。 */
export type JudgementSessionDiagnostic = {
  id: string;
  reason: 'invalid_session_shape' | 'invalid_session_time';
};

export type JudgeUserDayResult =
  | { status: 'created'; excludedSessions: readonly JudgementSessionDiagnostic[] }
  | { status: 'already' }
  | Exclude<JudgementHistoryReadResult, { status: 'available' }>
  | { status: 'skipped'; reason: NotJudgedReason };

type DecodedSession = JudgementSession & { id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * writerの正常省略だけを変換する。時刻の意味的な整合性はsharedで検証する。
 * 欠落した必須値や不正型は補完しない。想定外の例外は捕捉しない。
 */
function decodeSession(id: string, value: unknown): DecodedSession | null {
  if (
    !isRecord(value)
    || typeof value.goalId !== 'string'
    || value.goalId.length === 0
    || !isFiniteTime(value.startAt)
    || typeof value.checkEnabled !== 'boolean'
  ) {
    return null;
  }

  const stopAt = hasOwn(value, 'stopAt') ? value.stopAt : null;
  if (stopAt !== null && !isFiniteTime(stopAt)) return null;

  const confirmations = hasOwn(value, 'confirmations') ? value.confirmations : [];
  if (!Array.isArray(confirmations)) return null;
  // for..of also rejects an undefined element in a sparse array.
  for (const at of confirmations) {
    if (!isFiniteTime(at)) return null;
  }
  return {
    id,
    goalId: value.goalId,
    startAt: value.startAt,
    stopAt,
    checkEnabled: value.checkEnabled,
    confirmations,
  };
}

/** UIDを文書パスへ展開する前に検証し、不正入力をSDKへ渡さない。 */
function requireUid(uid: string): void {
  if (
    typeof uid !== 'string'
    || uid.trim().length === 0
    || uid.length > 128
    || uid.includes('/')
    || uid === '.'
    || uid === '..'
    || /^__.*__$/.test(uid)
    || Buffer.from(uid, 'utf8').toString('utf8') !== uid
  ) {
    throw new RangeError('Invalid judgement UID');
  }
}

/**
 * 1人1日分を同一Admin read-write transactionで確定する内部コア。
 * 呼出側が認証済みUID/対象日/dbを渡す。現在時刻・公開入口・再試行ループは持たない。
 * Firestoreの直列化保証により、writerの既存結果読取/セッション保存と整合させる。
 * 診断はcommitに成功したtransactionの戻り値だけに含め、callback内ではログを出さない。
 */
export async function judgeUserDay(
  uid: string,
  targetDateKey: string,
  deps: { db: Firestore },
): Promise<JudgeUserDayResult> {
  requireUid(uid);
  if (typeof targetDateKey !== 'string' || !isValidDateKey(targetDateKey)) {
    throw new RangeError('Invalid judgement date');
  }
  // transaction retryでも同じ日・同じcutoffを使う。
  const judgedAt = jstStartOfNextDay(targetDateKey);
  const cutoff = Timestamp.fromMillis(judgedAt);
  const { db } = deps;
  const userPath = `users/${uid}`;
  const userRef = db.doc(userPath);
  if (!(userRef instanceof DocumentReference) || userRef.path !== userPath) {
    throw new RangeError('Invalid judgement user reference');
  }
  const resultRef = userRef.collection('dailyResults').doc(targetDateKey);

  return db.runTransaction<JudgeUserDayResult>(async (tx) => {
    const existing = await tx.get(resultRef);
    // 確定済みは現在の履歴やセッションにかかわらず変更しない。
    if (existing.exists) return { status: 'already' };

    const restored = await readJudgementHistory(tx, userRef, cutoff);
    if (restored.status !== 'available') return restored;
    const input = {
      goalId: restored.goalId,
      goal: restored.goal,
      user: restored.user,
      judgedAt,
    };
    // 判定対象外をsharedで先に分類し、不要なsessions取得を省く。
    const eligibility = judgeDailyResult({ ...input, sessions: [] });
    if (!eligibility.judged) return { status: 'skipped', reason: eligibility.reason };

    // OFFの計測は無制限に跨日できるため、開始時刻の窓やlimitを設けない。
    const storedSessions = await tx.get(
      userRef.collection('sessions').where('goalId', '==', restored.goalId),
    );
    const sessions: DecodedSession[] = [];
    const excludedSessions: JudgementSessionDiagnostic[] = [];
    for (const doc of storedSessions.docs) {
      const decoded = decodeSession(doc.id, doc.data());
      if (decoded === null) {
        excludedSessions.push({ id: doc.id, reason: 'invalid_session_shape' });
      } else {
        sessions.push(decoded);
      }
    }

    const judgement = judgeDailyResult({ ...input, sessions });
    if (!judgement.judged) return { status: 'skipped', reason: judgement.reason };
    for (const excluded of judgement.excludedSessions) {
      // sharedのRangeErrorメッセージには保存値が含まれ得るため外へ出さない。
      excludedSessions.push({
        id: sessions[excluded.index].id,
        reason: 'invalid_session_time',
      });
    }
    // 全read完了後の唯一のwrite。既存文書をupdate/setで上書きしない。
    tx.create(resultRef, judgement.result);
    return { status: 'created', excludedSessions };
  });
}
