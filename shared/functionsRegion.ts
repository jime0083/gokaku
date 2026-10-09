/**
 * Cloud Functions のデプロイ先リージョン(4-2c)。
 * アプリ側で Cloud Functions を呼ぶ・接続する全ての場所
 * (src/config/firebase-emulator.ts の functionsRegion、src/features/billing/verifyPurchase.ts の
 * region 指定、src/app/dev-lockscreen-spike.tsx)はこの値を使い、直書きしない。
 *
 * functions/src/config.ts の FUNCTIONS_REGION と同じ値であること
 * (functions は別ワークスペース(tsconfig の rootDir が異なる)のため、値はそちら側で直書きしている。
 * 値を変える場合は両方を更新する)
 */
export const FUNCTIONS_REGION = 'asia-northeast1';
