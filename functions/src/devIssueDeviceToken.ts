import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { randomBytes } from 'node:crypto';

import { FUNCTIONS_REGION } from './config';
import { hashDeviceToken } from './deviceTokenHash';
import { ensureAdminApp } from './firebaseAdmin';

/**
 * Phase 1-4 技術検証専用: デバイストークンを発行する。
 * Sign in with Apple(3-5)より前の検証のためのスキャフォルドで、本番の発行方法ではない
 * (5-3 で、ログイン済みユーザーに対する正式な発行方法に置き換える)。
 *
 * `FUNCTIONS_EMULATOR` は Firebase Emulator 実行時にのみ 'true' になる環境変数のため、
 * 本番にデプロイされても常に 404 を返し、動作しない(フェイルクローズ)
 */
export const devIssueDeviceToken = onRequest({ region: FUNCTIONS_REGION }, async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = req.body as { uid?: unknown };
  if (typeof body?.uid !== 'string' || body.uid.length === 0) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const uid = body.uid;
  const deviceToken = randomBytes(32).toString('hex');

  ensureAdminApp();
  await getFirestore().doc(`deviceTokens/${uid}`).set({
    tokenHash: hashDeviceToken(deviceToken),
    createdAt: FieldValue.serverTimestamp(),
  });

  res.status(200).json({ uid, deviceToken });
});
