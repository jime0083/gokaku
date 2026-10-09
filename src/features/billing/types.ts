/**
 * 課金(4-1b 課金画面)で使う型とエラー。
 * requirements.md 3-4・4-5 の 2(製品ID・表示・エラー文言)。
 */

// 製品IDは Cloud Functions(購入のサーバー確認)と共有するため shared/billingProducts.ts にある(4-2a)。
// 既存の import 先(このファイル経由)を変えずに使えるよう、ここで再公開する
export { MONTHLY_PRODUCT_ID, YEARLY_PRODUCT_ID, isKnownAppleIapProductId } from '@shared/index';

export type BillingPlan = 'monthly' | 'yearly';

/** 画面表示に必要な商品情報(StoreKit から取得した価格を元に組み立てる) */
export type BillingProduct = {
  plan: BillingPlan;
  productId: string;
  /** 税込価格(数値。○%お得の計算に使う) */
  price: number;
  /** 画面に表示する価格文字列(StoreKit の表示形式。例: "¥300") */
  displayPrice: string;
  currency: string;
};

/** 購入・復元に成功した1件の取引情報(4-2c でサーバーの確認に使う) */
export type BillingPurchaseResult = {
  productId: string;
  transactionId: string;
  originalTransactionIdentifierIOS: string | null;
  /** iOS の JWS(サーバーでの検証に使う。4-2a) */
  purchaseToken: string | null;
  /**
   * finishTransaction(expo-iap)にそのまま渡す、元の Purchase オブジェクト(4-2c)。
   * billingClient の外では中身を見ない(型を意図的に unknown にしている)
   */
  rawPurchase: unknown;
};

/** 購入がキャンセルされた(requirements 4-5 の 2: 何も表示せず課金画面のまま) */
export class BillingCancelledError extends Error {
  constructor() {
    super('購入がキャンセルされました');
    this.name = 'BillingCancelledError';
  }
}

/** 購入に失敗した(requirements 4-5 の 2: 「購入できませんでした。時間をおいてもう一度お試しください」) */
export class BillingPurchaseFailedError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('購入できませんでした。時間をおいてもう一度お試しください');
    this.name = 'BillingPurchaseFailedError';
    this.cause = cause;
  }
}

/** 復元できる購入が見つからなかった(requirements 4-5 の 2: 「復元できる購入が見つかりませんでした」) */
export class BillingNoPurchaseToRestoreError extends Error {
  constructor() {
    super('復元できる購入が見つかりませんでした');
    this.name = 'BillingNoPurchaseToRestoreError';
  }
}

/** プラン(商品情報)を読み込めなかった(requirements 4-5 の 2: 「プランを読み込めませんでした」+ 再読み込み) */
export class BillingProductsUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('プランを読み込めませんでした');
    this.name = 'BillingProductsUnavailableError';
    this.cause = cause;
  }
}
