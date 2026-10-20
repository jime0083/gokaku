import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from '../config';
import {
  createProductionAccountActionDeps,
  performAccountAction,
  type AccountAction,
  type AccountActionDeps,
} from './accountAction';
import { ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS } from './config';

type AccountActionResult = { action: AccountAction; success: true };

export async function handleAuthAccountActionRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  deps: AccountActionDeps,
): Promise<AccountActionResult> {
  const auth = request.auth;
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }

  const data = request.data;
  if (
    typeof data !== 'object' || data === null || Array.isArray(data) ||
    Object.keys(data).some((key) => key !== 'action' && key !== 'expectedUid') ||
    !Object.prototype.hasOwnProperty.call(data, 'action') || !('action' in data) ||
    (data.action !== 'logout' && data.action !== 'delete') ||
    ('expectedUid' in data &&
      (typeof data.expectedUid !== 'string' || data.expectedUid !== auth.uid))
  ) {
    throw new HttpsError('invalid-argument', '操作を確認してください');
  }
  const action = data.action;

  if (action === 'delete') {
    // onCallが検証したIDトークンのclaimsだけを使う。dataのprovider等は受け取らない。
    if (auth.token.firebase?.sign_in_provider !== 'apple.com') {
      throw new HttpsError('permission-denied', 'Appleでの本人確認が必要です');
    }
    const authTime = auth.token.auth_time;
    const nowSeconds = Math.floor(deps.now() / 1000);
    const ageSeconds = nowSeconds - authTime;
    if (
      !Number.isSafeInteger(authTime) || authTime <= 0 ||
      !Number.isSafeInteger(nowSeconds) ||
      ageSeconds < 0 || ageSeconds >= ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Appleでもう一度本人確認してください',
        { reason: 'requires-recent-login' },
      );
    }
  }

  try {
    await performAccountAction(auth.uid, action, deps);
  } catch {
    throw new HttpsError('internal', '処理を完了できませんでした。再度お試しください');
  }
  return { action, success: true };
}

export const authAccountAction = onCall({ region: FUNCTIONS_REGION }, (request) =>
  handleAuthAccountActionRequest(request, createProductionAccountActionDeps()),
);
