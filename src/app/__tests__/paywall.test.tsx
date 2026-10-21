import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveAppAccountToken } from '@shared/index';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Text } from 'react-native';

jest.mock('@/features/account/accountActionService', () => ({
  accountActionService: {
    inspectPending: jest.fn(async () => ({
      checkpoint: null, nativeBlock: null, retryOnly: false,
    })),
    perform: jest.fn(),
    resume: jest.fn(),
  },
}), { virtual: true });

/**
 * 課金画面(4-1b・4-2c)の画面テスト。expo-iap・getCurrentUid・verifyApplePurchase(Cloud Functions 呼び出し層)
 * はモックにし、renderRouter で実際の遷移(購入・復元成功後にBoundaryが指定する画面へ進むこと)を確認する
 * (CLAUDE.md: router のモックで「呼ばれたこと」だけを確かめるテストにしない)。
 *
 * billingClient.test.ts(ユニットテスト)と同じ理由で、'expo-iap' を require する
 * billingClient.ts は renderRouter の呼び出し時(各 it の中)に初めて読み込まれるため、
 * ここでは jest.mock に渡す mockXxx をファイル先頭の通常の import より前に定義すればよい
 * (このファイル自身が billingClient を直接 import していないため、巻き上げ順の問題は起きない)
 */

type Listener<T> = (event: T) => void;

let updatedListener: Listener<unknown> | null = null;
let errorListener: Listener<unknown> | null = null;

const mockInitConnection = jest.fn(async () => true);
const mockFetchProducts = jest.fn();
const mockRequestPurchase = jest.fn(async () => null);
const mockGetAvailablePurchases = jest.fn();
const mockFinishTransaction = jest.fn<Promise<void>, [unknown?]>(async () => undefined);
const mockIsUserCancelledError = jest.fn((error: unknown) => {
  return (error as { code?: string } | null)?.code === 'user-cancelled';
});

jest.mock('expo-iap', () => ({
  initConnection: mockInitConnection,
  fetchProducts: mockFetchProducts,
  requestPurchase: mockRequestPurchase,
  getAvailablePurchases: mockGetAvailablePurchases,
  finishTransaction: mockFinishTransaction,
  isUserCancelledError: mockIsUserCancelledError,
  purchaseUpdatedListener: (listener: Listener<unknown>) => {
    updatedListener = listener;
    return { remove: jest.fn() };
  },
  purchaseErrorListener: (listener: Listener<unknown>) => {
    errorListener = listener;
    return { remove: jest.fn() };
  },
}));

const mockGetCurrentUid = jest.fn((): string | null => 'test-uid');
jest.mock('@/config/firebase', () => ({
  getCurrentUid: mockGetCurrentUid,
  connectFirebaseEmulatorsIfNeeded: jest.fn(),
}));

const mockVerifyApplePurchase = jest.fn();
jest.mock('@/features/billing/verifyPurchase', () => ({
  verifyApplePurchase: mockVerifyApplePurchase,
}));

// Boundaryの判定結果だけを差し替え、routerは実物で遷移する。
// サーバー/cacheの選択ロジックはBoundary側のテストで検証する。
const mockAfterPurchase = jest.fn<Promise<void>, []>();
let mockNextRoute: '/x-link' | '/(tabs)/home' = '/x-link';

jest.mock('@/features/billing/SubscriptionBoundary', () => ({
  useSubscriptionAccess: function useSubscriptionAccess() {
    const { useRouter } =
      jest.requireActual<typeof import('expo-router')>('expo-router');
    const router = useRouter();
    return {
      afterPurchase: async () => {
        await mockAfterPurchase();
        router.replace(mockNextRoute);
      },
    };
  },
}), { virtual: true });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const MONTHLY_PRODUCT_ID = 'com.jime0083.gokakuwatch.premium.monthly';
const YEARLY_PRODUCT_ID = 'com.jime0083.gokakuwatch.premium.yearly';

const MONTHLY_PRODUCT = {
  id: MONTHLY_PRODUCT_ID,
  price: 300,
  displayPrice: '¥300',
  currency: 'JPY',
};
const YEARLY_PRODUCT = {
  id: YEARLY_PRODUCT_ID,
  price: 3000,
  displayPrice: '¥3,000',
  currency: 'JPY',
};

const TEST_APP_ACCOUNT_TOKEN = deriveAppAccountToken('test-uid');

/**
 * renderRouter の初期レンダリングを await act で包む(renderRouter 自体は同期的に返すが、
 * 内部の初期レンダリングが非同期の act を使うため。CLAUDE.md・backNavigation.test.tsx と同じ対策)
 */
async function renderPaywall(): Promise<void> {
  await act(async () => {
    renderRouter({
      paywall: jest.requireActual('../paywall').default,
      'x-link': () => <Text testID="paywall-test-x-link">X連携</Text>,
      '(tabs)/home': () => <Text testID="paywall-test-home">ホーム</Text>,
    }, { initialUrl: '/paywall' });
  });
}

describe('PaywallScreen(4-1b・4-2c。requirements 3-4・4-5 の 2。expo-iap・サーバー確認をモック)', () => {
  beforeEach(() => {
    updatedListener = null;
    errorListener = null;
    mockInitConnection.mockClear();
    mockFetchProducts.mockReset();
    mockRequestPurchase.mockClear();
    mockGetAvailablePurchases.mockReset();
    mockFinishTransaction.mockReset();
    mockFinishTransaction.mockResolvedValue(undefined);
    mockAfterPurchase.mockReset();
    mockAfterPurchase.mockResolvedValue(undefined);
    mockNextRoute = '/x-link';
    mockGetCurrentUid.mockReset();
    mockGetCurrentUid.mockReturnValue('test-uid');
    mockVerifyApplePurchase.mockReset();
    mockVerifyApplePurchase.mockResolvedValue({ status: 'active', expiresAt: Date.now() + 1000000 });
    mockFetchProducts.mockResolvedValue([MONTHLY_PRODUCT, YEARLY_PRODUCT]);
  });

  afterEach(async () => {
    // 全ての既存失敗・取消ケースでもBoundary呼び出しと遷移がないことを確認する。
    if (screen.queryByTestId('paywall-test-x-link') === null &&
        screen.queryByTestId('paywall-test-home') === null) {
      expect(mockAfterPurchase).not.toHaveBeenCalled();
    }
    await cleanup();
    await AsyncStorage.clear();
  });

  it('商品を表示する(価格・年額の「16%お得」・初めはどちらも未選択で購入ボタンが押せない)', async () => {
    await renderPaywall();

    await waitFor(() => screen.getByTestId('paywall-monthly-card-price-text'));
    expect(screen.getByTestId('paywall-monthly-card-price-text').props.children).toBe('¥300');
    expect(screen.getByTestId('paywall-yearly-card-price-text').props.children).toBe('¥3,000');
    expect(screen.getByTestId('paywall-yearly-discount-badge').props.children.join('')).toBe('16%お得');

    expect(screen.getByTestId('paywall-monthly-card').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('paywall-yearly-card').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('paywall-purchase-button').props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    expect(mockRequestPurchase).not.toHaveBeenCalled();
  });

  it.each([
    ['/x-link', 'paywall-test-x-link'],
    ['/(tabs)/home', 'paywall-test-home'],
  ] as const)('購入成功後はBoundaryの判定先%sへ進む', async (route, destination) => {
    mockNextRoute = route;
    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));

    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    expect(screen.getByTestId('paywall-monthly-card').props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));
    expect(mockRequestPurchase).toHaveBeenCalledWith({
      request: { apple: { sku: MONTHLY_PRODUCT_ID, appAccountToken: TEST_APP_ACCOUNT_TOKEN } },
      type: 'subs',
    });

    await waitFor(() => screen.getByTestId('paywall-processing-text'));

    const rawPurchase = {
      id: 'tx-1',
      productId: MONTHLY_PRODUCT_ID,
      originalTransactionIdentifierIOS: 'orig-1',
      purchaseToken: 'jws-1',
    };
    updatedListener?.(rawPurchase);

    await waitFor(() => expect(mockVerifyApplePurchase).toHaveBeenCalledWith('tx-1'));
    await waitFor(() => screen.getByTestId(destination));
    expect(mockAfterPurchase).toHaveBeenCalledTimes(1);
    expect(mockFinishTransaction).toHaveBeenCalledWith({ purchase: rawPurchase, isConsumable: false });
  });

  it('購入をキャンセルすると何も表示せず課金画面のまま', async () => {
    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));

    errorListener?.({ code: 'user-cancelled', message: 'cancelled' });

    await waitFor(() =>
      expect(screen.getByTestId('paywall-purchase-button').props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByTestId('paywall-action-error-text')).toBeNull();
  });

  it('購入に失敗したら「購入できませんでした。時間をおいてもう一度お試しください」を表示する', async () => {
    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));

    errorListener?.({ code: 'network-error', message: 'network' });

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入できませんでした。時間をおいてもう一度お試しください',
    );
  });

  it('requestPurchase 自体が直接失敗し、どちらのリスナーも呼ばれない場合も「購入できませんでした...」を表示し処理中が解除される(P-023)', async () => {
    mockRequestPurchase.mockRejectedValueOnce(new Error('NotPrepared'));

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入できませんでした。時間をおいてもう一度お試しください',
    );
    expect(screen.queryByTestId('paywall-processing-text')).toBeNull();
    expect(screen.getByTestId('paywall-purchase-button').props.accessibilityState.disabled).toBe(false);
  });

  it('ログインしていない場合は購入を始めず「購入できませんでした...」を表示する', async () => {
    mockGetCurrentUid.mockReturnValue(null);

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入できませんでした。時間をおいてもう一度お試しください',
    );
    expect(mockRequestPurchase).not.toHaveBeenCalled();
    expect(screen.queryByTestId('paywall-processing-text')).toBeNull();
  });

  it('購入の確認ができない場合は finishTransaction せず「購入の確認ができませんでした...」を表示する', async () => {
    mockVerifyApplePurchase.mockResolvedValue({ status: 'verification-unavailable' });

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));

    updatedListener?.({
      id: 'tx-1',
      productId: MONTHLY_PRODUCT_ID,
      originalTransactionIdentifierIOS: 'orig-1',
      purchaseToken: 'jws-1',
    });

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入の確認ができませんでした。通信状況を確認して「購入の復元」をお試しください',
    );
    expect(mockFinishTransaction).not.toHaveBeenCalled();
  });

  it('購入が別のアカウントで利用されている場合は「この購入は別のアカウントで利用されています」を表示する', async () => {
    mockVerifyApplePurchase.mockResolvedValue({ status: 'owned-by-other-account' });

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));

    updatedListener?.({
      id: 'tx-1',
      productId: MONTHLY_PRODUCT_ID,
      originalTransactionIdentifierIOS: 'orig-1',
      purchaseToken: 'jws-1',
    });

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      'この購入は別のアカウントで利用されています',
    );
    expect(mockFinishTransaction).not.toHaveBeenCalled();
  });

  it('不正な取引の場合は「購入できませんでした。時間をおいてもう一度お試しください」を表示する', async () => {
    mockVerifyApplePurchase.mockResolvedValue({ status: 'invalid-transaction' });

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
    await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
    await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));

    updatedListener?.({
      id: 'tx-1',
      productId: MONTHLY_PRODUCT_ID,
      originalTransactionIdentifierIOS: 'orig-1',
      purchaseToken: 'jws-1',
    });

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入できませんでした。時間をおいてもう一度お試しください',
    );
    expect(mockFinishTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['/x-link', 'paywall-test-x-link'],
    ['/(tabs)/home', 'paywall-test-home'],
  ] as const)('復元成功後はBoundaryの判定先%sへ進む', async (route, destination) => {
    mockNextRoute = route;
    const rawPurchase = {
      id: 'tx-restore',
      productId: YEARLY_PRODUCT_ID,
      originalTransactionIdentifierIOS: 'orig-restore',
      purchaseToken: 'jws-restore',
    };
    mockGetAvailablePurchases.mockResolvedValueOnce([rawPurchase]);

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-restore-button'));
    await fireEvent.press(screen.getByTestId('paywall-restore-button'));

    await waitFor(() => expect(mockVerifyApplePurchase).toHaveBeenCalledWith('tx-restore'));
    await waitFor(() => screen.getByTestId(destination));
    expect(mockAfterPurchase).toHaveBeenCalledTimes(1);
    expect(mockFinishTransaction).toHaveBeenCalledWith({ purchase: rawPurchase, isConsumable: false });
  });

  it('復元した取引が期限切れの場合は「有効なサブスクリプションが見つかりませんでした。プランを選んで購入してください」を表示する', async () => {
    mockGetAvailablePurchases.mockResolvedValueOnce([
      {
        id: 'tx-restore',
        productId: YEARLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-restore',
        purchaseToken: 'jws-restore',
      },
    ]);
    mockVerifyApplePurchase.mockResolvedValue({ status: 'expired', expiresAt: Date.now() - 1000 });

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-restore-button'));
    await fireEvent.press(screen.getByTestId('paywall-restore-button'));

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '有効なサブスクリプションが見つかりませんでした。プランを選んで購入してください',
    );
    expect(mockFinishTransaction).not.toHaveBeenCalled();
  });

  it('復元できる購入が見つからない場合は「復元できる購入が見つかりませんでした」を表示する', async () => {
    mockGetAvailablePurchases.mockResolvedValueOnce([]);

    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-restore-button'));
    await fireEvent.press(screen.getByTestId('paywall-restore-button'));

    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '復元できる購入が見つかりませんでした',
    );
  });

  it('プランを読み込めない場合は「プランを読み込めませんでした」と再読み込みボタンを表示し、押すと再取得する', async () => {
    mockFetchProducts.mockReset();
    mockFetchProducts.mockResolvedValueOnce([]);

    await renderPaywall();

    await waitFor(() => screen.getByTestId('paywall-error-text'));
    expect(screen.getByTestId('paywall-error-text').props.children).toBe('プランを読み込めませんでした');
    expect(screen.queryByTestId('paywall-purchase-button')).toBeNull();

    mockFetchProducts.mockResolvedValueOnce([MONTHLY_PRODUCT, YEARLY_PRODUCT]);
    await fireEvent.press(screen.getByTestId('paywall-reload-button'));

    await waitFor(() => screen.getByTestId('paywall-monthly-card'));
    expect(mockFetchProducts).toHaveBeenCalledTimes(2);
  });

  it.each(['purchase', 'restore'] as const)(
    '%sはactive確認→finish完了→Boundary完了の順で進み、待機中は操作できない',
    async (action) => {
      const verification = deferred<{ status: 'active'; expiresAt: number }>();
      const finish = deferred<void>();
      const boundary = deferred<void>();
      const rawPurchase = {
        id: 'tx-order',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-order',
        purchaseToken: 'jws-order',
      };
      mockVerifyApplePurchase.mockReturnValueOnce(verification.promise);
      mockFinishTransaction.mockReturnValueOnce(finish.promise);
      mockAfterPurchase.mockReturnValueOnce(boundary.promise);
      mockGetAvailablePurchases.mockResolvedValueOnce([rawPurchase]);

      await renderPaywall();
      await waitFor(() => screen.getByTestId('paywall-monthly-card'));
      await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
      if (action === 'purchase') {
        await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
        await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));
        await act(async () => { updatedListener?.(rawPurchase); });
      } else {
        await fireEvent.press(screen.getByTestId('paywall-restore-button'));
      }
      await waitFor(() => expect(mockVerifyApplePurchase).toHaveBeenCalledTimes(1));
      expect(mockFinishTransaction).not.toHaveBeenCalled();
      expect(mockAfterPurchase).not.toHaveBeenCalled();

      await act(async () => {
        verification.resolve({ status: 'active', expiresAt: Date.now() + 1000000 });
      });
      await waitFor(() => expect(mockFinishTransaction).toHaveBeenCalledTimes(1));
      expect(mockAfterPurchase).not.toHaveBeenCalled();
      expect(screen.getByTestId('paywall-purchase-button')).toBeDisabled();
      expect(screen.getByTestId('paywall-restore-button')).toBeDisabled();

      await act(async () => { finish.resolve(undefined); });
      await waitFor(() => expect(mockAfterPurchase).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('paywall-processing-text')).toBeTruthy();
      expect(screen.queryByTestId('paywall-test-x-link')).toBeNull();

      await act(async () => { boundary.resolve(undefined); });
      await waitFor(() => screen.getByTestId('paywall-test-x-link'));
    },
  );

  it.each(['purchase', 'restore'] as const)(
    '%sのfinish失敗時は既存のエラー表示で留まりBoundaryを呼ばない',
    async (action) => {
      const rawPurchase = {
        id: 'tx-finish-failed',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-finish-failed',
        purchaseToken: 'jws-finish-failed',
      };
      mockFinishTransaction.mockRejectedValueOnce(
        new Error('購入できませんでした。時間をおいてもう一度お試しください'),
      );
      mockGetAvailablePurchases.mockResolvedValueOnce([rawPurchase]);
      await renderPaywall();
      await waitFor(() => screen.getByTestId('paywall-monthly-card'));
      await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
      if (action === 'purchase') {
        await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
        await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));
        await act(async () => { updatedListener?.(rawPurchase); });
      } else {
        await fireEvent.press(screen.getByTestId('paywall-restore-button'));
      }
      await waitFor(() => screen.getByTestId('paywall-action-error-text'));
      expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
        '購入できませんでした。時間をおいてもう一度お試しください',
      );
      expect(mockAfterPurchase).not.toHaveBeenCalled();
      expect(screen.getByTestId('paywall-purchase-button')).not.toBeDisabled();
      expect(screen.getByTestId('paywall-restore-button')).not.toBeDisabled();
    },
  );

  it.each([
    ['purchase', 'result'],
    ['purchase', 'verify'],
    ['purchase', 'finish'],
    ['restore', 'result'],
    ['restore', 'verify'],
    ['restore', 'finish'],
  ] as const)(
    '%sの%s待機中にUIDが変わると後続処理を止める',
    async (action, phase) => {
      const restored = deferred<unknown[]>();
      const verification = deferred<{ status: 'active'; expiresAt: number }>();
      const finish = deferred<void>();
      const rawPurchase = {
        id: 'tx-uid',
        productId: MONTHLY_PRODUCT_ID,
        originalTransactionIdentifierIOS: 'orig-uid',
        purchaseToken: 'jws-uid',
      };
      const active = { status: 'active' as const, expiresAt: Date.now() + 1000000 };
      mockGetAvailablePurchases.mockReturnValueOnce(restored.promise);
      mockVerifyApplePurchase.mockReturnValueOnce(verification.promise);
      mockFinishTransaction.mockReturnValueOnce(finish.promise);

      await renderPaywall();
      await waitFor(() => screen.getByTestId('paywall-monthly-card'));
      await fireEvent.press(screen.getByTestId('paywall-monthly-card'));
      if (action === 'purchase') {
        await fireEvent.press(screen.getByTestId('paywall-purchase-button'));
        await waitFor(() => expect(mockRequestPurchase).toHaveBeenCalledTimes(1));
      } else {
        await fireEvent.press(screen.getByTestId('paywall-restore-button'));
        await waitFor(() => expect(mockGetAvailablePurchases).toHaveBeenCalledTimes(1));
      }

      if (phase === 'result') mockGetCurrentUid.mockReturnValue('other-uid');
      await act(async () => {
        if (action === 'purchase') updatedListener?.(rawPurchase);
        else restored.resolve([rawPurchase]);
      });

      if (phase !== 'result') {
        await waitFor(() => expect(mockVerifyApplePurchase).toHaveBeenCalledTimes(1));
        if (phase === 'verify') mockGetCurrentUid.mockReturnValue('other-uid');
        await act(async () => { verification.resolve(active); });
      }
      if (phase === 'finish') {
        await waitFor(() => expect(mockFinishTransaction).toHaveBeenCalledTimes(1));
        mockGetCurrentUid.mockReturnValue('other-uid');
        await act(async () => { finish.resolve(undefined); });
      }

      await waitFor(() => screen.getByTestId('paywall-action-error-text'));
      expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
        '購入できませんでした。時間をおいてもう一度お試しください',
      );
      expect(mockVerifyApplePurchase).toHaveBeenCalledTimes(phase === 'result' ? 0 : 1);
      expect(mockFinishTransaction).toHaveBeenCalledTimes(phase === 'finish' ? 1 : 0);
      expect(mockAfterPurchase).not.toHaveBeenCalled();
      expect(screen.queryByTestId('paywall-processing-text')).toBeNull();
      expect(screen.getByTestId('paywall-purchase-button')).not.toBeDisabled();
      expect(screen.getByTestId('paywall-restore-button')).not.toBeDisabled();
    },
  );

  it('未ログインでは復元も開始しない', async () => {
    mockGetCurrentUid.mockReturnValue(null);
    await renderPaywall();
    await waitFor(() => screen.getByTestId('paywall-restore-button'));
    await fireEvent.press(screen.getByTestId('paywall-restore-button'));
    await waitFor(() => screen.getByTestId('paywall-action-error-text'));
    expect(screen.getByTestId('paywall-action-error-text').props.children).toBe(
      '購入できませんでした。時間をおいてもう一度お試しください',
    );
    expect(mockGetAvailablePurchases).not.toHaveBeenCalled();
    expect(mockVerifyApplePurchase).not.toHaveBeenCalled();
    expect(mockFinishTransaction).not.toHaveBeenCalled();
    expect(mockAfterPurchase).not.toHaveBeenCalled();
  });
});
