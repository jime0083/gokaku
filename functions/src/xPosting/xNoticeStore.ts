import type { Firestore } from 'firebase-admin/firestore';

import { getWritableAccount } from '../account/accountWriteGuard';
import { readXNotice } from '../domain';

export type AckXNoticeResult = {
  status: 'acknowledged' | 'unchanged';
};

const MAX_UID_LENGTH = 128;

/** 本人の既存親だけを更新する。再試行時も親・通知・現在時刻を読み直す。 */
export async function acknowledgeXNotice(
  db: Firestore,
  uid: string,
  noticeId: string,
  now: () => number = () => Date.now(),
): Promise<AckXNoticeResult> {
  if (
    typeof uid !== 'string' || uid.length === 0 || uid.length > MAX_UID_LENGTH
    || uid.trim().length === 0 || uid.includes('/') || uid === '.' || uid === '..'
    || /^__.*__$/.test(uid) || /[\u0000-\u001f\u007f]/.test(uid)
    || Buffer.from(uid, 'utf8').toString('utf8') !== uid
    || typeof noticeId !== 'string' || noticeId.length !== 64
    || !/^[0-9a-f]{64}$/.test(noticeId)
  ) {
    throw new Error('Invalid X notice acknowledgement');
  }

  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction<AckXNoticeResult>(async (tx) => {
    const parent = await getWritableAccount(tx, userRef);
    const notice = readXNotice(parent.get('xNotice'));
    // transaction callbackごとに、親と通知を読み終えた後で取得する。
    const readAt = now();
    if (notice === null || notice.id !== noticeId || notice.readAt !== null) {
      return { status: 'unchanged' };
    }

    // 時刻の安全整数・Firestore範囲も共有protocolで検証する。
    const acknowledged = readXNotice({ ...notice, readAt });
    if (acknowledged === null) throw new Error('Invalid X notice acknowledgement');
    tx.update(userRef, { 'xNotice.readAt': acknowledged.readAt });
    return { status: 'acknowledged' };
  });
}
