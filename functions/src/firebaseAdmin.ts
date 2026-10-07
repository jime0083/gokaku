import { getApps, initializeApp } from 'firebase-admin/app';

/** firebase-admin の初期化(複数の Function から呼ばれても一度だけ初期化する) */
export function ensureAdminApp(): void {
  if (getApps().length === 0) {
    initializeApp();
  }
}
