/**
 * ensureDeviceToken(5-3a-2。requirements 3-2)のユニットテスト。
 * verifyPurchase.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
 */
const mockGetCurrentUid = jest.fn();
const mockLoadDeviceTokenMeta = jest.fn();
const mockSaveDeviceTokenMeta = jest.fn();
const mockCallIssueDeviceToken = jest.fn();
const mockSaveDeviceTokenToKeychain = jest.fn();

jest.mock('@/config/firebase', () => ({
  getCurrentUid: mockGetCurrentUid,
}));
jest.mock('@/features/deviceToken/deviceTokenStorage', () => ({
  loadDeviceTokenMeta: mockLoadDeviceTokenMeta,
  saveDeviceTokenMeta: mockSaveDeviceTokenMeta,
}));
jest.mock('@/features/deviceToken/deviceTokenApi', () => ({
  callIssueDeviceToken: mockCallIssueDeviceToken,
}));
jest.mock('@/features/deviceToken/studySyncAuthContext', () => ({
  saveDeviceTokenToKeychain: mockSaveDeviceTokenToKeychain,
}));

const { ensureDeviceToken, DEVICE_TOKEN_REISSUE_THRESHOLD_MS } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/deviceToken/ensureDeviceToken') as typeof import('@/features/deviceToken/ensureDeviceToken');

const NOW = 1_700_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('ensureDeviceToken(5-3a-2)', () => {
  beforeEach(() => {
    mockGetCurrentUid.mockReset();
    mockLoadDeviceTokenMeta.mockReset();
    mockSaveDeviceTokenMeta.mockReset();
    mockCallIssueDeviceToken.mockReset();
    mockSaveDeviceTokenToKeychain.mockReset();

    mockGetCurrentUid.mockReturnValue('uid-1');
    mockSaveDeviceTokenToKeychain.mockReturnValue(true);
  });

  it('初回の発行(保存されたトークンの期限が分からない)', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue(null);
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + 30 * ONE_DAY_MS });

    await ensureDeviceToken(NOW);

    expect(mockCallIssueDeviceToken).toHaveBeenCalledTimes(1);
    expect(mockSaveDeviceTokenToKeychain).toHaveBeenCalledWith('uid-1', 'raw-token');
    expect(mockSaveDeviceTokenMeta).toHaveBeenCalledWith({ uid: 'uid-1', expiresAt: NOW + 30 * ONE_DAY_MS });
  });

  it('残り7日未満で作り直す', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue({
      uid: 'uid-1',
      expiresAt: NOW + DEVICE_TOKEN_REISSUE_THRESHOLD_MS - 1,
    });
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token-2', expiresAt: NOW + 30 * ONE_DAY_MS });

    await ensureDeviceToken(NOW);

    expect(mockCallIssueDeviceToken).toHaveBeenCalledTimes(1);
    expect(mockSaveDeviceTokenMeta).toHaveBeenCalledWith({ uid: 'uid-1', expiresAt: NOW + 30 * ONE_DAY_MS });
  });

  it('残りに余裕がある(7日以上)ときは何もしない', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue({
      uid: 'uid-1',
      expiresAt: NOW + DEVICE_TOKEN_REISSUE_THRESHOLD_MS,
    });

    await ensureDeviceToken(NOW);

    expect(mockCallIssueDeviceToken).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it('保存した uid が今のユーザーと違えば発行し直す', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue({ uid: 'uid-old', expiresAt: NOW + 30 * ONE_DAY_MS });
    mockGetCurrentUid.mockReturnValue('uid-new');
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token-3', expiresAt: NOW + 30 * ONE_DAY_MS });

    await ensureDeviceToken(NOW);

    expect(mockCallIssueDeviceToken).toHaveBeenCalledTimes(1);
    expect(mockSaveDeviceTokenToKeychain).toHaveBeenCalledWith('uid-new', 'raw-token-3');
    expect(mockSaveDeviceTokenMeta).toHaveBeenCalledWith({ uid: 'uid-new', expiresAt: NOW + 30 * ONE_DAY_MS });
  });

  it('未ログインなら何もしない', async () => {
    mockGetCurrentUid.mockReturnValue(null);

    await ensureDeviceToken(NOW);

    expect(mockLoadDeviceTokenMeta).not.toHaveBeenCalled();
    expect(mockCallIssueDeviceToken).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
  });

  it('issueDeviceToken(Callable)が失敗(null)しても何もせず、例外を外に出さない', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue(null);
    mockCallIssueDeviceToken.mockResolvedValue(null);

    await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();

    expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it('issueDeviceToken(Callable)が例外を投げても、例外を外に出さない(保存の不整合に強い実装の確認)', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue(null);
    mockCallIssueDeviceToken.mockRejectedValue(new Error('network error'));

    await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();

    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it('Keychain への保存に失敗したら、AsyncStorage の期限を更新しない', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue(null);
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + 30 * ONE_DAY_MS });
    mockSaveDeviceTokenToKeychain.mockReturnValue(false);

    await ensureDeviceToken(NOW);

    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it('同時に2回走らない(実行中に呼んでも2回目は何もしない)', async () => {
    // loadDeviceTokenMeta を保留(未解決)にし、1回目が「実行中」である間に2回目を呼ぶ
    let resolveMeta: ((value: null) => void) | undefined;
    mockLoadDeviceTokenMeta.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveMeta = resolve;
      }),
    );
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + 30 * ONE_DAY_MS });

    const first = ensureDeviceToken(NOW);
    // ensureDeviceToken は最初の await(loadDeviceTokenMeta)まで同期的に進むため、
    // ここで呼ぶ2回目は issuing フラグが true のまま即座に戻る(loadDeviceTokenMeta を呼び直さない)
    const second = ensureDeviceToken(NOW);

    expect(mockLoadDeviceTokenMeta).toHaveBeenCalledTimes(1);

    resolveMeta?.(null);
    await Promise.all([first, second]);

    expect(mockCallIssueDeviceToken).toHaveBeenCalledTimes(1);
  });

  it('生のトークンが AsyncStorage に保存されない(saveDeviceTokenMeta に渡す値に deviceToken を含めない)', async () => {
    mockLoadDeviceTokenMeta.mockResolvedValue(null);
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'super-secret-raw-token', expiresAt: NOW + 30 * ONE_DAY_MS });

    await ensureDeviceToken(NOW);

    expect(mockSaveDeviceTokenMeta).toHaveBeenCalledTimes(1);
    const savedMeta = mockSaveDeviceTokenMeta.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(savedMeta).sort()).toEqual(['expiresAt', 'uid']);
    expect(JSON.stringify(savedMeta)).not.toContain('super-secret-raw-token');
  });
});
