/**
 * サブスクリプショングループ「Premium」の製品ID(requirements 3-4, 2026-10-09 決定)。
 * アプリ(課金画面・購入)と Cloud Functions(購入のサーバー確認)の両方で使うため shared に置く。
 */
export const MONTHLY_PRODUCT_ID = 'com.jime0083.gokakuwatch.premium.monthly';
export const YEARLY_PRODUCT_ID = 'com.jime0083.gokakuwatch.premium.yearly';

/** サーバー確認で受け付ける製品IDの一覧 */
export const APPLE_IAP_PRODUCT_IDS = [MONTHLY_PRODUCT_ID, YEARLY_PRODUCT_ID] as const;

export type AppleIapProductId = (typeof APPLE_IAP_PRODUCT_IDS)[number];

export function isKnownAppleIapProductId(productId: string): productId is AppleIapProductId {
  return (APPLE_IAP_PRODUCT_IDS as readonly string[]).includes(productId);
}
