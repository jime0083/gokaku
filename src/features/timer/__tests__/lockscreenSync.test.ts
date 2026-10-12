/**
 * lockscreenSync(5-3c-5b。requirements 3-2「アプリとロック画面の計測の共有」)のユニットテスト。
 * studyEventSender.test.ts と同じ理由で、テスト対象を require で読み込む(jest.mock の factory が
 * 未初期化の mock 変数を参照してしまうのを避けるため)。
 *
 * StudySyncModule(ネイティブモジュール)・getCurrentUid・fetchActiveGoalId はすべてモックにする
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockGetCurrentUid = jest.fn<string | null, []>();
const mockFetchActiveGoalId = jest.fn<Promise<string | null>, []>();
const mockStartMeasurement = jest.fn();
const mockStopMeasurement = jest.fn();
const mockGetActiveSession = jest.fn();
const mockSetActiveSession = jest.fn();
const mockSetCheckEnabledSetting = jest.fn();
const mockGetLastLockscreenStop = jest.fn();
const mockClearLastLockscreenStop = jest.fn();

jest.mock('@/config/firebase', () => ({
  getCurrentUid: mockGetCurrentUid,
}));
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalId: mockFetchActiveGoalId,
}));
jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true,
  default: {
    startMeasurement: mockStartMeasurement,
    stopMeasurement: mockStopMeasurement,
    getActiveSession: mockGetActiveSession,
    setActiveSession: mockSetActiveSession,
    setCheckEnabledSetting: mockSetCheckEnabledSetting,
    getLastLockscreenStop: mockGetLastLockscreenStop,
    clearLastLockscreenStop: mockClearLastLockscreenStop,
  },
}));

const {
  notifyNativeMeasurementStart,
  notifyNativeMeasurementStop,
  addNativeConfirmation,
  rememberCheckEnabledSetting,
  reconcileWithLockscreen,
} =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/lockscreenSync') as typeof import('@/features/timer/lockscreenSync');
const { startLocalSession, loadLocalSessions } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/storage') as typeof import('@/features/timer/storage');

describe('lockscreenSync(5-3c-5b)', () => {
  beforeEach(() => {
    mockGetCurrentUid.mockReset();
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockFetchActiveGoalId.mockReset();
    mockFetchActiveGoalId.mockResolvedValue('goal-1');
    mockStartMeasurement.mockReset();
    mockStartMeasurement.mockResolvedValue(true);
    mockStopMeasurement.mockReset();
    mockStopMeasurement.mockResolvedValue(true);
    mockGetActiveSession.mockReset();
    mockGetActiveSession.mockReturnValue(null);
    mockSetActiveSession.mockReset();
    mockSetActiveSession.mockReturnValue(true);
    mockSetCheckEnabledSetting.mockReset();
    mockGetLastLockscreenStop.mockReset();
    mockGetLastLockscreenStop.mockReturnValue(null);
    mockClearLastLockscreenStop.mockReset();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  describe('notifyNativeMeasurementStart', () => {
    it('ログイン中・有効な目標があるとき、正しい引数で startMeasurement を呼ぶ', async () => {
      await notifyNativeMeasurementStart('session-1', 1_000, true);

      expect(mockStartMeasurement).toHaveBeenCalledWith('uid-1', 'goal-1', 'session-1', 1_000, true);
    });

    it('未ログインのときは呼ばない', async () => {
      mockGetCurrentUid.mockReturnValue(null);

      await notifyNativeMeasurementStart('session-1', 1_000, true);

      expect(mockStartMeasurement).not.toHaveBeenCalled();
    });

    it('有効な目標が無いときは呼ばない', async () => {
      mockFetchActiveGoalId.mockResolvedValue(null);

      await notifyNativeMeasurementStart('session-1', 1_000, true);

      expect(mockStartMeasurement).not.toHaveBeenCalled();
    });

    it('StudySync が例外(reject)を出しても外に投げない', async () => {
      mockStartMeasurement.mockRejectedValue(new Error('native error'));

      await expect(notifyNativeMeasurementStart('session-1', 1_000, true)).resolves.toBeUndefined();
    });
  });

  describe('notifyNativeMeasurementStop', () => {
    it('ログイン中・有効な目標があるとき、正しい引数で stopMeasurement を呼ぶ', async () => {
      await notifyNativeMeasurementStop('session-1');

      expect(mockStopMeasurement).toHaveBeenCalledWith('uid-1', 'goal-1', 'session-1');
    });

    it('StudySync が例外(reject)を出しても外に投げない', async () => {
      mockStopMeasurement.mockRejectedValue(new Error('native error'));

      await expect(notifyNativeMeasurementStop('session-1')).resolves.toBeUndefined();
    });
  });

  describe('addNativeConfirmation', () => {
    it('計測中の状態があれば、confirmations に足して書き直す', () => {
      mockGetActiveSession.mockReturnValue({
        sessionId: 'session-1',
        uid: 'uid-1',
        goalId: 'goal-1',
        startAt: 1_000,
        checkEnabled: true,
        confirmations: [2_000],
      });

      addNativeConfirmation(3_000);

      expect(mockSetActiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', confirmations: [2_000, 3_000] }),
      );
    });

    it('計測中の状態が無ければ何もしない', () => {
      mockGetActiveSession.mockReturnValue(null);

      addNativeConfirmation(3_000);

      expect(mockSetActiveSession).not.toHaveBeenCalled();
    });

    it('StudySync が例外を出しても外に投げない', () => {
      mockGetActiveSession.mockImplementation(() => {
        throw new Error('native error');
      });

      expect(() => addNativeConfirmation(3_000)).not.toThrow();
    });
  });

  describe('rememberCheckEnabledSetting', () => {
    it('setCheckEnabledSetting を呼ぶ', () => {
      rememberCheckEnabledSetting(false);

      expect(mockSetCheckEnabledSetting).toHaveBeenCalledWith(false);
    });

    it('StudySync が例外を出しても外に投げない', () => {
      mockSetCheckEnabledSetting.mockImplementation(() => {
        throw new Error('native error');
      });

      expect(() => rememberCheckEnabledSetting(true)).not.toThrow();
    });
  });

  describe('reconcileWithLockscreen', () => {
    it('App Group にあって端末にない計測は、端末に取り込む(続きとして表示)', async () => {
      mockGetActiveSession.mockReturnValue({
        sessionId: 'lockscreen-session',
        uid: 'uid-1',
        goalId: 'goal-1',
        startAt: 1_000,
        checkEnabled: true,
        confirmations: [1_500],
      });

      const result = await reconcileWithLockscreen([], 2_000);

      expect(result.changed).toBe(true);
      expect(result.sessions).toEqual([
        { sessionId: 'lockscreen-session', startAt: 1_000, stopAt: null, checkEnabled: true, confirmations: [1_500] },
      ]);
      // サーバーには送らない(reconcileWithLockscreen 自体は送信層を一切呼ばない)
      const stored = await loadLocalSessions();
      expect(stored).toEqual(result.sessions);
    });

    it('端末で計測中なのに App Group が空で、getLastLockscreenStop の sessionId が一致するとき、その stopAt で閉じる', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockReturnValue(null);
      mockGetLastLockscreenStop.mockReturnValue({ sessionId: 'session-1', stopAt: 1_800 });

      const result = await reconcileWithLockscreen(await loadLocalSessions(), 5_000);

      expect(result.changed).toBe(true);
      expect(result.sessions).toEqual([
        { sessionId: 'session-1', startAt: 1_000, stopAt: 1_800, checkEnabled: true, confirmations: [] },
      ]);
      expect(mockClearLastLockscreenStop).toHaveBeenCalled();
    });

    it('端末で計測中・App Group が空で、getLastLockscreenStop が無い(想定外)ときは何もしない', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockReturnValue(null);
      mockGetLastLockscreenStop.mockReturnValue(null);
      const sessions = await loadLocalSessions();

      const result = await reconcileWithLockscreen(sessions, 5_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual(sessions);
      expect(mockClearLastLockscreenStop).not.toHaveBeenCalled();
    });

    it('端末で計測中・App Group が空で、getLastLockscreenStop の sessionId が違う(想定外)ときは何もしない', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockReturnValue(null);
      mockGetLastLockscreenStop.mockReturnValue({ sessionId: 'other-session', stopAt: 1_800 });
      const sessions = await loadLocalSessions();

      const result = await reconcileWithLockscreen(sessions, 5_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual(sessions);
    });

    it('両方で計測中だが sessionId が違う(想定外)ときは何もしない', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockReturnValue({
        sessionId: 'session-2',
        uid: 'uid-1',
        goalId: 'goal-1',
        startAt: 1_000,
        checkEnabled: true,
        confirmations: [],
      });
      const sessions = await loadLocalSessions();

      const result = await reconcileWithLockscreen(sessions, 5_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual(sessions);
    });

    it('両方とも計測していないときは何もしない', async () => {
      mockGetActiveSession.mockReturnValue(null);

      const result = await reconcileWithLockscreen([], 1_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual([]);
    });

    it('両方で計測中・sessionId が同じときは何もしない(すでに一致している)', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockReturnValue({
        sessionId: 'session-1',
        uid: 'uid-1',
        goalId: 'goal-1',
        startAt: 1_000,
        checkEnabled: true,
        confirmations: [],
      });
      const sessions = await loadLocalSessions();

      const result = await reconcileWithLockscreen(sessions, 5_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual(sessions);
    });

    it('StudySync の呼び出し(getActiveSession)が例外を出しても端末の記録は変えない', async () => {
      await startLocalSession(1_000, 'session-1', true);
      mockGetActiveSession.mockImplementation(() => {
        throw new Error('native error');
      });
      mockGetLastLockscreenStop.mockReturnValue(null);
      const sessions = await loadLocalSessions();

      const result = await reconcileWithLockscreen(sessions, 5_000);

      expect(result.changed).toBe(false);
      expect(result.sessions).toEqual(sessions);
    });
  });
});
