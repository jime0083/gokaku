/**
 * ensureDeviceToken(5-3a-2。requirements 3-2)のユニットテスト。
 * verifyPurchase.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
 */
const mockLoadCheckpoint = jest.fn();
const mockNativeBlocked = jest.fn();
const mockGetCurrentUid = jest.fn();
const mockLoadDeviceTokenMeta = jest.fn();
const mockSaveDeviceTokenMeta = jest.fn();
const mockCallIssueDeviceToken = jest.fn();
const mockSaveDeviceTokenToKeychain = jest.fn();

jest.mock('@/features/account/accountActionCheckpoint', () => ({
  loadAccountActionCheckpoint: mockLoadCheckpoint,
}));
jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true,
  default: { isAccountOperationBlocked: mockNativeBlocked },
}));

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

// Use the actual shared singleton/gate; only persistence, native and HTTP are mocked.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { accountOperationGate } = require('@/features/account/accountOperationRuntime') as
  typeof import('@/features/account/accountOperationRuntime');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const NOW = 1_700_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('ensureDeviceToken(5-3a-2)', () => {
  beforeEach(() => {
    mockLoadCheckpoint.mockReset().mockResolvedValue(null);
    mockNativeBlocked.mockReset().mockReturnValue(false);
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
    const metaStarted = deferred<void>();
    // loadDeviceTokenMeta を保留(未解決)にし、1回目が「実行中」である間に2回目を呼ぶ
    let resolveMeta: ((value: null) => void) | undefined;
    mockLoadDeviceTokenMeta.mockImplementation(() => {
      metaStarted.resolve();
      return new Promise<null>((resolve) => { resolveMeta = resolve; });
    });
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + 30 * ONE_DAY_MS });

    const first = ensureDeviceToken(NOW);
    // gate の非同期待機中も issuing は同期的に true となり、2回目を拒否する。
    const second = ensureDeviceToken(NOW);

    await second;
    await metaStarted.promise;
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

  it.each(['checkpoint', 'native', 'checkpoint-error', 'native-unknown', 'native-error'])(
    'durable state %s では発行せず、次の機会に再試行できる', async (state) => {
      if (state === 'checkpoint') mockLoadCheckpoint.mockResolvedValue({
        uid: 'uid-1', action: 'logout', phase: 'local-cleanup',
      });
      if (state === 'native') mockNativeBlocked.mockReturnValue(true);
      if (state === 'checkpoint-error') mockLoadCheckpoint.mockRejectedValue(new Error('unreadable'));
      if (state === 'native-unknown') mockNativeBlocked.mockReturnValue(undefined);
      if (state === 'native-error') mockNativeBlocked.mockImplementation(() => { throw new Error('unreadable'); });
      mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + ONE_DAY_MS });

      await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();
      expect(mockLoadDeviceTokenMeta).not.toHaveBeenCalled();
      expect(mockCallIssueDeviceToken).not.toHaveBeenCalled();
      expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
      expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();

      mockLoadCheckpoint.mockResolvedValue(null);
      mockNativeBlocked.mockReset().mockReturnValue(false);
      await ensureDeviceToken(NOW);
      expect(mockCallIssueDeviceToken).toHaveBeenCalledTimes(1);
    },
  );

  it('account permit 保持中は発行せず、release 後に再試行できる', async () => {
    await accountOperationGate.acquireAccount('uid-1');
    try {
      await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();
      expect(mockLoadDeviceTokenMeta).not.toHaveBeenCalled();
      expect(mockCallIssueDeviceToken).not.toHaveBeenCalled();
    } finally {
      await accountOperationGate.releaseAccount('uid-1');
    }
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + ONE_DAY_MS });
    await ensureDeviceToken(NOW);
    expect(mockSaveDeviceTokenMeta).toHaveBeenCalledTimes(1);
  });

  it.each(['meta', 'http', 'save'] as const)(
    'account acquire は %s の待機から全保存完了まで待つ', async (stage) => {
      const started = deferred<void>();
      const finish = deferred<void>();
      const events: string[] = [];
      mockLoadDeviceTokenMeta.mockImplementation(async () => {
        if (stage === 'meta') { started.resolve(); await finish.promise; }
        return null;
      });
      mockCallIssueDeviceToken.mockImplementation(async () => {
        if (stage === 'http') { started.resolve(); await finish.promise; }
        return { deviceToken: 'raw-token', expiresAt: NOW + ONE_DAY_MS };
      });
      mockSaveDeviceTokenToKeychain.mockImplementation(() => { events.push('keychain'); return true; });
      mockSaveDeviceTokenMeta.mockImplementation(async () => {
        if (stage === 'save') { started.resolve(); await finish.promise; }
        events.push('meta');
      });
      const writing = ensureDeviceToken(NOW);
      await started.promise;
      let acquired = false;
      const account = accountOperationGate.acquireAccount('uid-1').then(() => {
        acquired = true;
        events.push('cleanup');
      });
      try {
        await Promise.resolve();
        expect(acquired).toBe(false);
      } finally {
        finish.resolve();
        await writing;
        await account;
        await accountOperationGate.releaseAccount('uid-1');
      }
      expect(events).toEqual(['keychain', 'meta', 'cleanup']);
    },
  );

  it.each(['uid-2', null])('meta 読込後にUIDが %s なら発行・保存しない', async (nextUid) => {
    mockLoadDeviceTokenMeta.mockImplementation(async () => {
      mockGetCurrentUid.mockReturnValue(nextUid);
      return null;
    });
    await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();
    expect(mockCallIssueDeviceToken).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it.each(['uid-2', null])('HTTP後にUIDが %s ならKeychain・metaを保存しない', async (nextUid) => {
    mockCallIssueDeviceToken.mockImplementation(async () => {
      mockGetCurrentUid.mockReturnValue(nextUid);
      return { deviceToken: 'raw-token', expiresAt: NOW + ONE_DAY_MS };
    });
    await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();
    expect(mockSaveDeviceTokenToKeychain).not.toHaveBeenCalled();
    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

  it('Keychain保存中にUIDが変わればmetaを保存しない', async () => {
    mockCallIssueDeviceToken.mockResolvedValue({ deviceToken: 'raw-token', expiresAt: NOW + ONE_DAY_MS });
    mockSaveDeviceTokenToKeychain.mockImplementation(() => {
      mockGetCurrentUid.mockReturnValue('uid-2');
      return true;
    });
    await expect(ensureDeviceToken(NOW)).resolves.toBeUndefined();
    expect(mockSaveDeviceTokenMeta).not.toHaveBeenCalled();
  });

});
