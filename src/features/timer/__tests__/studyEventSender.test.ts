/**
 * studyEventSender(5-1b-2。requirements 3-2「アプリからの記録の保存」)のユニットテスト。
 * verifyPurchase.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockGetApp = jest.fn(() => ({}));
const mockGetFunctions = jest.fn(() => ({}));
const mockHttpsCallable = jest.fn();
const mockCallable = jest.fn();
const mockConnectFirebaseEmulatorsIfNeeded = jest.fn();
const mockFetchActiveGoalId = jest.fn();
const mockGetCurrentUid = jest.fn<string | null, []>();
const mockNativeBlocked = jest.fn(() => false);

jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true, default: { isAccountOperationBlocked: mockNativeBlocked },
}));

jest.mock('@react-native-firebase/app', () => ({
  getApp: mockGetApp,
}));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: mockGetFunctions,
  httpsCallable: mockHttpsCallable,
}));
jest.mock('@/config/firebase', () => ({
  connectFirebaseEmulatorsIfNeeded: mockConnectFirebaseEmulatorsIfNeeded,
  getCurrentUid: mockGetCurrentUid,
}));
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalId: mockFetchActiveGoalId,
}));

const { enqueueAndSendStudyEvent, flushStudyEventQueue, flushStudyEventQueueForAccount } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/studyEventSender') as typeof import('@/features/timer/studyEventSender');
const { appendStudyEvent, loadStudyEventQueue } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/studyEventQueue') as typeof import('@/features/timer/studyEventQueue');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { accountOperationGate } = require('../../account/accountOperationRuntime') as typeof import('../../account/accountOperationRuntime');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const BASE_EVENT = {
  sessionId: 'session-1',
  action: 'start' as const,
  clientTimeMs: 1_000,
  checkEnabled: true,
};

describe('studyEventSender(5-1b-2)', () => {
  beforeEach(() => {
    mockGetCurrentUid.mockReset().mockReturnValue('user-a');
    mockNativeBlocked.mockReset().mockReturnValue(false);
    mockGetApp.mockClear();
    mockGetFunctions.mockClear();
    mockConnectFirebaseEmulatorsIfNeeded.mockClear();
    mockHttpsCallable.mockReset();
    mockCallable.mockReset();
    mockHttpsCallable.mockReturnValue(mockCallable);
    mockFetchActiveGoalId.mockReset();
    mockFetchActiveGoalId.mockResolvedValue('goal-1');
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it.each(['user-b', null])('owned eventは別UID %pへ送らず保持する', async (currentUid) => {
    mockGetCurrentUid.mockReturnValue(currentUid);
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'owned' });
    await flushStudyEventQueue();
    expect(mockCallable).not.toHaveBeenCalled();
    expect(await loadStudyEventQueue()).toEqual([
      expect.objectContaining({ ...BASE_EVENT, uid: 'user-a' }),
    ]);
  });

  it('同じUIDならowned eventを送り、成功分だけ除去する', async () => {
    mockGetCurrentUid.mockReturnValue('user-a');
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });
    await enqueueAndSendStudyEvent({ ...BASE_EVENT, uid: 'user-a' });
    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('目標取得のawait中にUIDが変われば送信せず保持する', async () => {
    mockGetCurrentUid.mockReturnValue('user-a');
    mockFetchActiveGoalId.mockImplementationOnce(async () => {
      mockGetCurrentUid.mockReturnValue('user-b');
      return 'goal-1';
    });
    await enqueueAndSendStudyEvent({ ...BASE_EVENT, uid: 'user-a' });
    expect(mockCallable).not.toHaveBeenCalled();
    expect(await loadStudyEventQueue()).toHaveLength(1);
    expect((await loadStudyEventQueue())[0]?.uid).toBe('user-a');
  });

  it.each(['success', 'permanent-error'])('HTTP await中のUID変更後は%sでも除去せず、元UIDで同じkeyを再送する', async (outcome) => {
    mockGetCurrentUid.mockReturnValue('user-a');
    mockCallable.mockImplementationOnce(async () => {
      mockGetCurrentUid.mockReturnValue('user-b');
      if (outcome === 'permanent-error') throw { code: 'invalid-argument' };
      return { data: { status: 'recorded' } };
    });
    await enqueueAndSendStudyEvent({ ...BASE_EVENT, uid: 'user-a' });
    const kept = await loadStudyEventQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.uid).toBe('user-a');
    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenCalledTimes(1);
    mockGetCurrentUid.mockReturnValue('user-a');
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });
    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: kept[0]?.idempotencyKey }));
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('queue読込await中にUID変更なら送信・除去せず保持する', async () => {
    mockGetCurrentUid.mockReturnValue('user-a');
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'owned-key' });
    const originalGetItem = AsyncStorage.getItem;
    // 公式jest.fnの実装をバックアップし、mockRestoreで消さず元実装へ戻す。
    const read = jest.mocked(AsyncStorage.getItem);
    const originalImplementation = read.getMockImplementation()!;
    read.mockImplementation(async (...args) => {
      const raw = await originalImplementation(...args);
      if (args[0] === 'timer:studyEventQueue:v1') mockGetCurrentUid.mockReturnValue('user-b');
      return raw;
    });
    try {
      await flushStudyEventQueue();
      read.mockImplementation(originalImplementation);
      expect(mockCallable).not.toHaveBeenCalled();
      expect(await loadStudyEventQueue()).toEqual([
        { ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'owned-key' },
      ]);
    } finally {
      read.mockImplementation(originalImplementation);
    }
    expect(AsyncStorage.getItem).toBe(originalGetItem);
  });

  it('本人分の次にある別UID eventを送信・除去しない', async () => {
    mockGetCurrentUid.mockReturnValue('user-a');
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'a' });
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-b', idempotencyKey: 'b' });
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });
    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(await loadStudyEventQueue()).toEqual([{ ...BASE_EVENT, uid: 'user-b', idempotencyKey: 'b' }]);
  });

  it('送信に成功すると列から消える', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(mockCallable).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        goalId: 'goal-1',
        action: 'start',
        source: 'app',
        clientTimeMs: 1_000,
      }),
    );
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('start の checkEnabled はハードコードせず、渡された値をそのまま送る(5-2b。5-2a からの申し送り)', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });

    await enqueueAndSendStudyEvent({ ...BASE_EVENT, checkEnabled: false });

    expect(mockCallable).toHaveBeenCalledWith(expect.objectContaining({ checkEnabled: false }));
  });

  it('stop・confirm では checkEnabled を送らない', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });

    await enqueueAndSendStudyEvent({ sessionId: 'session-1', action: 'confirm', clientTimeMs: 2_000 });

    const sentArg = mockCallable.mock.calls[0][0] as Record<string, unknown>;
    expect(sentArg.action).toBe('confirm');
    expect('checkEnabled' in sentArg).toBe(false);
  });

  it('送る値に region 指定の getFunctions と recordStudyEvent 向けの httpsCallable を使う', async () => {
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(mockConnectFirebaseEmulatorsIfNeeded).toHaveBeenCalled();
    expect(mockGetFunctions).toHaveBeenCalledWith({}, 'asia-northeast1');
    expect(mockHttpsCallable).toHaveBeenCalledWith({}, 'recordStudyEvent');
  });

  it('失敗(通信エラーなど)すると列に残り、次の機会(flushStudyEventQueue)に送り直される', async () => {
    mockCallable.mockRejectedValueOnce({ code: 'unavailable', message: 'network error' });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    const queued = await loadStudyEventQueue();
    expect(queued).toHaveLength(1);
    expect(mockCallable).toHaveBeenCalledTimes(1);

    // 次の機会(アプリ起動時・AppState active 等)に送り直す
    mockCallable.mockResolvedValueOnce({ data: { status: 'recorded' } });
    await flushStudyEventQueue();

    expect(mockCallable).toHaveBeenCalledTimes(2);
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('再送のときも最初と同じ idempotencyKey を使う', async () => {
    mockCallable.mockRejectedValueOnce({ code: 'internal' });
    await enqueueAndSendStudyEvent(BASE_EVENT);

    const firstIdempotencyKey = (await loadStudyEventQueue())[0]?.idempotencyKey;
    expect(typeof firstIdempotencyKey).toBe('string');

    mockCallable.mockResolvedValueOnce({ data: { status: 'recorded' } });
    await flushStudyEventQueue();

    const secondCallArg = mockCallable.mock.calls[1][0] as { idempotencyKey: string };
    expect(secondCallArg.idempotencyKey).toBe(firstIdempotencyKey);
  });

  it('入力が不正・目標が見つからない(invalid-argument)場合は列から外れ、送り直されない', async () => {
    mockCallable.mockRejectedValue({ code: 'invalid-argument', details: { reason: 'goal-not-found' } });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(await loadStudyEventQueue()).toEqual([]);

    // 外れた後に flush を呼んでも、もう何も送らない(列が空のため)
    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenCalledTimes(1);
  });

  it('確認の上限に達した(resource-exhausted)場合も列から外れ、送り直されない(5-2b。5-2a からの申し送り)', async () => {
    mockCallable.mockRejectedValue({
      code: 'resource-exhausted',
      details: { reason: 'confirmation-limit-exceeded' },
    });

    await enqueueAndSendStudyEvent({ sessionId: 'session-1', action: 'confirm', clientTimeMs: 2_000 });

    expect(await loadStudyEventQueue()).toEqual([]);

    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenCalledTimes(1);
  });

  it('呼び出し回数の上限(rate-limited)の場合は列に残り、次の機会に送り直される(5-3b-2)', async () => {
    mockCallable.mockRejectedValueOnce({
      code: 'resource-exhausted',
      details: { reason: 'rate-limited' },
    });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(await loadStudyEventQueue()).toHaveLength(1);
    expect(mockCallable).toHaveBeenCalledTimes(1);

    mockCallable.mockResolvedValueOnce({ data: { status: 'recorded' } });
    await flushStudyEventQueue();

    expect(mockCallable).toHaveBeenCalledTimes(2);
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('resource-exhausted の理由(reason)が未知の場合も、データを失わない側に倒して列に残す(5-3b-3)', async () => {
    mockCallable.mockRejectedValueOnce({
      code: 'resource-exhausted',
      details: { reason: 'some-unknown-reason' },
    });

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(await loadStudyEventQueue()).toHaveLength(1);
    expect(mockCallable).toHaveBeenCalledTimes(1);

    mockCallable.mockResolvedValueOnce({ data: { status: 'recorded' } });
    await flushStudyEventQueue();

    expect(mockCallable).toHaveBeenCalledTimes(2);
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('目標の ID が取れない(未ログイン・目標なし)場合は送らずに列に残す', async () => {
    mockFetchActiveGoalId.mockResolvedValue(null);

    await enqueueAndSendStudyEvent(BASE_EVENT);

    expect(mockCallable).not.toHaveBeenCalled();
    expect(await loadStudyEventQueue()).toHaveLength(1);
  });

  it('同時に2回送り直しが走らない(2回目は何もしない)', async () => {
    // enqueueAndSendStudyEvent を経由せず列に直接積む(flushStudyEventQueue の呼び出し回数を
    // この2回だけに限定して確かめるため)
    await appendStudyEvent({ ...BASE_EVENT, idempotencyKey: 'key-1' });
    mockCallable.mockResolvedValue({ data: { status: 'recorded' } });

    // flushStudyEventQueue は最初の await に達するまで同期的に実行されるため、
    // 2回目の呼び出し時点で1回目がすでに flushing を true にしている
    const firstFlush = flushStudyEventQueue();
    const secondFlush = flushStudyEventQueue();

    await Promise.all([firstFlush, secondFlush]);

    // 2回目が同時に動いていれば2回送信されてしまうが、ガードにより1回だけ
    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('未ログインはlegacyを含む既存列を保持し、新規書込も送信も開始しない', async () => {
    await appendStudyEvent({ ...BASE_EVENT, idempotencyKey: 'legacy' });
    const before = await loadStudyEventQueue();
    mockGetCurrentUid.mockReturnValue(null);
    const writes = jest.mocked(AsyncStorage.setItem).mock.calls.length;
    await enqueueAndSendStudyEvent(BASE_EVENT);
    await enqueueAndSendStudyEvent({ ...BASE_EVENT, uid: 'user-a' });
    await flushStudyEventQueue();
    expect(jest.mocked(AsyncStorage.setItem).mock.calls).toHaveLength(writes);
    expect(await loadStudyEventQueue()).toEqual(before);
    expect(mockFetchActiveGoalId).not.toHaveBeenCalled();
    expect(mockCallable).not.toHaveBeenCalled();
  });

  it('durable blockedはenqueue/flushの新規書込・HTTPを拒否する', async () => {
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'a' });
    const before = await loadStudyEventQueue();
    mockNativeBlocked.mockReturnValue(true);
    const writes = jest.mocked(AsyncStorage.setItem).mock.calls.length;
    await expect(enqueueAndSendStudyEvent(BASE_EVENT)).rejects.toThrow('normal-blocked');
    await expect(flushStudyEventQueue()).rejects.toThrow('normal-blocked');
    expect(jest.mocked(AsyncStorage.setItem).mock.calls).toHaveLength(writes);
    expect(await loadStudyEventQueue()).toEqual(before);
    expect(mockCallable).not.toHaveBeenCalled();
  });

  it('HTTPから削除保存完了までnormal rootを待機し、親leaseを明示してawaitする', async () => {
    const http = deferred<void>();
    const started = deferred<void>();
    mockCallable.mockImplementationOnce(() => { started.resolve(); return http.promise; });
    const sending = accountOperationGate.runNormal('user-a', async (lease) => {
      await enqueueAndSendStudyEvent({ ...BASE_EVENT, uid: 'user-a' }, lease);
    });
    await started.promise;
    let acquired = false;
    const acquiring = accountOperationGate.acquireAccount('user-a').then((permit) => {
      acquired = true; return permit;
    });
    try {
      await Promise.resolve();
      expect(acquired).toBe(false);
      http.resolve();
      await sending;
      const permit = await acquiring;
      permit.assertCurrentUid();
      expect(await loadStudyEventQueue()).toEqual([]);
    } finally {
      http.resolve();
      await sending;
      await acquiring;
      await accountOperationGate.releaseAccount('user-a');
    }
  });

  it('forged/expired/account permitをnormal parentとして受け付けない', async () => {
    const forged = { assertCurrentUid: jest.fn() };
    let expired: import("../../account/accountOperationGate").AccountOperationLease = forged;
    await accountOperationGate.runNormal('user-a', async (lease) => { expired = lease; });
    const account = await accountOperationGate.acquireAccount('user-a');
    try {
      for (const lease of [forged, expired, account]) {
        await expect(enqueueAndSendStudyEvent(BASE_EVENT, lease)).rejects.toThrow('invalid-lease');
        await expect(flushStudyEventQueue(lease)).rejects.toThrow('invalid-lease');
      }
      expect(await loadStudyEventQueue()).toEqual([]);
      expect(mockCallable).not.toHaveBeenCalled();
    } finally {
      await accountOperationGate.releaseAccount('user-a');
    }
  });

  it('専用drainは他UIDが先頭でも対象だけ送り、同key別UIDとlegacyの順序・内容を保全する', async () => {
    const other = { ...BASE_EVENT, uid: 'user-b', idempotencyKey: 'same' };
    const legacy = { ...BASE_EVENT, idempotencyKey: 'same' };
    await appendStudyEvent(other);
    await appendStudyEvent(legacy);
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'same' });
    mockCallable.mockResolvedValue({});
    const permit = await accountOperationGate.acquireAccount('user-a');
    try {
      await expect(flushStudyEventQueueForAccount('user-a', permit)).resolves.toBe(true);
      expect(mockCallable).toHaveBeenCalledTimes(1);
      expect(await loadStudyEventQueue()).toEqual([other, legacy]);
    } finally {
      await accountOperationGate.releaseAccount('user-a');
    }
    await expect(flushStudyEventQueueForAccount('user-a', permit)).rejects.toThrow('expired-lease');
  });

  it.each([
    { code: 'invalid-argument' },
    { code: 'resource-exhausted', details: { reason: 'confirmation-limit-exceeded' } },
  ])('P075: account専用は恒久エラーでも保持する %p', async (error) => {
    const other = { ...BASE_EVENT, uid: 'user-b', idempotencyKey: 'same' };
    const legacy = { ...BASE_EVENT, idempotencyKey: 'same' };
    const owned = { ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'same' };
    const before = [other, legacy, owned];
    for (const event of before) await appendStudyEvent(event);
    mockCallable.mockRejectedValue(error);
    const permit = await accountOperationGate.acquireAccount('user-a');
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await expect(flushStudyEventQueueForAccount('user-a', permit)).resolves.toBe(false);
        expect(await loadStudyEventQueue()).toEqual(before);
        expect(mockCallable).toHaveBeenCalledTimes(attempt);
        expect(mockCallable).toHaveBeenLastCalledWith(expect.objectContaining({
          idempotencyKey: owned.idempotencyKey,
        }));
      }
      mockCallable.mockResolvedValue({ data: { status: 'recorded' } });
      await expect(flushStudyEventQueueForAccount('user-a', permit)).resolves.toBe(true);
      expect(mockCallable).toHaveBeenCalledTimes(3);
      expect(mockCallable).toHaveBeenLastCalledWith(expect.objectContaining({
        idempotencyKey: owned.idempotencyKey,
      }));
      expect(await loadStudyEventQueue()).toEqual([other, legacy]);
    } finally {
      await accountOperationGate.releaseAccount('user-a');
    }
  });

  it.each([
    { code: 'invalid-argument' },
    { code: 'resource-exhausted', details: { reason: 'confirmation-limit-exceeded' } },
  ])('P075: 通常drainのowned恒久エラーdiscardを維持する %p', async (error) => {
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'owned-permanent' });
    mockCallable.mockRejectedValue(error);
    await flushStudyEventQueue();
    expect(await loadStudyEventQueue()).toEqual([]);
    await flushStudyEventQueue();
    expect(mockCallable).toHaveBeenCalledTimes(1);
  });

  it('専用drainは再送待ちとflushing競合を完了扱いにしない', async () => {
    await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'a' });
    const started = deferred<void>();
    const http = deferred<void>();
    mockCallable.mockImplementationOnce(() => { started.resolve(); return http.promise; });
    const permit = await accountOperationGate.acquireAccount('user-a');
    const draining = flushStudyEventQueueForAccount('user-a', permit);
    try {
      await started.promise;
      await expect(flushStudyEventQueueForAccount('user-a', permit)).resolves.toBe(false);
      http.resolve();
      await expect(draining).resolves.toBe(true);
      await appendStudyEvent({ ...BASE_EVENT, uid: 'user-a', idempotencyKey: 'b' });
      mockCallable.mockRejectedValueOnce({ code: 'unavailable' });
      await expect(flushStudyEventQueueForAccount('user-a', permit)).resolves.toBe(false);
      expect(await loadStudyEventQueue()).toHaveLength(1);
    } finally {
      http.resolve();
      await draining;
      await accountOperationGate.releaseAccount('user-a');
    }
  });

});
