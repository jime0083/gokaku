import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from '../config';
import {
  createProductionIssueDeviceTokenDeps,
  issueDeviceTokenForUid,
  type IssueDeviceTokenDeps,
  type IssueDeviceTokenResult,
} from './issueDeviceToken';

/**
 * 5-3a: ログイン済みユーザー本人向けにデバイストークンを発行・作り直す Callable(requirements 3-2)。
 *
 * uid はクライアントから受け取らず、必ず request.auth.uid(Firebase Auth で検証済みの ID トークン)を使う。
 * data に uid 等が含まれていても無視する(他人の uid への発行・なりすましの防止)。
 * 作り直しもこの Callable を呼べばよい(呼ぶたびに新しく発行し、古いトークンは上書きで無効になる)。
 *
 * 返す値は { deviceToken(生の値。サーバーには保存しない), expiresAt(epoch ミリ秒) }。
 * アプリ側(5-3a-2)はこの expiresAt を使って残りの日数を判断する
 */
export async function handleIssueDeviceTokenRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: IssueDeviceTokenDeps,
): Promise<IssueDeviceTokenResult> {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }

  return issueDeviceTokenForUid(uid, deps);
}

export const issueDeviceToken = onCall({ region: FUNCTIONS_REGION }, (request) =>
  handleIssueDeviceTokenRequest(request, createProductionIssueDeviceTokenDeps()),
);
