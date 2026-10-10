import { getFirestore } from 'firebase-admin/firestore';

import { ensureAdminApp } from '../firebaseAdmin';

/**
 * 5-3a: uid のデバイストークンを失効させる共通処理(requirements 3-2「ログアウト・アカウント削除でも、すぐ無効にする」)。
 *
 * deviceTokens/{uid} を削除するだけで、以後 nativeSync の照合(ハッシュ一致)が成立しなくなる。
 * 6-4(ログアウト・アカウント削除の Callable)から呼ぶための関数で、このタスク(5-3a)では
 * 呼び出しの入口(Callable)は作らない
 */
export async function revokeDeviceToken(uid: string): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`deviceTokens/${uid}`).delete();
}
