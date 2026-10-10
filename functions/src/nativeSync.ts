import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from './config';
import { hashDeviceToken } from './deviceTokenHash';
import { ensureAdminApp } from './firebaseAdmin';

/**
 * ロック画面(ライブアクティビティ・ロック画面コントロール)・通知アクションから、
 * アプリを開かずに行った開始・停止・確認応答を記録する HTTPS 関数。
 *
 * 認証方式(requirements 3-2「送信方式」): ログイン済みユーザー向けに issueDeviceToken(Callable。5-3a)が
 * 発行したデバイストークンを、ネイティブ側が Keychain(App Group 共有)に保存し、
 * Authorization: Bearer で送る。サーバーは sha256 ハッシュだけを保存し、受信したトークンの
 * ハッシュと比較する(生のトークンは保存しない)。
 *
 * 時刻は端末時刻(clientTimeMs。改ざん・遅延があり得る)とサーバー受信時刻(serverReceivedAt)の
 * 両方を記録する。再送(リプレイ)対策として、クライアント生成の idempotencyKey をドキュメントIDに使い、
 * 同じイベントの再送は上書き(無害)になるようにする。
 *
 * このコレクション(users/{uid}/syncEvents)は検証用の形で、requirements.md 5 の
 * users/{uid}/sessions とは別物(本実装は 5-3 で確定する)
 *
 * 5-3a / 5-3a-2: deviceTokens/{uid} の expiresAt(issueDeviceToken が発行時に設定する有効期限)を過ぎている
 * トークンは拒否する(requirements 3-2「期限切れや無効のトークンでの操作は拒否する」)。
 * expiresAt が無い・数値でない場合もフェイルクローズで拒否する(5-3a レビュー指摘。issueDeviceToken が
 * 発行したトークンには常に expiresAt が入るため、これは「壊れたデータ」として扱ってよい)
 */

const VALID_ACTIONS = ['start', 'stop', 'confirm'] as const;
type SyncAction = (typeof VALID_ACTIONS)[number];

const VALID_SOURCES = ['app', 'live_activity', 'control_widget', 'notification_action'] as const;
type SyncSource = (typeof VALID_SOURCES)[number];

type NativeSyncBody = {
  uid: string;
  goalId: string;
  action: SyncAction;
  source: SyncSource;
  clientTimeMs: number;
  idempotencyKey: string;
};

function isValidBody(body: unknown): body is NativeSyncBody {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const b = body as Record<string, unknown>;
  return (
    typeof b.uid === 'string' &&
    b.uid.length > 0 &&
    typeof b.goalId === 'string' &&
    typeof b.action === 'string' &&
    (VALID_ACTIONS as readonly string[]).includes(b.action) &&
    typeof b.source === 'string' &&
    (VALID_SOURCES as readonly string[]).includes(b.source) &&
    typeof b.clientTimeMs === 'number' &&
    Number.isFinite(b.clientTimeMs) &&
    typeof b.idempotencyKey === 'string' &&
    b.idempotencyKey.length > 0
  );
}

export const nativeSync = onRequest({ region: FUNCTIONS_REGION }, async (req, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const authHeader = req.get('authorization') ?? '';
  const bearerMatch = /^Bearer (.+)$/.exec(authHeader);
  if (!bearerMatch) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const token = bearerMatch[1];

  if (!isValidBody(req.body)) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const { uid, goalId, action, source, clientTimeMs, idempotencyKey } = req.body;

  ensureAdminApp();
  const db = getFirestore();

  const deviceTokenSnap = await db.doc(`deviceTokens/${uid}`).get();
  const storedHash = deviceTokenSnap.get('tokenHash') as string | undefined;
  const expiresAt = deviceTokenSnap.get('expiresAt') as unknown;
  const hasValidExpiresAt = typeof expiresAt === 'number' && Number.isFinite(expiresAt);
  // expiresAt が無い・数値でない場合はフェイルクローズ(期限切れと同じ扱い)で拒否する(5-3a-2)
  const isExpired = !hasValidExpiresAt || Date.now() >= expiresAt;
  if (!deviceTokenSnap.exists || storedHash !== hashDeviceToken(token) || isExpired) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  await db.doc(`users/${uid}/syncEvents/${idempotencyKey}`).set({
    goalId,
    action,
    source,
    clientTime: new Date(clientTimeMs).toISOString(),
    serverReceivedAt: FieldValue.serverTimestamp(),
  });

  res.status(200).json({ status: 'ok' });
});
