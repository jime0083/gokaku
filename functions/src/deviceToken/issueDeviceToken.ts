import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

import { hashDeviceToken } from '../deviceTokenHash';
import { ensureAdminApp } from '../firebaseAdmin';

/**
 * 5-3a: デバイストークンの正式な発行(requirements 3-2「送信方式」2026-10-10 追記)。
 *
 * - 有効期限は発行から30日(2026-10-10 ユーザー決定)
 * - 1人につき有効なトークンは1つ。deviceTokens/{uid} を常に上書きするため、
 *   新しく発行した時点で古いトークンのハッシュは Firestore から消え、古いトークンでの照合(nativeSync)は失敗する
 * - 生のトークンは呼び出し元にだけ返し、サーバーには sha256 ハッシュだけを保存する(deviceTokenHash)
 * - 作り直しも同じ処理(issueDeviceTokenForUid)を呼べばよい(常に新規発行のため)
 */

export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type IssueDeviceTokenDeps = {
  /** 発行時刻(epoch ミリ秒)。テストから固定できるようにする */
  now: () => number;
};

export function createProductionIssueDeviceTokenDeps(): IssueDeviceTokenDeps {
  return { now: () => Date.now() };
}

export type IssueDeviceTokenResult = {
  deviceToken: string;
  expiresAt: number;
};

/**
 * uid 向けにデバイストークンを新しく発行する。
 * uid は呼び出し側(Callable の入口)が request.auth.uid から確定させたものを渡すこと
 * (本人以外の uid にすり替えられないようにするため、この関数自体は呼び出し元を検証しない)
 */
export async function issueDeviceTokenForUid(
  uid: string,
  deps: IssueDeviceTokenDeps,
): Promise<IssueDeviceTokenResult> {
  ensureAdminApp();
  const deviceToken = randomBytes(32).toString('hex');
  const issuedAt = deps.now();
  const expiresAt = issuedAt + DEVICE_TOKEN_TTL_MS;

  // 1人につき有効なトークンは1つのため、常に上書きする(古いトークンのハッシュはここで消える)
  await getFirestore().doc(`deviceTokens/${uid}`).set({
    tokenHash: hashDeviceToken(deviceToken),
    issuedAt,
    expiresAt,
  });

  return { deviceToken, expiresAt };
}
