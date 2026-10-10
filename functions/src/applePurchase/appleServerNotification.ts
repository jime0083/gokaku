import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import { NotificationTypeV2, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { createAppleApiClient, createAppleSignedDataVerifier, type AppleEnvironmentName } from './appleClients';
import { APPLE_IAP_ISSUER_ID, APPLE_IAP_KEY_ID, APPLE_IAP_SIGNING_KEY } from './config';
import {
  fetchAndApplyLatestSubscriptionStatus,
  VerifyApplePurchaseError,
  type AppleApiClientLike,
  type AppleTransactionVerifierLike,
} from './verifyApplePurchase';

/**
 * 4-2b: App Store Server Notifications V2 を受け取り、users/{uid}.subscription を最新化する(requirements 3-4)。
 *
 * 通知の種類(更新・解約・期限切れ・取り消し等)ごとに内容を組み立てず、通知の signedTransactionInfo から
 * originalTransactionId を取り出し(署名検証のうえ)、4-2a と同じ fetchAndApplyLatestSubscriptionStatus で
 * Apple から最新の状態を取り直す。通知が前後して届いても、常に最新の状態になる
 */

export interface AppleNotificationVerifierLike extends AppleTransactionVerifierLike {
  verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
}

export type AppleServerNotificationDeps = {
  createApiClient: (environment: AppleEnvironmentName) => AppleApiClientLike;
  createVerifier: (environment: AppleEnvironmentName) => AppleNotificationVerifierLike;
  now: () => number;
};

/** 本番の依存(実際の Apple API クライアント・検証器・現在時刻。鍵・appAppleId は 4-2a と共通) */
export function createProductionNotificationDeps(): AppleServerNotificationDeps {
  return {
    createApiClient: (environment) => createAppleApiClient(environment),
    createVerifier: (environment) => createAppleSignedDataVerifier(environment),
    now: () => Date.now(),
  };
}

export type AppleServerNotificationOutcome = 'ok' | 'test' | 'no-owner' | 'invalid' | 'unavailable';
export type AppleServerNotificationResult = { outcome: AppleServerNotificationOutcome };

function isValidNotificationBody(body: unknown): body is { signedPayload: string } {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const signedPayload = (body as Record<string, unknown>).signedPayload;
  return typeof signedPayload === 'string' && signedPayload.length > 0;
}

/**
 * JWT(署名検証前)の payload 部分だけを読み、どちらの環境(Production/Sandbox)の通知かを判定する
 * ために使う。署名検証の前に読んだこの値は「どの検証器(createVerifier)を選ぶか」の判断にのみ使う。
 * 検証器は environment が一致しない取引を INVALID_ENVIRONMENT で拒否するため(verifyApplePurchase.ts
 * と同じ仕組み)、verifyAndDecodeNotification の検証を通った後は、この値をそのまま検証済みの環境として
 * 扱ってよい(以降の Apple API 呼び出し・検証器の選択にも同じ値を使っている)
 */
function peekUnverifiedEnvironment(signedPayload: string): AppleEnvironmentName | null {
  const parts = signedPayload.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const data = (parsed as Record<string, unknown>).data;
    if (typeof data !== 'object' || data === null) {
      return null;
    }
    const environment = (data as Record<string, unknown>).environment;
    if (environment === 'Production') {
      return 'PRODUCTION';
    }
    if (environment === 'Sandbox') {
      return 'SANDBOX';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 通知の本体ロジック(テストから直接呼べるよう、onRequest のラッパーと分けている)。
 * 何も保存しない場合(不正・持ち主なし・TEST)と、保存した場合の両方を outcome で返す
 */
export async function handleAppleServerNotification(body: unknown, deps: AppleServerNotificationDeps): Promise<AppleServerNotificationResult> {
  if (!isValidNotificationBody(body)) {
    return { outcome: 'invalid' };
  }
  const { signedPayload } = body;

  const environment = peekUnverifiedEnvironment(signedPayload);
  if (!environment) {
    return { outcome: 'invalid' };
  }

  const verifier = deps.createVerifier(environment);
  let decoded: ResponseBodyV2DecodedPayload;
  try {
    decoded = await verifier.verifyAndDecodeNotification(signedPayload);
  } catch {
    return { outcome: 'invalid' };
  }

  if (decoded.notificationType === NotificationTypeV2.TEST) {
    return { outcome: 'test' };
  }

  const signedTransactionInfo = decoded.data?.signedTransactionInfo;
  if (typeof signedTransactionInfo !== 'string') {
    return { outcome: 'invalid' };
  }

  let decodedTransaction: JWSTransactionDecodedPayload;
  try {
    decodedTransaction = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
  } catch {
    return { outcome: 'invalid' };
  }

  const originalTransactionId = decodedTransaction.originalTransactionId;
  if (typeof originalTransactionId !== 'string' || originalTransactionId.length === 0) {
    return { outcome: 'invalid' };
  }

  ensureAdminApp();
  const ownerSnap = await getFirestore().doc(`appleSubscriptions/${originalTransactionId}`).get();
  if (!ownerSnap.exists) {
    // 持ち主(appleSubscriptions)が登録されていない購入の通知は、何も保存せず受け取りだけ返す(requirements 3-4)
    return { outcome: 'no-owner' };
  }
  const uid = ownerSnap.get('uid') as string | undefined;
  if (typeof uid !== 'string' || uid.length === 0) {
    return { outcome: 'no-owner' };
  }

  const client = deps.createApiClient(environment);
  try {
    await fetchAndApplyLatestSubscriptionStatus({
      uid,
      originalTransactionId,
      environment,
      client,
      verifier,
      fallbackProductId: decodedTransaction.productId ?? '',
      now: deps.now,
    });
  } catch (error) {
    if (error instanceof VerifyApplePurchaseError) {
      return { outcome: 'unavailable' };
    }
    throw error;
  }

  return { outcome: 'ok' };
}

export const appleServerNotification = onRequest(
  {
    region: FUNCTIONS_REGION,
    secrets: [APPLE_IAP_SIGNING_KEY, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
      return;
    }

    let result: AppleServerNotificationResult;
    try {
      result = await handleAppleServerNotification(req.body, createProductionNotificationDeps());
    } catch {
      // 想定外のエラーはエラーの詳細を出さず、Apple に再送してもらう(5xx)
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    switch (result.outcome) {
      case 'ok':
      case 'test':
      case 'no-owner':
        res.status(200).json({ status: 'ok' });
        return;
      case 'invalid':
        res.status(400).json({ error: 'invalid_notification' });
        return;
      case 'unavailable':
        res.status(503).json({ error: 'unavailable' });
        return;
    }
  },
);
