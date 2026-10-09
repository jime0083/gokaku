/**
 * 購入のサーバー確認(Cloud Functions の verifyApplePurchase)を呼ぶ層(4-2c)。
 * 画面(src/app/paywall.tsx)はこのモジュールの関数だけを呼び、@react-native-firebase/functions を
 * 直接呼ばない(テストで jest.mock に差し替えられるようにする)。
 *
 * src/config/firebase.ts と同じ理由(expo-router が src/app/ 配下の全ファイルを起動時に読み込むため)で、
 * @react-native-firebase/* は実際に呼び出す関数の中でだけ require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';

/** verifyApplePurchase(Cloud Functions)の結果(requirements 3-4)。'active'/'expired' はサーバーが返す値、
 * それ以外は HttpsError の details.reason、または想定外のエラー(unauthenticated 等)を「確認できない」に丸めたもの */
export type VerifyPurchaseResult =
  | { status: 'active'; expiresAt: number }
  | { status: 'expired'; expiresAt: number }
  | { status: 'verification-unavailable' }
  | { status: 'invalid-transaction' }
  | { status: 'owned-by-other-account' };

const KNOWN_FAILURE_REASONS = [
  'verification-unavailable',
  'invalid-transaction',
  'owned-by-other-account',
] as const;
type KnownFailureReason = (typeof KNOWN_FAILURE_REASONS)[number];

function isKnownFailureReason(value: unknown): value is KnownFailureReason {
  return typeof value === 'string' && (KNOWN_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * transactionId を渡して Cloud Functions の verifyApplePurchase を呼ぶ。
 * unauthenticated など details.reason を持たない想定外のエラーも含め、サーバー側で確認できなかった場合は
 * すべて 'verification-unavailable' として返す(requirements 3-4 の「確認できませんでした」)
 */
export async function verifyApplePurchase(transactionId: string): Promise<VerifyPurchaseResult> {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;

  try {
    const callable = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), 'verifyApplePurchase');
    const response = await callable({ transactionId });
    const data = response.data as { status?: unknown; expiresAt?: unknown } | null | undefined;
    if (data?.status === 'active' && typeof data.expiresAt === 'number') {
      return { status: 'active', expiresAt: data.expiresAt };
    }
    if (data?.status === 'expired' && typeof data.expiresAt === 'number') {
      return { status: 'expired', expiresAt: data.expiresAt };
    }
    return { status: 'verification-unavailable' };
  } catch (error) {
    const reason = (error as { details?: { reason?: unknown } } | null | undefined)?.details?.reason;
    if (isKnownFailureReason(reason)) {
      return { status: reason };
    }
    return { status: 'verification-unavailable' };
  }
}
