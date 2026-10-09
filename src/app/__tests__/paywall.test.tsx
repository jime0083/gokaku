import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveAppAccountToken } from '@shared/index';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/**
 * 課金画面(4-1b・4-2c)の画面テスト。expo-iap・getCurrentUid・verifyApplePurchase(Cloud Functions 呼び出し層)
 * はモックにし、renderRouter で実際の遷移(購入・復元成功後に仮の次の画面へ進むこと)を確認する
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
const mockFinishTransaction = jest.fn(async () => undefined);
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
    renderRouter('src/app', { initialUrl: '/paywall' });
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
    mockFinishTransaction.mockClear();
    mockGetCurrentUid.mockReset();
    mockGetCurrentUid.mockReturnValue('test-uid');
    mockVerifyApplePurchase.mockReset();
    mockVerifyApplePurchase.mockResolvedValue({ status: 'active', expiresAt: Date.now() + 1000000 });
    mockFetchProducts.mockResolvedValue([MONTHLY_PRODUCT, YEARLY_PRODUCT]);
  });

  afterEach(async () => {
    cleanup();
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

  it('プランを選んで購入に成功し、サーバー確認が active なら finishTransaction して仮の次の画面(初回起動画面)へ進む', async () => {
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
    await waitFor(() => screen.getByTestId('onboarding-start-button'));
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

  it('購入の復元に成功し、サーバー確認が active なら finishTransaction して仮の次の画面(初回起動画面)へ進む', async () => {
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
    await waitFor(() => screen.getByTestId('onboarding-start-button'));
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
});
