import {
  getFirestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from 'firebase-admin/firestore';

import { ensureAdminApp } from '../firebaseAdmin';

export class AccountWriteBlockedError extends Error {
  constructor(readonly reason: 'missing' | 'deleting') {
    super('アカウントへの書き込みを続行できません');
    this.name = 'AccountWriteBlockedError';
  }
}

/**
 * 必ず対象の書き込みと同じtransaction内で、書き込みを登録する前に呼ぶ。
 * transaction callbackの再実行時も呼び直し、snapshotを外へキャッシュしない。
 * 親へのmarker設定・親削除との競合は、Firestoreのtransactionで直列化する。
 */
export async function getWritableAccount(
  tx: Transaction,
  userRef: DocumentReference,
): Promise<DocumentSnapshot> {
  const snapshot = await tx.get(userRef);
  if (!snapshot.exists) {
    throw new AccountWriteBlockedError('missing');
  }
  if (snapshot.get('deletionInProgress') === true) {
    throw new AccountWriteBlockedError('deleting');
  }
  return snapshot;
}

/**
 * 削除開始を既存の親だけに記録する。
 * 設定済み・親missingは再試行として許可し、markerのための親再作成はしない。
 * 途中失敗時に解除せず、削除本体のrecursiveDeleteで最後に親ごと消す。
 */
export async function markAccountDeletionStarted(uid: string): Promise<void> {
  ensureAdminApp();
  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(userRef);
    if (!snapshot.exists || snapshot.get('deletionInProgress') === true) {
      return;
    }
    tx.update(userRef, { deletionInProgress: true });
  });
}
