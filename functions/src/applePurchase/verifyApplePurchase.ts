import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { APIError, APIException, type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';

import { getWritableAccount } from '../account/accountWriteGuard';
import { FUNCTIONS_REGION } from '../config';
import { buildServerHistory } from '../dailyJudgement/serverHistory';
import { deriveAppAccountToken, isKnownAppleIapProductId } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';
import { enforceRateLimit, RateLimitExceededError } from '../rateLimit';
import { createAppleApiClient, createAppleSignedDataVerifier, type AppleEnvironmentName } from './appleClients';
import { APPLE_IAP_ISSUER_ID, APPLE_IAP_KEY_ID, APPLE_IAP_SIGNING_KEY } from './config';

/**
 * 4-2a: 購入の取引を Apple に確認し、users/{uid}.subscription を更新する(requirements 3-4)。
 *
 * 本番(Production)にまず問い合わせ、見つからない(404・TRANSACTION_ID_NOT_FOUND)場合だけ
 * テスト用(Sandbox)に問い合わせる。Apple との通信・署名検証(SignedDataVerifier)は環境ごとに固定する
 * (verifier は environment が一致しない取引を INVALID_ENVIRONMENT で拒否するため)。
 */

export type { AppleEnvironmentName } from './appleClients';

type AppleTransactionInfoLike = { signedTransactionInfo?: string };
type AppleLastTransactionLike = { originalTransactionId?: string; signedTransactionInfo?: string };
export type AppleStatusResponseLike = { data?: { lastTransactions?: AppleLastTransactionLike[] }[] };

/** テストで本物の Apple API クライアント・検証器に差し替えられるようにする依存の形 */
export interface AppleApiClientLike {
  getTransactionInfo(transactionId: string): Promise<AppleTransactionInfoLike>;
  getAllSubscriptionStatuses(originalTransactionId: string): Promise<AppleStatusResponseLike>;
}

export interface AppleTransactionVerifierLike {
  verifyAndDecodeTransaction(signedTransaction: string): Promise<JWSTransactionDecodedPayload>;
}

export type VerifyApplePurchaseDeps = {
  createApiClient: (environment: AppleEnvironmentName) => AppleApiClientLike;
  createVerifier: (environment: AppleEnvironmentName) => AppleTransactionVerifierLike;
  now: () => number;
};

/** 確認に失敗した理由(クライアントが分岐できるよう、通信エラーと不正な取引を区別する) */
export type VerifyApplePurchaseErrorReason = 'verification-unavailable' | 'invalid-transaction' | 'owned-by-other-account';

/** 秘密情報・内部の詳細を含まない、requirements 3-4 の文言に合わせたエラー */
export class VerifyApplePurchaseError extends Error {
  readonly reason: VerifyApplePurchaseErrorReason;

  constructor(reason: VerifyApplePurchaseErrorReason, message: string) {
    super(message);
    this.name = 'VerifyApplePurchaseError';
    this.reason = reason;
  }
}

const COMMUNICATION_ERROR_MESSAGE = '購入の確認ができませんでした。通信状況を確認して「購入の復元」をお試しください';
const INVALID_TRANSACTION_MESSAGE = 'この購入を確認できませんでした';
const OWNED_BY_OTHER_ACCOUNT_MESSAGE = 'この購入は別のアカウントで利用されています';

const TRANSACTION_ID_PATTERN = /^[0-9]+$/;

export type VerifyApplePurchaseResult = {
  status: 'active' | 'expired';
  expiresAt: number;
};

/** 本番の依存(実際の Apple API クライアント・検証器・現在時刻) */
export function createProductionDeps(): VerifyApplePurchaseDeps {
  return {
    createApiClient: (environment) => createAppleApiClient(environment),
    createVerifier: (environment) => createAppleSignedDataVerifier(environment),
    now: () => Date.now(),
  };
}

/** originalTransactionId の購入の持ち主を固定する(最初に確認したアカウントに固定。requirements 3-4) */
async function claimOrVerifyOwnership(originalTransactionId: string, uid: string, productId: string, environment: AppleEnvironmentName): Promise<void> {
  ensureAdminApp();
  const db = getFirestore();
  const ref = db.doc(`appleSubscriptions/${originalTransactionId}`);

  const userRef = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    await getWritableAccount(tx, userRef);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, { uid, productId, environment, createdAt: FieldValue.serverTimestamp() });
      return;
    }
    if (snap.get('uid') !== uid) {
      throw new VerifyApplePurchaseError('owned-by-other-account', OWNED_BY_OTHER_ACCOUNT_MESSAGE);
    }
  });
}

/** Production → (見つからない場合のみ)Sandbox の順に getTransactionInfo を呼ぶ */
async function fetchTransactionInfo(
  transactionId: string,
  deps: VerifyApplePurchaseDeps,
): Promise<{ environment: AppleEnvironmentName; client: AppleApiClientLike; signedTransactionInfo: string }> {
  const productionClient = deps.createApiClient('PRODUCTION');
  try {
    const response = await productionClient.getTransactionInfo(transactionId);
    if (!response.signedTransactionInfo) {
      throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
    }
    return { environment: 'PRODUCTION', client: productionClient, signedTransactionInfo: response.signedTransactionInfo };
  } catch (error) {
    if (!(error instanceof APIException && error.httpStatusCode === 404 && error.apiError === APIError.TRANSACTION_ID_NOT_FOUND)) {
      if (error instanceof VerifyApplePurchaseError) {
        throw error;
      }
      throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
    }
  }

  const sandboxClient = deps.createApiClient('SANDBOX');
  try {
    const response = await sandboxClient.getTransactionInfo(transactionId);
    if (!response.signedTransactionInfo) {
      throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
    }
    return { environment: 'SANDBOX', client: sandboxClient, signedTransactionInfo: response.signedTransactionInfo };
  } catch (error) {
    if (error instanceof VerifyApplePurchaseError) {
      throw error;
    }
    throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
  }
}

/** getAllSubscriptionStatuses から該当の originalTransactionId の最新の取引(JWS)を取り出す */
function findLatestSignedTransaction(statusResponse: AppleStatusResponseLike, originalTransactionId: string): string | null {
  for (const group of statusResponse.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      if (item.originalTransactionId === originalTransactionId && item.signedTransactionInfo) {
        return item.signedTransactionInfo;
      }
    }
  }
  return null;
}

/**
 * originalTransactionId について Apple から最新の状態(getAllSubscriptionStatuses)を取り直し、
 * 署名検証のうえで users/{uid}.subscription を更新する(requirements 3-4)。
 * 購入の確認(verifyApplePurchaseCore)・契約の変化の通知(appleServerNotification)の両方から使う共通処理。
 * 最新の状態が取れない場合は VerifyApplePurchaseError('verification-unavailable') を投げる(fail-closed)
 */
export async function fetchAndApplyLatestSubscriptionStatus(params: {
  uid: string;
  originalTransactionId: string;
  environment: AppleEnvironmentName;
  client: AppleApiClientLike;
  verifier: AppleTransactionVerifierLike;
  fallbackProductId: string;
  now: () => number;
}): Promise<VerifyApplePurchaseResult> {
  const { uid, originalTransactionId, environment, client, verifier, fallbackProductId, now } = params;

  let statusResponse: AppleStatusResponseLike;
  try {
    statusResponse = await client.getAllSubscriptionStatuses(originalTransactionId);
  } catch {
    throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
  }

  const latestSignedTransaction = findLatestSignedTransaction(statusResponse, originalTransactionId);
  if (!latestSignedTransaction) {
    // 最新の状態が取れない場合は確認できないとして扱う(fail-closed。requirements 3-4, P-025)
    throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
  }
  let latestDecoded: JWSTransactionDecodedPayload;
  try {
    latestDecoded = await verifier.verifyAndDecodeTransaction(latestSignedTransaction);
  } catch {
    throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
  }

  // 取り消された(返金等)場合は、取り消された時点で課金切れとして扱う(requirements 3-4, 2026-10-09 決定)
  const expiresAt = latestDecoded.revocationDate ?? latestDecoded.expiresDate ?? null;
  const productId = latestDecoded.productId ?? fallbackProductId;
  if (expiresAt === null || typeof productId !== 'string' || !isKnownAppleIapProductId(productId)) {
    throw new VerifyApplePurchaseError('verification-unavailable', COMMUNICATION_ERROR_MESSAGE);
  }

  const status: 'active' | 'expired' = now() < expiresAt ? 'active' : 'expired';

  ensureAdminApp();
  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await getWritableAccount(tx, userRef);
    const current = snapshot.data()!;
    const patch = { subscription: { status, productId, expiresAt, originalTransactionId, environment } };
    const history = buildServerHistory(current, patch);
    tx.update(userRef, { ...patch, ...history.counterPatch });
    for (const entry of history.entries) {
      const entryRef = userRef.collection(`judgementHistory/${entry.stream}/entries`).doc(entry.revisionId);
      tx.create(entryRef, entry.data);
    }
  });

  return { status, expiresAt };
}

/**
 * 購入の取引を確認し、users/{uid}.subscription を更新する本体のロジック(テストから直接呼べるよう、
 * onCall のラッパーと分けている)
 */
export async function verifyApplePurchaseCore(uid: string, transactionId: string, deps: VerifyApplePurchaseDeps): Promise<VerifyApplePurchaseResult> {
  const { environment, client, signedTransactionInfo } = await fetchTransactionInfo(transactionId, deps);

  const verifier = deps.createVerifier(environment);
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
  } catch {
    throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
  }

  if (!decoded.productId || !isKnownAppleIapProductId(decoded.productId)) {
    throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
  }
  if (decoded.appAccountToken !== deriveAppAccountToken(uid)) {
    throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
  }
  if (!decoded.originalTransactionId) {
    throw new VerifyApplePurchaseError('invalid-transaction', INVALID_TRANSACTION_MESSAGE);
  }
  const originalTransactionId = decoded.originalTransactionId;

  await claimOrVerifyOwnership(originalTransactionId, uid, decoded.productId, environment);

  return fetchAndApplyLatestSubscriptionStatus({
    uid,
    originalTransactionId,
    environment,
    client,
    verifier,
    fallbackProductId: decoded.productId,
    now: deps.now,
  });
}

/**
 * onCall の入口。認証・呼び出し回数の制限・入力チェックのうえで verifyApplePurchaseCore を呼び、
 * エラーを HttpsError に変換する。
 *
 * 呼び出し回数の制限(5-3b-2。requirements 3-2「大量の呼び出しへの対策」)は、request.auth.uid が
 * 確定した直後(Callable は呼び出し時点で ID トークンの検証済み)・入力チェックより前に数える
 */
export async function handleVerifyApplePurchaseRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: VerifyApplePurchaseDeps,
): Promise<VerifyApplePurchaseResult> {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }

  try {
    await enforceRateLimit(uid, 'purchase-verify', deps);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      throw new HttpsError('resource-exhausted', error.message, { reason: 'rate-limited' });
    }
    throw new HttpsError('internal', '購入の確認中にエラーが発生しました');
  }

  const data = request.data as { transactionId?: unknown } | null | undefined;
  const transactionId = data?.transactionId;
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new HttpsError('invalid-argument', 'transactionId が不正です');
  }

  try {
    return await verifyApplePurchaseCore(uid, transactionId, deps);
  } catch (error) {
    if (error instanceof VerifyApplePurchaseError) {
      const code = error.reason === 'verification-unavailable' ? 'unavailable' : 'failed-precondition';
      throw new HttpsError(code, error.message, { reason: error.reason });
    }
    throw new HttpsError('internal', '購入の確認中にエラーが発生しました');
  }
}

export const verifyApplePurchase = onCall(
  {
    region: FUNCTIONS_REGION,
    secrets: [APPLE_IAP_SIGNING_KEY, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID],
  },
  (request) => handleVerifyApplePurchaseRequest(request, createProductionDeps()),
);
