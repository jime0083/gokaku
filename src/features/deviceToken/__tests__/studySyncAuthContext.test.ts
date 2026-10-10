/**
 * saveDeviceTokenToKeychain(5-3a-2)のユニットテスト。
 * modules/study-sync/src/StudySyncModule はネイティブモジュール(requireNativeModule を import 時に
 * 即実行する)のため、Jest 環境では必ずモックに差し替える
 */
const mockSetAuthContext = jest.fn();

jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true,
  default: {
    setAuthContext: mockSetAuthContext,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveDeviceTokenToKeychain } = require('@/features/deviceToken/studySyncAuthContext') as typeof import('@/features/deviceToken/studySyncAuthContext');

describe('saveDeviceTokenToKeychain(5-3a-2)', () => {
  beforeEach(() => {
    mockSetAuthContext.mockReset();
  });

  it('StudySync.setAuthContext(uid, deviceToken) を呼び、true を返す', () => {
    const result = saveDeviceTokenToKeychain('uid-1', 'raw-token');

    expect(mockSetAuthContext).toHaveBeenCalledWith('uid-1', 'raw-token');
    expect(result).toBe(true);
  });

  it('Keychain への保存に失敗(例外)したら false を返す', () => {
    mockSetAuthContext.mockImplementation(() => {
      throw new Error('keychain error');
    });

    const result = saveDeviceTokenToKeychain('uid-1', 'raw-token');

    expect(result).toBe(false);
  });
});
