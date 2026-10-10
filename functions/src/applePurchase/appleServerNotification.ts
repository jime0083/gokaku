import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import { NotificationTypeV2, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { PUBLIC_ENDPOINT_MAX_BODY_BYTES, PUBLIC_ENDPOINT_MAX_INSTANCES } from '../httpRequestLimits';
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
 *
 * 大量の呼び出しへの対策(5-3b-2。requirements 3-2「誰でも呼べる Apple の通知の入口...には、同時に動く数の
 * 上限(maxInstances)と、受け取るデータの大きさの上限を設ける」):
 * - この入口は URL を知っていれば誰でも呼べる(Apple の署名検証はリクエストボディを読んだ後にしかできないため、
 *   ユーザーごとの回数制限は使えない。かわりに同時に動くインスタンス数を APPLE_SERVER_NOTIFICATION_MAX_INSTANCES
 *   に制限し、無制限な同時アクセスでの課金増加・Apple API への負荷を防ぐ)
 * - 受け取る本文は APPLE_SERVER_NOTIFICATION_MAX_BODY_BYTES(64KB)を超えたら 413 で断る(JSON としての
 *   解析・署名検証(handleAppleServerNotification の処理)に進む前に、実際に受信したバイト数(req.rawBody)で
 *   判定する)。
 *   Apple の通知本文は signedPayload 1本の JWT(ヘッダー+ペイロード+署名の3パートを base64url 化した文字列)で、
 *   ペイロードの中の signedTransactionInfo・signedRenewalInfo もそれぞれ同様の JWT 1本であり、実測・公開ドキュメントの
 *   サンプルはいずれも数KB程度(未確認: Apple は本文サイズの上限を公式には明記していない)。64KB は想定される
 *   実際の大きさに対して十分な余裕(10倍以上)を持たせた値
 * - (5-3b-3 追記)本文の解析自体(Express の body-parser。req.body・req.rawBody を組み立てる処理)は
 *   firebase-functions のフレームワークが onRequest のコールバックを呼ぶ前に行うため、413 の判定より
 *   前に走る。つまり 64KB を超える本文もいったんは受信・解析される。その間の上限は、プラットフォーム側
 *   (Cloud Run)のリクエスト本文の大きさの上限(未確認: Google Cloud は Cloud Run のリクエストサイズの上限を
 *   32MiB と案内しているが、firebase-functions v2(Cloud Run 上で動く)がこの値をそのまま使うかはコードから
 *   確認できていない)と、同時に動くインスタンス数の上限(maxInstances)で抑えている
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

/** 受け取る本文の大きさの上限(5-3b-2。requirements 3-2。値は nativeSync と共通。httpRequestLimits.ts 参照) */
export const APPLE_SERVER_NOTIFICATION_MAX_BODY_BYTES = PUBLIC_ENDPOINT_MAX_BODY_BYTES;

/** 同時に動くインスタンス数の上限(5-3b-2。requirements 3-2。値は nativeSync と共通。httpRequestLimits.ts 参照) */
export const APPLE_SERVER_NOTIFICATION_MAX_INSTANCES = PUBLIC_ENDPOINT_MAX_INSTANCES;

/** テストから maxInstances の設定値を確認できるよう、onRequest に渡す options を公開する */
export const APPLE_SERVER_NOTIFICATION_OPTIONS = {
  region: FUNCTIONS_REGION,
  secrets: [APPLE_IAP_SIGNING_KEY, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID],
  maxInstances: APPLE_SERVER_NOTIFICATION_MAX_INSTANCES,
};

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
  APPLE_SERVER_NOTIFICATION_OPTIONS,
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
      return;
    }

    if (req.rawBody.byteLength > APPLE_SERVER_NOTIFICATION_MAX_BODY_BYTES) {
      res.status(413).json({ error: 'payload_too_large' });
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
