import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { AccountWriteBlockedError } from '../account/accountWriteGuard';
import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import {
  createProductionRateLimitDeps,
  enforceRateLimit,
  RateLimitExceededError,
  type RateLimitDeps,
} from '../rateLimit';
import {
  initializeHistory,
  InitializeHistoryError,
  type InitializeHistoryResult,
} from './initializeHistory';

export type InitializeJudgementHistoryDeps = {
  enforceRateLimit: (uid: string) => Promise<void>;
  initializeHistory: (uid: string) => Promise<InitializeHistoryResult>;
};

const MAX_UID_LENGTH = 128;
const ERROR_MESSAGES = {
  unauthenticated: 'ログインが必要です',
  invalidArgument: '入力が不正です',
  failedPrecondition: '履歴を初期化できません',
  internal: '処理を完了できませんでした。再度お試しください',
  rateLimited: '呼び出し回数の上限に達しました。しばらく待ってから再度お試しください',
} as const;

function isValidUid(uid: unknown): uid is string {
  return typeof uid === 'string'
    && uid.length > 0 && uid.length <= MAX_UID_LENGTH
    && uid.trim().length > 0
    && !uid.includes('/') && uid !== '.' && uid !== '..'
    && !/^__.*__$/.test(uid)
    && !/[\u0000-\u001f\u007f]/.test(uid)
    && Buffer.from(uid, 'utf8').toString('utf8') === uid;
}

/** 入力値は一切受け取らない。hidden/symbol/getterや独自prototypeも拒否する。 */
function isEmptyPayload(data: unknown): boolean {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const prototype: unknown = Object.getPrototypeOf(data);
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(data).length === 0;
  } catch {
    return false;
  }
}

/** SDK例外・raw document・UID・元のmessage/detailsを公開しない。 */
function publicError(error: unknown): HttpsError {
  if (error instanceof RateLimitExceededError) {
    return new HttpsError('resource-exhausted', ERROR_MESSAGES.rateLimited, { reason: 'rate-limited' });
  }
  if (error instanceof AccountWriteBlockedError || error instanceof InitializeHistoryError) {
    return new HttpsError('failed-precondition', ERROR_MESSAGES.failedPrecondition);
  }
  return new HttpsError('internal', ERROR_MESSAGES.internal);
}

/** 初期化は既存コアに委譲。factory生成時にはSDK接続やuser作成を行わない。 */
export function createProductionInitializeJudgementHistoryDeps(
  rateLimitDeps: RateLimitDeps = createProductionRateLimitDeps(),
): InitializeJudgementHistoryDeps {
  return {
    enforceRateLimit: (uid) => enforceRateLimit(uid, 'history-initialize', rateLimitDeps),
    initializeHistory: (uid) => {
      ensureAdminApp();
      return initializeHistory(getFirestore(), uid);
    },
  };
}

export async function handleInitializeJudgementHistoryRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: InitializeJudgementHistoryDeps,
): Promise<InitializeHistoryResult> {
  const uid = request.auth?.uid;
  if (!isValidUid(uid)) {
    throw new HttpsError('unauthenticated', ERROR_MESSAGES.unauthenticated);
  }

  // 不正payloadによる反復も数える。既存の制限と同じく、認証直後・入力検査前。
  try {
    await deps.enforceRateLimit(uid);
  } catch (error) {
    throw publicError(error);
  }
  if (!isEmptyPayload(request.data)) {
    throw new HttpsError('invalid-argument', ERROR_MESSAGES.invalidArgument);
  }

  try {
    // コアが同じ初期化transaction内で親missing/deletingも再検査する。
    const result = await deps.initializeHistory(uid);
    if (result.status !== 'initialized' && result.status !== 'alreadyInitialized') {
      throw new Error();
    }
    return { status: result.status };
  } catch (error) {
    throw publicError(error);
  }
}

export const initializeJudgementHistory = onCall({ region: FUNCTIONS_REGION }, (request) =>
  handleInitializeJudgementHistoryRequest(request, createProductionInitializeJudgementHistoryDeps()),
);
