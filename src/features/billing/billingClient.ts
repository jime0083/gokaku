/**
 * expo-iap(StoreKit 2)を呼ぶ薄い層(4-1b)。画面(src/app/paywall.tsx)はこのモジュールの
 * 関数だけを呼び、expo-iap を直接呼ばない(テストで `jest.mock('expo-iap', ...)` に差し替えられるようにする)。
 *
 * 4-1a(dev-iap-probe.tsx)で確かめた expo-iap の動き方に合わせる:
 * - fetchProducts は商品一覧を返す(StoreKit 設定ファイルが無効だと0件。problem P-022)
 * - requestPurchase 自身の戻り値は当てにせず、purchaseUpdatedListener / purchaseErrorListener の
 *   イベントで結果を受け取る
 */
import {
  type Purchase,
  type ProductSubscription,
  fetchProducts as fetchIapProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  isUserCancelledError,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap';

import {
  BillingCancelledError,
  BillingNoPurchaseToRestoreError,
  BillingProductsUnavailableError,
  BillingPurchaseFailedError,
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
  isKnownAppleIapProductId,
  type BillingPlan,
  type BillingProduct,
  type BillingPurchaseResult,
} from './types';

const PLAN_BY_PRODUCT_ID: Record<string, BillingPlan> = {
  [MONTHLY_PRODUCT_ID]: 'monthly',
  [YEARLY_PRODUCT_ID]: 'yearly',
};

let connected = false;

async function ensureConnected(): Promise<void> {
  if (connected) {
    return;
  }
  await initConnection();
  connected = true;
}

function toBillingProduct(product: ProductSubscription): BillingProduct | null {
  const plan = PLAN_BY_PRODUCT_ID[product.id];
  if (!plan || typeof product.price !== 'number') {
    return null;
  }
  return {
    plan,
    productId: product.id,
    price: product.price,
    displayPrice: product.displayPrice,
    currency: product.currency,
  };
}

function toPurchaseResult(purchase: Purchase): BillingPurchaseResult {
  const originalTransactionIdentifierIOS =
    'originalTransactionIdentifierIOS' in purchase
      ? (purchase.originalTransactionIdentifierIOS ?? null)
      : null;
  return {
    productId: purchase.productId,
    transactionId: purchase.id,
    originalTransactionIdentifierIOS,
    purchaseToken: purchase.purchaseToken ?? null,
    rawPurchase: purchase,
  };
}

/** 月額・年額の商品情報を取得する。両方そろわない場合は BillingProductsUnavailableError */
export async function fetchBillingProducts(): Promise<BillingProduct[]> {
  try {
    await ensureConnected();
    const result = await fetchIapProducts({
      skus: [MONTHLY_PRODUCT_ID, YEARLY_PRODUCT_ID],
      type: 'subs',
    });
    const list = (result ?? []) as ProductSubscription[];
    const products = list
      .map(toBillingProduct)
      .filter((product): product is BillingProduct => product !== null);
    const hasMonthly = products.some((product) => product.plan === 'monthly');
    const hasYearly = products.some((product) => product.plan === 'yearly');
    if (!hasMonthly || !hasYearly) {
      throw new BillingProductsUnavailableError();
    }
    return products;
  } catch (error) {
    if (error instanceof BillingProductsUnavailableError) {
      throw error;
    }
    throw new BillingProductsUnavailableError(error);
  }
}

/**
 * 指定した商品を購入する。appAccountToken(購入の持ち主を確認するための値。requirements 3-4)を
 * request.apple.appAccountToken に渡す(4-2c)。
 * 成功: BillingPurchaseResult で解決。キャンセル: BillingCancelledError。それ以外の失敗: BillingPurchaseFailedError
 */
export async function purchaseBillingProduct(
  productId: string,
  appAccountToken: string,
): Promise<BillingPurchaseResult> {
  await ensureConnected();

  return new Promise<BillingPurchaseResult>((resolve, reject) => {
    let settled = false;

    const updatedSubscription = purchaseUpdatedListener((purchase) => {
      if (settled || purchase.productId !== productId) {
        return;
      }
      settled = true;
      updatedSubscription.remove();
      errorSubscription.remove();
      resolve(toPurchaseResult(purchase));
    });

    const errorSubscription = purchaseErrorListener((error) => {
      if (settled) {
        return;
      }
      settled = true;
      updatedSubscription.remove();
      errorSubscription.remove();
      if (isUserCancelledError(error)) {
        reject(new BillingCancelledError());
      } else {
        reject(new BillingPurchaseFailedError(error));
      }
    });

    requestPurchase({
      request: { apple: { sku: productId, appAccountToken } },
      type: 'subs',
    }).catch((error: unknown) => {
      // 通常は purchaseErrorListener 側で拾う(4-1a dev-iap-probe.tsx で確認した expo-iap の動き)が、
      // expo-iap の型定義にある通り requestPurchase 自身が直接失敗する場合もある(problem P-023)。
      // その場合リスナーは呼ばれないため、ここで決着させないと Promise が解決しないまま残る
      if (settled) {
        return;
      }
      settled = true;
      updatedSubscription.remove();
      errorSubscription.remove();
      if (isUserCancelledError(error)) {
        reject(new BillingCancelledError());
      } else {
        reject(new BillingPurchaseFailedError(error));
      }
    });
  });
}

/**
 * 購入済みの取引を復元する。このアプリの製品(MONTHLY_PRODUCT_ID・YEARLY_PRODUCT_ID)の取引のみを対象にし、
 * 一番新しい取引(transactionDate が最大のもの)を先頭にして返す(requirements 3-4)。
 * 何もない場合は BillingNoPurchaseToRestoreError
 */
export async function restoreBillingPurchases(): Promise<BillingPurchaseResult[]> {
  await ensureConnected();

  let purchases: Purchase[];
  try {
    purchases = await getAvailablePurchases();
  } catch (error) {
    throw new BillingPurchaseFailedError(error);
  }

  const relevant = (purchases ?? []).filter((purchase) => isKnownAppleIapProductId(purchase.productId));
  if (relevant.length === 0) {
    throw new BillingNoPurchaseToRestoreError();
  }

  const sorted = [...relevant].sort((a, b) => (b.transactionDate ?? 0) - (a.transactionDate ?? 0));
  return sorted.map(toPurchaseResult);
}

/**
 * 購入の完了処理(finishTransaction)。サーバーで購入を確認できた後にだけ呼ぶ(4-2c。requirements 3-4)。
 * billingClient の外は expo-iap の Purchase オブジェクトを直接扱わないよう、ここに閉じ込める
 */
export async function finishPurchaseTransaction(result: BillingPurchaseResult): Promise<void> {
  await finishTransaction({ purchase: result.rawPurchase as Purchase, isConsumable: false });
}
