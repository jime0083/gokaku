/**
 * Cloud Functions の issueDeviceToken(Callable。5-3a)を呼ぶ層(5-3a-2)。
 * ensureDeviceToken.ts・src/app/dev-lockscreen-spike.tsx はこのモジュールの関数だけを呼び、
 * @react-native-firebase/functions を直接呼ばない(テストで jest.mock に差し替えられるようにする)。
 *
 * src/config/firebase.ts と同じ理由(expo-router が src/app/ 配下の全ファイルを起動時に読み込むため)で、
 * @react-native-firebase/* は実際に呼び出す関数の中でだけ require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';

export type IssueDeviceTokenResult = {
  /** 生のデバイストークン。呼び出し元はこれを Keychain にだけ保存する(AsyncStorage・ログ・画面に出さない) */
  deviceToken: string;
  /** 有効期限(epoch ミリ秒) */
  expiresAt: number;
};

function isValidResult(data: unknown): data is IssueDeviceTokenResult {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    typeof record.deviceToken === 'string' &&
    record.deviceToken.length > 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  );
}

/**
 * issueDeviceToken(Callable)を呼ぶ。ログイン済みであること(Firebase Auth)が前提
 * (未ログインはサーバーが unauthenticated を返す。呼び出し元(ensureDeviceToken)はログイン確認を先に行う)。
 * 通信エラー・サーバーエラー・想定外の応答の形はすべて null として返す(例外を外に出さない。
 * 呼び出し元は失敗時に何もせず、次の機会に再試行する。requirements 3-2)
 */
export async function callIssueDeviceToken(): Promise<IssueDeviceTokenResult | null> {
  try {
    connectFirebaseEmulatorsIfNeeded();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;

    const callable = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), 'issueDeviceToken');
    const response = await callable();
    return isValidResult(response.data) ? response.data : null;
  } catch {
    return null;
  }
}
