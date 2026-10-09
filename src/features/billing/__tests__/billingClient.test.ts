import {
  BillingCancelledError,
  BillingNoPurchaseToRestoreError,
  BillingProductsUnavailableError,
  BillingPurchaseFailedError,
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
} from '@/features/billing/types';

type Listener<T> = (event: T) => void;

let updatedListener: Listener<unknown> | null = null;
let errorListener: Listener<unknown> | null = null;

const mockInitConnection = jest.fn(async () => true);
const mockFetchProducts = jest.fn();
const mockRequestPurchase = jest.fn(async () => null);
const mockGetAvailablePurchases = jest.fn();
const mockFinishTransaction = jest.fn(async () => undefined);
const mockIsUserCancelledError = jest.fn((error: unknown) => {
  return (error as { code?: string } | null)?.code === 'user-cancelled';
});
const mockRemoveUpdatedListener = jest.fn();
const mockRemoveErrorListener = jest.fn();

jest.mock('expo-iap', () => ({
  initConnection: mockInitConnection,
  fetchProducts: mockFetchProducts,
  requestPurchase: mockRequestPurchase,
  getAvailablePurchases: mockGetAvailablePurchases,
  finishTransaction: mockFinishTransaction,
  isUserCancelledError: mockIsUserCancelledError,
  purchaseUpdatedListener: (listener: Listener<unknown>) => {
    updatedListener = listener;
    return { remove: mockRemoveUpdatedListener };
  },
  purchaseErrorListener: (listener: Listener<unknown>) => {
    errorListener = listener;
    return { remove: mockRemoveErrorListener };
  },
}));

// billingClient.ts は内部で 'expo-iap' を import するため、通常の import 文で読み込むと
// (ES import は Babel によってファイル先頭に巻き上げられるため)上の mockXxx の代入より先に
// 'expo-iap' が require され、モックの関数がまだ代入されていない状態で factory が呼ばれてしまう。
// そのため mockXxx の代入が終わった後に実行される通常の require で読み込む
// eslint-disable-next-line @typescript-eslint/no-require-imports
const billingClient = require('@/features/billing/billingClient') as typeof import('@/features/billing/billingClient');

describe('billingClient(4-1b。expo-iap をモック)', () => {
  beforeEach(() => {
    updatedListener = null;
    errorListener = null;
    mockInitConnection.mockClear();
    mockFetchProducts.mockClear();
    mockRequestPurchase.mockClear();
    mockGetAvailablePurchases.mockClear();
    mockFinishTransaction.mockClear();
    mockRemoveUpdatedListener.mockClear();
    mockRemoveErrorListener.mockClear();
  });

  describe('fetchBillingProducts', () => {
    it('月額・年額がそろえば BillingProduct に変換する', async () => {
      mockFetchProducts.mockResolvedValueOnce([
        {
          id: MONTHLY_PRODUCT_ID,
          price: 300,
          displayPrice: '¥300',
          currency: 'JPY',
        },
        {
          id: YEARLY_PRODUCT_ID,
          price: 3000,
          displayPrice: '¥3,000',
          currency: 'JPY',
        },
      ]);

      const products = await billingClient.fetchBillingProducts();

      expect(products).toEqual([
        { plan: 'monthly', productId: MONTHLY_PRODUCT_ID, price: 300, displayPrice: '¥300', currency: 'JPY' },
        { plan: 'yearly', productId: YEARLY_PRODUCT_ID, price: 3000, displayPrice: '¥3,000', currency: 'JPY' },
      ]);
    });

    it('0件(problem P-022)なら BillingProductsUnavailableError', async () => {
      mockFetchProducts.mockResolvedValueOnce([]);
      await expect(billingClient.fetchBillingProducts()).rejects.toBeInstanceOf(
        BillingProductsUnavailableError,
      );
    });

    it('片方しか取得できない場合も BillingProductsUnavailableError', async () => {
      mockFetchProducts.mockResolvedValueOnce([
        { id: MONTHLY_PRODUCT_ID, price: 300, displayPrice: '¥300', currency: 'JPY' },
      ]);
      await expect(billingClient.fetchBillingProducts()).rejects.toBeInstanceOf(
        BillingProductsUnavailableError,
      );
    });

    it('fetchProducts が失敗した場合も BillingProductsUnavailableError', async () => {
      mockFetchProducts.mockRejectedValueOnce(new Error('network'));
      await expect(billingClient.fetchBillingProducts()).rejects.toBeInstanceOf(
        BillingProductsUnavailableError,
      );
    });
  });

  const APP_ACCOUNT_TOKEN = 'test-app-account-token';

  describe('purchaseBillingProduct', () => {
    it('appAccountToken を request.apple.appAccountToken に渡す', async () => {
      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRequestPurchase).toHaveBeenCalledWith({
        request: { apple: { sku: MONTHLY_PRODUCT_ID, appAccountToken: APP_ACCOUNT_TOKEN } },
        type: 'subs',
      });

      updatedListener?.({
        id: 'tx-1',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-1',
        purchaseToken: 'jws-1',
      });
      await promise;
    });

    it('purchaseUpdatedListener が同じ productId を通知したら解決する(rawPurchase に元のオブジェクトを含む)', async () => {
      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();

      const rawPurchase = {
        id: 'tx-1',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-1',
        purchaseToken: 'jws-1',
      };
      updatedListener?.(rawPurchase);

      await expect(promise).resolves.toEqual({
        productId: MONTHLY_PRODUCT_ID,
        transactionId: 'tx-1',
        originalTransactionIdentifierIOS: 'orig-1',
        purchaseToken: 'jws-1',
        rawPurchase,
      });
    });

    it('ユーザーキャンセルは BillingCancelledError', async () => {
      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();

      errorListener?.({ code: 'user-cancelled', message: 'cancelled' });

      await expect(promise).rejects.toBeInstanceOf(BillingCancelledError);
    });

    it('それ以外の失敗は BillingPurchaseFailedError', async () => {
      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();

      errorListener?.({ code: 'network-error', message: 'network' });

      await expect(promise).rejects.toBeInstanceOf(BillingPurchaseFailedError);
    });

    it('requestPurchase が直接失敗し、どちらのリスナーも呼ばれない場合は BillingPurchaseFailedError(P-023)', async () => {
      mockRequestPurchase.mockRejectedValueOnce(new Error('NotPrepared'));

      await expect(
        billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN),
      ).rejects.toBeInstanceOf(BillingPurchaseFailedError);
    });

    it('requestPurchase が直接失敗し、キャンセルのエラーなら BillingCancelledError(P-023)', async () => {
      mockRequestPurchase.mockRejectedValueOnce({ code: 'user-cancelled', message: 'cancelled' });

      await expect(
        billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN),
      ).rejects.toBeInstanceOf(BillingCancelledError);
    });

    it('requestPurchase の直接失敗と errorListener の両方が来ても1回だけ決着し、リスナーを remove する(P-023)', async () => {
      mockRequestPurchase.mockRejectedValueOnce(new Error('NotPrepared'));

      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // requestPurchase の直接失敗で決着した後に errorListener が届いても無視される(settled ガード)
      errorListener?.({ code: 'network-error', message: 'network' });

      await expect(promise).rejects.toBeInstanceOf(BillingPurchaseFailedError);
      expect(mockRemoveUpdatedListener).toHaveBeenCalledTimes(1);
      expect(mockRemoveErrorListener).toHaveBeenCalledTimes(1);
    });

    it('別の productId の通知は無視する', async () => {
      const promise = billingClient.purchaseBillingProduct(MONTHLY_PRODUCT_ID, APP_ACCOUNT_TOKEN);
      await Promise.resolve();
      await Promise.resolve();

      updatedListener?.({
        id: 'tx-other',
        productId: YEARLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: null,
        purchaseToken: 'jws-other',
      });
      updatedListener?.({
        id: 'tx-2',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: null,
        purchaseToken: 'jws-2',
      });

      await expect(promise).resolves.toMatchObject({ transactionId: 'tx-2' });
    });
  });

  describe('restoreBillingPurchases', () => {
    it('復元できる購入があれば BillingPurchaseResult の配列を返す(rawPurchase に元のオブジェクトを含む)', async () => {
      const rawPurchase = {
        id: 'tx-3',
        productId: YEARLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-3',
        purchaseToken: 'jws-3',
      };
      mockGetAvailablePurchases.mockResolvedValueOnce([rawPurchase]);

      const results = await billingClient.restoreBillingPurchases();

      expect(results).toEqual([
        {
          productId: YEARLY_PRODUCT_ID,
          transactionId: 'tx-3',
          originalTransactionIdentifierIOS: 'orig-3',
          purchaseToken: 'jws-3',
          rawPurchase,
        },
      ]);
    });

    it('このアプリの製品で一番新しい取引(transactionDate が最大)を先頭にする(requirements 3-4)', async () => {
      mockGetAvailablePurchases.mockResolvedValueOnce([
        {
          id: 'tx-old',
          productId: MONTHLY_PRODUCT_ID,
          transactionDate: 1000,
          originalTransactionIdentifierIOS: 'orig-old',
          purchaseToken: 'jws-old',
        },
        {
          id: 'tx-new',
          productId: YEARLY_PRODUCT_ID,
          transactionDate: 2000,
          originalTransactionIdentifierIOS: 'orig-new',
          purchaseToken: 'jws-new',
        },
      ]);

      const results = await billingClient.restoreBillingPurchases();

      expect(results.map((result) => result.transactionId)).toEqual(['tx-new', 'tx-old']);
    });

    it('このアプリの製品以外の取引は無視する', async () => {
      mockGetAvailablePurchases.mockResolvedValueOnce([
        {
          id: 'tx-foreign',
          productId: 'com.example.other-app.product',
          originalTransactionIdentifierIOS: 'orig-foreign',
          purchaseToken: 'jws-foreign',
        },
      ]);

      await expect(billingClient.restoreBillingPurchases()).rejects.toBeInstanceOf(
        BillingNoPurchaseToRestoreError,
      );
    });

    it('復元できる購入がなければ BillingNoPurchaseToRestoreError', async () => {
      mockGetAvailablePurchases.mockResolvedValueOnce([]);
      await expect(billingClient.restoreBillingPurchases()).rejects.toBeInstanceOf(
        BillingNoPurchaseToRestoreError,
      );
    });

    it('getAvailablePurchases が失敗したら BillingPurchaseFailedError', async () => {
      mockGetAvailablePurchases.mockRejectedValueOnce(new Error('network'));
      await expect(billingClient.restoreBillingPurchases()).rejects.toBeInstanceOf(
        BillingPurchaseFailedError,
      );
    });
  });

  describe('finishPurchaseTransaction', () => {
    it('rawPurchase を expo-iap の finishTransaction にそのまま渡す(isConsumable: false)', async () => {
      const rawPurchase = {
        id: 'tx-1',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-1',
        purchaseToken: 'jws-1',
      };

      await billingClient.finishPurchaseTransaction({
        productId: MONTHLY_PRODUCT_ID,
        transactionId: 'tx-1',
        originalTransactionIdentifierIOS: 'orig-1',
        purchaseToken: 'jws-1',
        rawPurchase,
      });

      expect(mockFinishTransaction).toHaveBeenCalledWith({ purchase: rawPurchase, isConsumable: false });
    });
  });
});
