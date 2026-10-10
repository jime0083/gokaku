/**
 * callIssueDeviceToken(5-3a-2。Cloud Functions の issueDeviceToken を呼ぶ層)のユニットテスト。
 * verifyPurchase.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
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
const { callIssueDeviceToken } = require('@/features/deviceToken/deviceTokenApi') as typeof import('@/features/deviceToken/deviceTokenApi');

describe('callIssueDeviceToken(5-3a-2)', () => {
  beforeEach(() => {
    mockGetApp.mockClear();
    mockGetFunctions.mockClear();
    mockConnectFirebaseEmulatorsIfNeeded.mockClear();
    mockHttpsCallable.mockReset();
    mockCallable.mockReset();
    mockHttpsCallable.mockReturnValue(mockCallable);
  });

  it('Emulator への接続処理を呼び、region 指定で issueDeviceToken を呼ぶ', async () => {
    mockCallable.mockResolvedValue({ data: { deviceToken: 'raw-token', expiresAt: 123 } });

    await callIssueDeviceToken();

    expect(mockConnectFirebaseEmulatorsIfNeeded).toHaveBeenCalledTimes(1);
    expect(mockGetFunctions).toHaveBeenCalledWith({}, 'asia-northeast1');
    expect(mockHttpsCallable).toHaveBeenCalledWith({}, 'issueDeviceToken');
  });

  it('成功したら deviceToken・expiresAt を返す', async () => {
    mockCallable.mockResolvedValue({ data: { deviceToken: 'raw-token', expiresAt: 123 } });

    await expect(callIssueDeviceToken()).resolves.toEqual({ deviceToken: 'raw-token', expiresAt: 123 });
  });

  it('応答の形が不正なら null を返す', async () => {
    mockCallable.mockResolvedValue({ data: { deviceToken: 'raw-token' } });
    await expect(callIssueDeviceToken()).resolves.toBeNull();

    mockCallable.mockResolvedValue({ data: null });
    await expect(callIssueDeviceToken()).resolves.toBeNull();
  });

  it('呼び出しが失敗(通信エラー・unauthenticated 等)したら null を返す(例外を外に出さない)', async () => {
    mockCallable.mockRejectedValue(new Error('network error'));

    await expect(callIssueDeviceToken()).resolves.toBeNull();
  });
});
