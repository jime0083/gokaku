/**
 * verifyApplePurchase(4-2c。Cloud Functions の verifyApplePurchase を呼ぶ層)のユニットテスト。
 * @react-native-firebase/app・functions と @/config/firebase を丸ごとモックに差し替え、
 * HttpsError の code・details.reason から画面向けの結果への変換を確認する(4-2c-0 で確かめた形)。
 *
 * verifyPurchase.ts は '@/config/firebase' を(RNFB とは違い)モジュール先頭で通常の import をしているため、
 * テスト対象を ES import で読み込むと、babel の ESM→CJS 変換でその import が
 * 下の const mockXxx = jest.fn() より先に評価され、jest.mock の factory が未初期化の mock 変数を参照して
 * しまう(connectFirebaseEmulatorsIfNeeded is not a function)。billingClient.test.ts と同じ対策として、
 * mock の const 代入が終わった後に実行される通常の require で読み込む
 */
const mockGetApp = jest.fn(() => ({}));
const mockGetFunctions = jest.fn(() => ({}));
const mockHttpsCallable = jest.fn();
const mockConnectFirebaseEmulatorsIfNeeded = jest.fn();
const mockCallable = jest.fn();

jest.mock('@react-native-firebase/app', () => ({
  getApp: mockGetApp,
}));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: mockGetFunctions,
  httpsCallable: mockHttpsCallable,
}));
jest.mock('@/config/firebase', () => ({
  connectFirebaseEmulatorsIfNeeded: mockConnectFirebaseEmulatorsIfNeeded,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyApplePurchase } = require('@/features/billing/verifyPurchase') as typeof import('@/features/billing/verifyPurchase');

describe('verifyApplePurchase', () => {
  beforeEach(() => {
    mockGetApp.mockClear();
    mockGetFunctions.mockClear();
    mockConnectFirebaseEmulatorsIfNeeded.mockClear();
    mockHttpsCallable.mockReset();
    mockCallable.mockReset();
    mockHttpsCallable.mockReturnValue(mockCallable);
  });

  it('Emulator への接続処理を呼び、region 指定で getFunctions・httpsCallable を呼ぶ', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'active', expiresAt: 123 } });

    await verifyApplePurchase('111');

    expect(mockConnectFirebaseEmulatorsIfNeeded).toHaveBeenCalledTimes(1);
    expect(mockGetFunctions).toHaveBeenCalledWith({}, 'asia-northeast1');
    expect(mockHttpsCallable).toHaveBeenCalledWith({}, 'verifyApplePurchase');
    expect(mockCallable).toHaveBeenCalledWith({ transactionId: '111' });
  });

  it('active を返す', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'active', expiresAt: 123 } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'active', expiresAt: 123 });
  });

  it('expired を返す', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'expired', expiresAt: 10 } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'expired', expiresAt: 10 });
  });

  it('details.reason が owned-by-other-account ならそのまま返す', async () => {
    mockCallable.mockRejectedValue({
      code: 'failed-precondition',
      details: { reason: 'owned-by-other-account' },
    });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'owned-by-other-account' });
  });

  it('details.reason が invalid-transaction ならそのまま返す', async () => {
    mockCallable.mockRejectedValue({
      code: 'failed-precondition',
      details: { reason: 'invalid-transaction' },
    });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'invalid-transaction' });
  });

  it('details.reason が verification-unavailable ならそのまま返す', async () => {
    mockCallable.mockRejectedValue({ code: 'unavailable', details: { reason: 'verification-unavailable' } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });

  it('unauthenticated など details.reason を持たない想定外のエラーは verification-unavailable として返す', async () => {
    mockCallable.mockRejectedValue({ code: 'unauthenticated', message: 'ログインが必要です' });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });

  it('details.reason が未知の文字列の場合も verification-unavailable として返す', async () => {
    mockCallable.mockRejectedValue({ code: 'internal', details: { reason: 'something-else' } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });

  // 5-3b-2: 呼び出し回数の上限(resource-exhausted, reason: rate-limited)も、今の「確認できない」の
  // 扱い(verification-unavailable。再試行を促す文言)のままで変えない(通常の使い方では起きない想定のため)
  it('details.reason が rate-limited(呼び出し回数の上限)の場合も verification-unavailable として返す', async () => {
    mockCallable.mockRejectedValue({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });

  it('data の形が想定外(status が active/expired 以外)の場合は verification-unavailable', async () => {
    mockCallable.mockResolvedValue({ data: null });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });

  it('status が active だが expiresAt が数値でない場合は verification-unavailable', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'active', expiresAt: 'not-a-number' } });
    await expect(verifyApplePurchase('111')).resolves.toEqual({ status: 'verification-unavailable' });
  });
});
