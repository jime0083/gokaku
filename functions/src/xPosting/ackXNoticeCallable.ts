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
import { acknowledgeXNotice, type AckXNoticeResult } from './xNoticeStore';

export type AckXNoticeDeps = {
  enforceRateLimit: (uid: string) => Promise<void>;
  ackXNotice: (uid: string, noticeId: string) => Promise<AckXNoticeResult>;
};

const MAX_UID_LENGTH = 128;
const ERROR_MESSAGES = {
  unauthenticated: 'ログインが必要です',
  invalidArgument: '入力が不正です',
  failedPrecondition: 'お知らせを既読にできません',
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

/** 単一のown data propertyだけを受け取る。getter・hidden・symbol・独自prototypeは拒否する。 */
function readSingleField(input: unknown, key: string): unknown {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 1 || keys[0] !== key) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function publicError(error: unknown): HttpsError {
  if (error instanceof RateLimitExceededError) {
    return new HttpsError('resource-exhausted', ERROR_MESSAGES.rateLimited, { reason: 'rate-limited' });
  }
  if (error instanceof AccountWriteBlockedError) {
    return new HttpsError('failed-precondition', ERROR_MESSAGES.failedPrecondition);
  }
  return new HttpsError('internal', ERROR_MESSAGES.internal);
}

/** factory生成時にはSDK接続・Firestore読み取り・親作成を行わない。 */
export function createProductionAckXNoticeDeps(
  rateLimitDeps: RateLimitDeps = createProductionRateLimitDeps(),
  now: () => number = () => Date.now(),
): AckXNoticeDeps {
  return {
    enforceRateLimit: (uid) => enforceRateLimit(uid, 'x-notice-ack', rateLimitDeps),
    ackXNotice: (uid, noticeId) => {
      ensureAdminApp();
      return acknowledgeXNotice(getFirestore(), uid, noticeId, now);
    },
  };
}

export async function handleAckXNoticeRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: AckXNoticeDeps,
): Promise<AckXNoticeResult> {
  const uid = request.auth?.uid;
  if (!isValidUid(uid)) {
    throw new HttpsError('unauthenticated', ERROR_MESSAGES.unauthenticated);
  }

  // 不正payloadも専用枠で数える。認証直後・入力検査より前に適用する。
  try {
    await deps.enforceRateLimit(uid);
  } catch (error) {
    throw publicError(error);
  }

  const noticeId = readSingleField(request.data, 'noticeId');
  if (typeof noticeId !== 'string' || noticeId.length !== 64 || !/^[0-9a-f]{64}$/.test(noticeId)) {
    throw new HttpsError('invalid-argument', ERROR_MESSAGES.invalidArgument);
  }

  try {
    const result: unknown = await deps.ackXNotice(uid, noticeId);
    const status = readSingleField(result, 'status');
    if (status !== 'acknowledged' && status !== 'unchanged') throw new Error();
    return { status };
  } catch (error) {
    // 不正保存値・SDK例外・依存先の任意message/detailsを公開しない。
    throw publicError(error);
  }
}

export const ackXNotice = onCall({ region: FUNCTIONS_REGION }, (request) =>
  handleAckXNoticeRequest(request, createProductionAckXNoticeDeps()),
);
