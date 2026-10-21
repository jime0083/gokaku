import { isKnownAppleIapProductId, type BillingPurchaseResult } from './types';
import type { VerifyPurchaseResult } from './verifyPurchase';

export type PendingPurchaseRecoveryDependencies = {
  getUid: () => string | null;
  loadPending: () => Promise<BillingPurchaseResult[]>;
  verify: (transactionId: string) => Promise<VerifyPurchaseResult>;
  finish: (purchase: BillingPurchaseResult) => Promise<void>;
};

/** 復旧の集計のみ。契約状態・画面遷移・利用可否の判定には使わない。 */
export type PendingPurchaseRecoverySummary = {
  finished: number;
  /** サーバー確認失敗または完了処理失敗の件数。取引は次回再確認する。 */
  failed: number;
  /** 未知の商品、空の取引ID、同一実行内の重複、期限切れの件数。 */
  skipped: number;
  /** UID不一致・取得不能により以降の処理を中断した。 */
  aborted: boolean;
  /** 未完了取引の一覧を取得できなかった。 */
  loadFailed: boolean;
};

/**
 * 既知の未完了購入を順番にサーバー確認し、active の取引だけを完了する。
 * 失敗・期限切れは未完了のまま残す。処理済みIDはこの呼出内だけで保持する。
 * 起動時の復旧失敗と既存契約による利用可否の判定は独立している(requirements 3-4)。
 */
export async function recoverPendingPurchases(
  expectedUid: string,
  deps: PendingPurchaseRecoveryDependencies,
): Promise<PendingPurchaseRecoverySummary> {
  const summary: PendingPurchaseRecoverySummary = {
    finished: 0,
    failed: 0,
    skipped: 0,
    aborted: false,
    loadFailed: false,
  };

  const hasExpectedUid = (): boolean => {
    try {
      return expectedUid.trim().length > 0 && deps.getUid() === expectedUid;
    } catch {
      return false;
    }
  };

  const shouldAbort = (): boolean => {
    if (hasExpectedUid()) {
      return false;
    }
    summary.aborted = true;
    return true;
  };

  if (shouldAbort()) {
    return summary;
  }

  let purchases: BillingPurchaseResult[];
  try {
    purchases = await deps.loadPending();
  } catch {
    summary.loadFailed = true;
    shouldAbort();
    return summary;
  }

  if (shouldAbort()) {
    return summary;
  }

  const seen = new Set<string>();
  for (const purchase of purchases) {
    if (shouldAbort()) {
      return summary;
    }
    if (
      !isKnownAppleIapProductId(purchase.productId) ||
      purchase.transactionId.trim().length === 0 ||
      seen.has(purchase.transactionId)
    ) {
      summary.skipped += 1;
      continue;
    }
    seen.add(purchase.transactionId);

    let outcome: VerifyPurchaseResult;
    try {
      outcome = await deps.verify(purchase.transactionId);
    } catch {
      summary.failed += 1;
      if (shouldAbort()) {
        return summary;
      }
      continue;
    }

    if (shouldAbort()) {
      return summary;
    }
    if (outcome.status !== 'active') {
      if (outcome.status === 'expired') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
      }
      continue;
    }

    // 直前のUID確認とfinish呼出の間にはawaitを置かない。
    try {
      await deps.finish(purchase);
      summary.finished += 1;
    } catch {
      summary.failed += 1;
    }

    if (shouldAbort()) {
      return summary;
    }
  }
  return summary;
}

/**
 * 起動時の本番接続。呼出側はこのPromiseをawaitする。
 * 復旧失敗は次回へ持ち越し、既存契約による利用可否の判定には影響させない。
 */
export async function recoverStartupPurchases(expectedUid: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentUid } = require('@/config/firebase') as typeof import('@/config/firebase');
    if (expectedUid.trim().length === 0 || getCurrentUid() !== expectedUid) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { accountOperationGate } = require('@/features/account/accountOperationRuntime') as typeof import('@/features/account/accountOperationRuntime');

    await accountOperationGate.runNormal(expectedUid, async (lease) => {
      const assertCurrent = (): void => {
        lease.assertCurrentUid();
        if (getCurrentUid() !== expectedUid) {
          throw new Error('uid-changed');
        }
      };
      assertCurrent();

      // Native/Callableのモジュール読込みもgateへの入場後に限定する。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadPendingBillingPurchases, finishPurchaseTransaction } = require('./billingClient') as typeof import('./billingClient');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { verifyApplePurchase } = require('./verifyPurchase') as typeof import('./verifyPurchase');

      const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
        assertCurrent();
        try {
          return await operation();
        } finally {
          assertCurrent();
        }
      };

      await recoverPendingPurchases(expectedUid, {
        getUid: () => {
          assertCurrent();
          return getCurrentUid();
        },
        loadPending: () => guarded(() => loadPendingBillingPurchases()),
        verify: (transactionId) => guarded(() => verifyApplePurchase(transactionId)),
        finish: (purchase) => guarded(() => finishPurchaseTransaction(purchase)),
      });
      assertCurrent();
    });
  } catch {
    // 入場拒否・UID変更・復旧失敗は外へ返さず、未完了取引を次回再確認する。
  }
}
