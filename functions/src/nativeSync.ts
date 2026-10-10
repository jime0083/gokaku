import { timingSafeEqual } from 'node:crypto';

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from './config';
import { hashDeviceToken } from './deviceTokenHash';
import { ensureAdminApp } from './firebaseAdmin';
import {
  createProductionRecordStudySessionEventDeps,
  RECORD_STUDY_EVENT_ACTIONS,
  recordStudySessionEvent,
  RecordStudySessionEventError,
  type RecordStudySessionEventInput,
} from './studySession/recordStudySessionEvent';

/**
 * ロック画面(ライブアクティビティ・ロック画面コントロール)・通知アクションから、
 * アプリを開かずに行った開始・停止・確認応答を記録する HTTPS 関数(5-3b-1)。
 *
 * requirements 3-2「アプリからの記録の保存」のとおり、本文の形はアプリの記録(recordStudyEvent。5-1b-1・5-2a)と
 * 揃えている(sessionId・action・clientTimeMs・idempotencyKey・goalId、start のときは checkEnabled)。
 * source はこの関数からの記録は常に 'lockscreen'(本文からは受け取らない)。
 * 保存・時刻の補正・二重記録の防止・goalId の実在確認・confirmations の上限は、共通処理
 * (recordStudySessionEvent)に任せる。これにより users/{uid}/sessions がアプリとロック画面の
 * 両方からの記録の唯一の保存先になる(検証用だった users/{uid}/syncEvents への書き込みは 5-3b-1 でやめた)。
 *
 * 認証方式(requirements 3-2「送信方式」): ログイン済みユーザー向けに issueDeviceToken(Callable。5-3a)が
 * 発行したデバイストークンを、ネイティブ側が Keychain(App Group 共有)に保存し、
 * Authorization: Bearer で送る。サーバーは sha256 ハッシュだけを保存し、受信したトークンの
 * ハッシュと比較する(生のトークンは保存しない)。ハッシュの比較は crypto.timingSafeEqual で行い、
 * 長さが違う場合(トークンが発行されていない等)も例外を投げずに不一致として扱う(タイミング攻撃対策)。
 *
 * 本文の uid は「このトークンの持ち主かどうかの確認」にだけ使う: deviceTokens/{uid} を読み、
 * そこに保存されたハッシュと比較する。body.uid が本当の持ち主と異なれば、比較対象のハッシュも
 * 他人のものになるため自然に不一致(401)になる(他人の uid で他人の sessions には書けない)。
 *
 * 5-3a / 5-3a-2: deviceTokens/{uid} の expiresAt(issueDeviceToken が発行時に設定する有効期限)を過ぎている
 * トークンは拒否する(requirements 3-2「期限切れや無効のトークンでの操作は拒否する」)。
 * expiresAt が無い・数値でない場合もフェイルクローズで拒否する(issueDeviceToken が発行したトークンには
 * 常に expiresAt が入るため、これは「壊れたデータ」として扱ってよい)。
 *
 * エラー応答(Swift 側(5-3c)が送り直すか捨てるかを判断できるように区別する。内部の詳細は返さない):
 * - 本文の形が不正(ID の形・action・clientTimeMs・start なのに checkEnabled が無い等) → 400 invalid_body
 * - Authorization が無い・トークンが不正・期限切れ・uid が持ち主と違う → 401 unauthorized(送り直しても変わらないので捨てる)
 * - 架空の goalId(本人の目標として存在しない) → 400 goal_not_found(送り直しても変わらないので捨てる)
 * - confirmations の上限超え → 429 confirmation_limit_exceeded(送り直しても変わらないので捨てる)
 * - それ以外の予期しない失敗 → 500 internal(送り直してよい)
 */

// Firestore のドキュメントID(uid・sessionId・idempotencyKey・goalId)として安全な形式に限定する
// (パスの区切り('/')・相対パス('.'・'..')・制御文字などを拒否する。recordStudyEvent.ts と同じ強さ)
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type NativeSyncBody = {
  uid: string;
  sessionId: string;
  goalId: string;
  action: RecordStudySessionEventInput['action'];
  clientTimeMs: number;
  idempotencyKey: string;
  /** action が 'start' のときだけ必須(requirements 3-2) */
  checkEnabled?: boolean;
};

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function isValidAction(value: unknown): value is RecordStudySessionEventInput['action'] {
  return typeof value === 'string' && (RECORD_STUDY_EVENT_ACTIONS as readonly string[]).includes(value);
}

/** 本文を検査し、妥当なら NativeSyncBody を返す(不正なら null) */
function parseBody(body: unknown): NativeSyncBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const b = body as Record<string, unknown>;
  if (!isSafeId(b.uid) || !isSafeId(b.sessionId) || !isSafeId(b.goalId) || !isSafeId(b.idempotencyKey)) {
    return null;
  }
  if (!isValidAction(b.action)) {
    return null;
  }
  if (typeof b.clientTimeMs !== 'number' || !Number.isFinite(b.clientTimeMs)) {
    return null;
  }
  if (b.action === 'start' && typeof b.checkEnabled !== 'boolean') {
    return null;
  }
  return {
    uid: b.uid,
    sessionId: b.sessionId,
    goalId: b.goalId,
    action: b.action,
    clientTimeMs: b.clientTimeMs,
    idempotencyKey: b.idempotencyKey,
    checkEnabled: b.action === 'start' ? (b.checkEnabled as boolean) : undefined,
  };
}

/** sha256 ハッシュ同士を timingSafeEqual で比較する。長さが違う場合も例外を投げずに不一致として扱う */
function hashesMatch(storedHash: unknown, candidateHash: string): boolean {
  if (typeof storedHash !== 'string') {
    return false;
  }
  const storedBuf = Buffer.from(storedHash, 'utf8');
  const candidateBuf = Buffer.from(candidateHash, 'utf8');
  if (storedBuf.length !== candidateBuf.length) {
    return false;
  }
  return timingSafeEqual(storedBuf, candidateBuf);
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

  const body = parseBody(req.body);
  if (!body) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  ensureAdminApp();
  const db = getFirestore();

  const deviceTokenSnap = await db.doc(`deviceTokens/${body.uid}`).get();
  const expiresAt = deviceTokenSnap.get('expiresAt') as unknown;
  const hasValidExpiresAt = typeof expiresAt === 'number' && Number.isFinite(expiresAt);
  // expiresAt が無い・数値でない場合はフェイルクローズ(期限切れと同じ扱い)で拒否する(5-3a-2)
  const isExpired = !hasValidExpiresAt || Date.now() >= expiresAt;
  const tokenMatches = hashesMatch(deviceTokenSnap.get('tokenHash'), hashDeviceToken(token));
  if (!deviceTokenSnap.exists || !tokenMatches || isExpired) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    await recordStudySessionEvent(
      body.uid,
      {
        sessionId: body.sessionId,
        goalId: body.goalId,
        action: body.action,
        source: 'lockscreen',
        clientTimeMs: body.clientTimeMs,
        idempotencyKey: body.idempotencyKey,
        checkEnabled: body.checkEnabled,
      },
      createProductionRecordStudySessionEventDeps(),
    );
  } catch (error) {
    if (error instanceof RecordStudySessionEventError) {
      if (error.reason === 'goal-not-found') {
        res.status(400).json({ error: 'goal_not_found' });
        return;
      }
      if (error.reason === 'confirmation-limit-exceeded') {
        res.status(429).json({ error: 'confirmation_limit_exceeded' });
        return;
      }
    }
    res.status(500).json({ error: 'internal' });
    return;
  }

  res.status(200).json({ status: 'ok' });
});
