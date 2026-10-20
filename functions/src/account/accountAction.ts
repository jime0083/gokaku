import { getAuth } from 'firebase-admin/auth';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import { revokeDeviceToken } from '../deviceToken/revokeDeviceToken';
import { ensureAdminApp } from '../firebaseAdmin';
import { RATE_LIMITS } from '../rateLimit';
import { markAccountDeletionStarted } from './accountWriteGuard';

export type AccountAction = 'logout' | 'delete';

export type AccountActionDeps = {
  now: () => number;
  beginDeletion: (uid: string) => Promise<void>;
  revokeDeviceToken: (uid: string) => Promise<void>;
  deleteRelatedData: (uid: string) => Promise<void>;
  deleteAuthUser: (uid: string) => Promise<void>;
};

/**
 * 6-4: 現在のスキーマに存在する本人の関連データだけを削除する。
 * Apple通知のownerを先に消す。削除後に届いた通知は既存handlerでno-ownerになる。
 * usersは親ドキュメントが既に消えている場合も子孫まで削除する。
 */
async function deleteRelatedData(uid: string): Promise<void> {
  ensureAdminApp();
  const db = getFirestore();

  const subscriptions = await db.collection('appleSubscriptions').where('uid', '==', uid).get();
  for (const doc of subscriptions.docs) {
    await doc.ref.delete();
  }
  await db.doc(`xTokens/${uid}`).delete();
  await db.doc(`devProbe/${uid}`).delete();

  // 実スキーマは ${uid}_${kind}_${minute}。UID自体にも "_" を含められるため、
  // prefixだけで消さず、kindに続く部分が数値minuteだけであることも確認する。
  for (const kind of Object.keys(RATE_LIMITS)) {
    const prefix = `${uid}_${kind}_`;
    const counters = await db.collection('rateLimits')
      .orderBy(FieldPath.documentId())
      .startAt(prefix)
      .endAt(`${prefix}\uf8ff`)
      .get();
    for (const doc of counters.docs) {
      if (/^\d+$/.test(doc.id.slice(prefix.length))) {
        await doc.ref.delete();
      }
    }
  }

  await db.recursiveDelete(db.doc(`users/${uid}`));
}

async function deleteAuthUser(uid: string): Promise<void> {
  ensureAdminApp();
  try {
    await getAuth().deleteUser(uid);
  } catch (error) {
    // 削除が実際には完了した後で応答を受け取れなかった場合も再実行できる。
    if (!(error instanceof Error && 'code' in error && error.code === 'auth/user-not-found')) {
      throw error;
    }
  }
}

export function createProductionAccountActionDeps(): AccountActionDeps {
  return {
    now: () => Date.now(),
    beginDeletion: markAccountDeletionStarted,
    revokeDeviceToken,
    deleteRelatedData,
    deleteAuthUser,
  };
}

/** 各工程の失敗を伝播する。Authはデータ削除が全て成功した後にだけ削除する。 */
export async function performAccountAction(
  uid: string,
  action: AccountAction,
  deps: AccountActionDeps,
): Promise<void> {
  if (action === 'delete') {
    await deps.beginDeletion(uid);
  }
  await deps.revokeDeviceToken(uid);
  if (action === 'delete') {
    await deps.deleteRelatedData(uid);
    await deps.deleteAuthUser(uid);
  }
}
