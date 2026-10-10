/**
 * ログイン中のユーザー向けに、デバイストークン(5-3a)の発行・作り直しを試みる(5-3a-2。requirements 3-2)。
 * src/features/deviceToken/useDeviceTokenSync.ts(src/app/_layout.tsx から呼ぶ)が、
 * アプリの起動時・他のアプリから戻ったとき(AppState が active)に呼ぶ。
 *
 * - 未ログイン(Firebase Auth の現在のユーザーがいない)ときは何もしない
 * - 次のどちらかなら issueDeviceToken(Callable)で発行する:
 *   - 端末に保存したトークンの期限(expiresAt)が分からない(初回・保存が壊れている)
 *   - 残りが7日を切っている(DEVICE_TOKEN_REISSUE_THRESHOLD_MS)
 *   - 保存した uid が今のユーザーと違う(別の端末・別のアカウントでログインした)
 * - 発行した生のトークンは Keychain(App Group 共有)にだけ保存する。期限(expiresAt)と uid は
 *   秘密ではないため AsyncStorage に保存してよい(deviceTokenStorage.ts)
 * - 発行・Keychain への保存のどちらかに失敗しても例外を外に出さず、何もしない(次の機会に再試行する)
 * - 同時に2回走らない(呼ばれた時点で実行中なら何もしない)
 */
import { getCurrentUid } from '@/config/firebase';

import { callIssueDeviceToken } from './deviceTokenApi';
import { loadDeviceTokenMeta, saveDeviceTokenMeta, type DeviceTokenMeta } from './deviceTokenStorage';
import { saveDeviceTokenToKeychain } from './studySyncAuthContext';

/** 残りがこの値を切っていれば作り直す(2026-10-10 ユーザー決定。requirements 3-2) */
export const DEVICE_TOKEN_REISSUE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

let issuing = false;

function needsIssue(meta: DeviceTokenMeta | null, uid: string, now: number): boolean {
  if (!meta) {
    // 期限が分からない(初回・保存が壊れている)
    return true;
  }
  if (meta.uid !== uid) {
    // 保存した uid が今のユーザーと違う
    return true;
  }
  return meta.expiresAt - now < DEVICE_TOKEN_REISSUE_THRESHOLD_MS;
}

/**
 * now は現在時刻(epoch ミリ秒)。テストから固定できるようにするための引数で、呼び出し側(useDeviceTokenSync)は
 * 省略してよい(Date.now() を使う)
 */
export async function ensureDeviceToken(now: number = Date.now()): Promise<void> {
  if (issuing) {
    return;
  }
  issuing = true;
  try {
    const uid = getCurrentUid();
    if (!uid) {
      return;
    }

    const meta = await loadDeviceTokenMeta();
    if (!needsIssue(meta, uid, now)) {
      return;
    }

    const result = await callIssueDeviceToken();
    if (!result) {
      // 発行に失敗(通信エラー等)。何もせず次の機会に試す
      return;
    }

    const saved = saveDeviceTokenToKeychain(uid, result.deviceToken);
    if (!saved) {
      // Keychain への保存に失敗。AsyncStorage の期限は更新せず、次の機会に発行し直す
      return;
    }

    await saveDeviceTokenMeta({ uid, expiresAt: result.expiresAt });
  } catch {
    // 失敗したら何もしない。次の機会(起動時・他のアプリから戻ったとき)に再試行する
  } finally {
    issuing = false;
  }
}
