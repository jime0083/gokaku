import { defineInt, defineSecret } from 'firebase-functions/params';

/**
 * 4-2a: Apple 購入のサーバー確認に使う設定値(本物の値は W6(App Store Connect の設定)の後、8-2 で入れる)。
 * 鍵・ID はいずれも秘密情報のため Cloud Functions のシークレット(defineSecret)にする(リポジトリに値を置かない)。
 */

/** App Store Connect で発行した .p8 鍵の内容(秘密鍵)。環境変数名: APPLE_IAP_SIGNING_KEY */
export const APPLE_IAP_SIGNING_KEY = defineSecret('APPLE_IAP_SIGNING_KEY');

/** 上の鍵の Key ID。環境変数名: APPLE_IAP_KEY_ID */
export const APPLE_IAP_KEY_ID = defineSecret('APPLE_IAP_KEY_ID');

/** App Store Connect の Issuer ID。環境変数名: APPLE_IAP_ISSUER_ID */
export const APPLE_IAP_ISSUER_ID = defineSecret('APPLE_IAP_ISSUER_ID');

/**
 * App Store Connect のアプリ番号(appAppleId)。Production の SignedDataVerifier にのみ必須。
 * 秘密情報ではないため params(defineInt)にする。環境変数名: APPLE_IAP_APP_APPLE_ID
 * (既定値 0 は未設定を表す。本番運用前に W6 の値へ差し替える)
 */
export const APPLE_IAP_APP_APPLE_ID = defineInt('APPLE_IAP_APP_APPLE_ID', { default: 0 });

/** このアプリの Bundle ID(requirements 3-4) */
export const APPLE_IAP_BUNDLE_ID = 'com.jime0083.gokakuwatch';
