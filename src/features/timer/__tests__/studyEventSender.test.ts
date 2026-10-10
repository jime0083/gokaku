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
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalId: mockFetchActiveGoalId,
}));

const { enqueueAndSendStudyEvent, flushStudyEventQueue } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/studyEventSender') as typeof import('@/features/timer/studyEventSender');
const { appendStudyEvent, loadStudyEventQueue } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/studyEventQueue') as typeof import('@/features/timer/studyEventQueue');

const BASE_EVENT = { sessionId: 'session-1', action: 'start' as const, clientTimeMs: 1_000 };

describe('studyEventSender(5-1b-2)', () => {
  beforeEach(() => {
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
});
