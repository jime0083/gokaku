import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from '../config';
import { enforceRateLimit, RateLimitExceededError } from '../rateLimit';
import {
  createProductionRecordStudySessionEventDeps,
  RECORD_STUDY_EVENT_ACTIONS,
  RECORD_STUDY_EVENT_SOURCES,
  recordStudySessionEvent,
  RecordStudySessionEventError,
  type RecordStudySessionEventDeps,
  type RecordStudySessionEventInput,
  type RecordStudySessionEventResult,
} from './recordStudySessionEvent';

/**
 * 5-1b-1・5-2a: アプリ内タイマーの開始・停止・「勉強中？」確認への応答を受け取る Callable
 * (requirements 3-2「アプリからの記録の保存」)。
 * 時刻の補正・idempotencyKey による二重記録の防止・保存は recordStudySessionEvent(共通処理)が行う。
 *
 * uid はクライアントから受け取らず、必ず request.auth.uid(Firebase Auth で検証済みの ID トークン)を使う。
 */

// Firestore のドキュメントID(sessionId・idempotencyKey・goalId)として安全な形式に限定する
// (パスの区切り('/')・相対パス('.'・'..')・制御文字などを拒否する)
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidAction(value: unknown): value is RecordStudySessionEventInput['action'] {
  return typeof value === 'string' && (RECORD_STUDY_EVENT_ACTIONS as readonly string[]).includes(value);
}

function isValidSource(value: unknown): value is RecordStudySessionEventInput['source'] {
  return typeof value === 'string' && (RECORD_STUDY_EVENT_SOURCES as readonly string[]).includes(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

/** 入力を検査し、妥当なら RecordStudySessionEventInput を返す(不正なら null) */
function parseInput(data: unknown): RecordStudySessionEventInput | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (!isSafeId(d.sessionId) || !isSafeId(d.goalId) || !isSafeId(d.idempotencyKey)) {
    return null;
  }
  if (!isValidAction(d.action) || !isValidSource(d.source)) {
    return null;
  }
  if (typeof d.clientTimeMs !== 'number' || !Number.isFinite(d.clientTimeMs)) {
    return null;
  }
  // checkEnabled(5-2a)は action が 'start' のときだけ必須。他の action では送られてきても無視する
  if (d.action === 'start' && typeof d.checkEnabled !== 'boolean') {
    return null;
  }
  return {
    sessionId: d.sessionId,
    goalId: d.goalId,
    idempotencyKey: d.idempotencyKey,
    action: d.action,
    source: d.source,
    clientTimeMs: d.clientTimeMs,
    checkEnabled: d.action === 'start' ? (d.checkEnabled as boolean) : undefined,
  };
}

/**
 * onCall の入口。認証・呼び出し回数の制限・入力チェックのうえで recordStudySessionEvent を呼び、
 * エラーを HttpsError に変換する。
 *
 * 呼び出し回数の制限(5-3b-2。requirements 3-2「大量の呼び出しへの対策」)は、request.auth.uid が
 * 確定した直後(Callable は呼び出し時点で ID トークンの検証済み)・入力チェックより前に数える。
 * nativeSync(ロック画面からの同じ「計測の記録」)と同じ枠(kind='study-event')を共有する
 */
export async function handleRecordStudyEventRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: RecordStudySessionEventDeps,
): Promise<RecordStudySessionEventResult> {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }

  try {
    await enforceRateLimit(uid, 'study-event', deps);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      throw new HttpsError('resource-exhausted', error.message, { reason: 'rate-limited' });
    }
    throw new HttpsError('internal', '記録の処理中にエラーが発生しました');
  }

  const input = parseInput(request.data);
  if (!input) {
    throw new HttpsError('invalid-argument', '入力が不正です');
  }

  try {
    return await recordStudySessionEvent(uid, input, deps);
  } catch (error) {
    if (error instanceof RecordStudySessionEventError) {
      const code = error.reason === 'confirmation-limit-exceeded' ? 'resource-exhausted' : 'invalid-argument';
      throw new HttpsError(code, error.message, { reason: error.reason });
    }
    throw new HttpsError('internal', '記録の処理中にエラーが発生しました');
  }
}

export const recordStudyEvent = onCall(
  { region: FUNCTIONS_REGION },
  (request) => handleRecordStudyEventRequest(request, createProductionRecordStudySessionEventDeps()),
);
