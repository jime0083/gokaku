import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AppState } from 'react-native';

import { startLocalSession } from '@/features/timer/storage';
import { getCurrentUid } from '@/config/firebase';

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
 * タイマー画面(5-1a・5-1b-2・5-2b)の画面テスト。有効な目標の読み込み(activeGoalRepository)・
 * 確認 ON/OFF の読み込み(checkEnabledRepository)・サーバーへの送信層(studyEventSender。5-1b-2・5-2a)は
 * モックにし、renderRouter で実際の画面(下部タブを含む)を使って次を確認する(CLAUDE.md: router のモックで
 * 「呼ばれたこと」だけを確かめるテストにしない)。
 * - 開始前は 00:00:00
 * - 開始 → 停止で今日の勉強時間が増える
 * - 計測中は「勉強中」とタブの印が出る
 * - 再表示(アンマウント・再マウント)しても計測中なら経過時間が続く
 * - 開始・停止で送信層(enqueueAndSendStudyEvent)が呼ばれる。送信層そのものの挙動(列・再送)は
 *   studyEventSender.test.ts で確認する
 * - 「勉強中？」確認(5-2b。requirements 3-2, 2026-10-10 追記): 応答あり・応答なし(自動停止・お知らせ)・
 *   OFF・ホームタブでも出る・画面を開き直したとき
 *
 * storage.ts(端末内保存)は実物を使う(AsyncStorage)。seedActiveSession で画面を開く前に
 * 計測中のセッションを AsyncStorage に仕込み、「開き直したとき」の挙動を確認する
 */
// 5-3e-2: ネイティブの設定読み取りだけをモックにし、短縮設定から通知予約までの計算は実物を使う。
jest.mock('@/config/firebase', () => ({
  ...jest.requireActual<typeof import('@/config/firebase')>('@/config/firebase'),
  getCurrentUid: jest.fn(() => null),
}));

const mockIsAccountOperationBlocked = jest.fn<boolean, []>(() => false);
const mockGetStudyCheckDevOverride = jest.fn();
jest.mock('../../../../modules/study-sync/src/StudySyncModule', () => ({
  __esModule: true,
  default: {
    getStudyCheckDevOverride: mockGetStudyCheckDevOverride,
    isAccountOperationBlocked: mockIsAccountOperationBlocked,
  },
}));

const mockFetchActiveGoalDailyTargets = jest.fn();
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalDailyTargets: mockFetchActiveGoalDailyTargets,
}));

const mockEnqueueAndSendStudyEvent = jest.fn();
const mockFlushStudyEventQueue = jest.fn();
jest.mock('@/features/timer/studyEventSender', () => ({
  enqueueAndSendStudyEvent: mockEnqueueAndSendStudyEvent,
  flushStudyEventQueue: mockFlushStudyEventQueue,
}));

const mockFetchCheckEnabled = jest.fn();
jest.mock('@/features/timer/checkEnabledRepository', () => ({
  fetchCheckEnabled: mockFetchCheckEnabled,
}));

/**
 * ロック画面との同期(5-3c-5b)。lockscreenSync の内部(StudySync・Firebase の呼び出し)は
 * lockscreenSync.test.ts で確認するため、ここでは画面(useTimerSession)が正しい引数で呼ぶこと・
 * reconcileWithLockscreen の結果を正しく取り込むことだけを確かめる
 */
const mockNotifyNativeMeasurementStart = jest.fn();
const mockNotifyNativeMeasurementStop = jest.fn();
const mockAddNativeConfirmation = jest.fn();
const mockRememberCheckEnabledSetting = jest.fn();
const mockReconcileWithLockscreen = jest.fn();
jest.mock('@/features/timer/lockscreenSync', () => ({
  notifyNativeMeasurementStart: mockNotifyNativeMeasurementStart,
  notifyNativeMeasurementStop: mockNotifyNativeMeasurementStop,
  addNativeConfirmation: mockAddNativeConfirmation,
  rememberCheckEnabledSetting: mockRememberCheckEnabledSetting,
  reconcileWithLockscreen: mockReconcileWithLockscreen,
}));

/**
 * studyCheckNotifications は checkEnabledRepository を静的 import するため、ここを通常の import 文にすると
 * (import 文は require より先に実行される)、上の jest.mock のモック変数が代入される前に
 * checkEnabledRepository のモックファクトリが呼ばれ、fetchCheckEnabled が undefined になる
 * (この行より上の const mockX = jest.fn() が全て済んでから require する)
 */
const studyCheckNotifications =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/studyCheckNotifications') as typeof import('@/features/timer/studyCheckNotifications');
const { STUDY_CHECK_ACTION_IDENTIFIER, STUDY_CHECK_NOTIFICATION_IDENTIFIER } = studyCheckNotifications;

/**
 * renderRouter の初期レンダリングを await act で包む(renderRouter 自体は同期的に返すが、
 * 内部の初期レンダリングが非同期の act を使うため。CLAUDE.md・backNavigation.test.tsx と同じ対策)
 */
async function renderTimerRouter(initialUrl = '/timer'): Promise<void> {
  await act(async () => {
    renderRouter('src/app', { initialUrl });
  });
}

/** 60分ごとの確認時刻(開始 + k × 60分) */
const checkAt = (startAt: number, k: number): number => startAt + k * 60 * 60_000;

/**
 * AppState の 'change' イベントに登録された全てのハンドラに state を渡して呼ぶ。
 * 実際の AppState は 'change' を登録された全リスナーに配る(1つだけではない)。
 * このアプリでは useTimerSession の他に、ルートの _layout(5-3a-2: useDeviceTokenSync)も
 * 'change' を登録するため、「最後に登録されたものだけ呼ぶ」実装では意図したリスナーに届かないことがある
 * (@react-native/jest-preset の AppState モックは addEventListener が jest.fn なので、
 * 呼び出し引数からハンドラを直接取り出して呼べる)
 */
function triggerAppStateChange(state: string): void {
  const addEventListener = AppState.addEventListener as jest.Mock;
  const handlers = addEventListener.mock.calls
    .filter(([eventName]) => eventName === 'change')
    .map(([, handler]) => handler as (state: string) => void);
  if (handlers.length === 0) {
    throw new Error("AppState.addEventListener('change', ...) が呼ばれていない");
  }
  handlers.forEach((handler) => handler(state));
}

/**
 * addNotificationResponseReceivedListener に登録された最後のハンドラを取り出す
 * (通知のアクション「勉強中」が押されたときの処理を、Jest から直接呼ぶため)
 */
function getLatestNotificationResponseHandler(): (response: Notifications.NotificationResponse) => void {
  const addListener = Notifications.addNotificationResponseReceivedListener as jest.Mock;
  const call = addListener.mock.calls[addListener.mock.calls.length - 1] as
    | [(response: Notifications.NotificationResponse) => void]
    | undefined;
  if (!call) {
    throw new Error('addNotificationResponseReceivedListener が呼ばれていない');
  }
  return call[0];
}

/** 通知のアクション「勉強中」が押された/起動時の最後の応答として扱う NotificationResponse */
function makeStudyCheckResponse(respondedAtMs: number): Notifications.NotificationResponse {
  return {
    actionIdentifier: STUDY_CHECK_ACTION_IDENTIFIER,
    notification: {
      date: respondedAtMs / 1000,
      request: { identifier: 'study-check-notification', content: {}, trigger: null },
    },
  } as unknown as Notifications.NotificationResponse;
}

const TIMER_TEST_UID = 'timer-ui-user';

beforeEach(() => {
  jest.mocked(getCurrentUid).mockReturnValue(TIMER_TEST_UID);
  mockIsAccountOperationBlocked.mockReset().mockReturnValue(false);
});

describe('タイマー画面(5-1a・5-2b。requirements 3-2, 4-6)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetStudyCheckDevOverride.mockReset().mockReturnValue(null);
    mockFetchActiveGoalDailyTargets.mockResolvedValue({
      minDailyMinutes: 60,
      goalDailyMinutes: 120,
    });
    mockFetchCheckEnabled.mockResolvedValue(true);
    mockNotifyNativeMeasurementStart.mockResolvedValue(undefined);
    mockNotifyNativeMeasurementStop.mockResolvedValue(undefined);
    // 既定: ロック画面側の取り込みは無し(渡された sessions をそのまま返す)
    mockReconcileWithLockscreen.mockImplementation(
      async (sessions: unknown) => ({ sessions, changed: false }),
    );
  });

  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('計測していないときは 00:00:00 で、「勉強中」は表示されない', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-elapsed-text'));
    expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:00:00');
    expect(screen.queryByTestId('timer-status-text')).toBeNull();
    expect(screen.queryAllByTestId('timer-tab-indicator')).toHaveLength(0);
  });

  it('開始すると「勉強中」とタブの印が出て、経過時間が進む', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));

    await waitFor(() => screen.getByTestId('timer-status-text'));
    expect(screen.getAllByTestId('timer-tab-indicator').length).toBeGreaterThan(0);

    // modern fake timers は advanceTimersByTime で Date.now() も進む(setSystemTime を併用すると2重に進んでしまう)
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });

    await waitFor(() =>
      expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:00:05'),
    );
  });

  it('開始 → 停止で今日の勉強時間が増え、「勉強中」とタブの印が消える', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => screen.getByTestId('timer-status-text'));

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
    });

    await fireEvent.press(screen.getByTestId('timer-toggle-button'));

    await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
    expect(screen.queryAllByTestId('timer-tab-indicator')).toHaveLength(0);
    expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 0時間5分');
    expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:00:00');
  });

  it('目標が読めない場合は「目標未設定」と表示する(開発用のフォールバック)', async () => {
    mockFetchActiveGoalDailyTargets.mockResolvedValue(null);
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-goal-not-set-text'));
    expect(screen.queryByTestId('timer-min-progress-bar')).toBeNull();
  });

  it('有効な目標がある場合は最低/努力目標それぞれの進捗バーを表示する', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-min-progress-bar'));
    expect(screen.getByTestId('timer-goal-progress-bar')).toBeTruthy();
    expect(screen.queryByTestId('timer-goal-not-set-text')).toBeNull();
  });

  it('再表示(アンマウント・再マウント)しても計測中なら経過時間が続く', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => screen.getByTestId('timer-status-text'));

    await cleanup();

    jest.setSystemTime(new Date('2026-10-10T10:03:00+09:00'));
    await renderTimerRouter();

    await waitFor(() =>
      expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:03:00'),
    );
    expect(screen.getByTestId('timer-status-text')).toBeTruthy();
  });

  it('開始・停止のたびに送信層(studyEventSender)が呼ばれる(5-1b-2)', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    // マウント時に送信待ちの列を再送する(アプリ起動時の再送)
    expect(mockFlushStudyEventQueue).toHaveBeenCalled();

    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledTimes(1));
    const [startCall] = mockEnqueueAndSendStudyEvent.mock.calls[0];
    expect(startCall).toMatchObject({ action: 'start', clientTimeMs: Date.now(), checkEnabled: true });
    expect(typeof startCall.sessionId).toBe('string');
    expect(startCall.sessionId.length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledTimes(2));
    const [stopCall] = mockEnqueueAndSendStudyEvent.mock.calls[1];
    // 開始・停止で同じ sessionId を使う(停止だけに新しい sessionId を作らない)
    expect(stopCall).toMatchObject({ action: 'stop', sessionId: startCall.sessionId });
  });

  it('checkEnabled は users.checkEnabled を読んだ値を送る(5-2b。5-2a からの申し送り)', async () => {
    mockFetchCheckEnabled.mockResolvedValue(false);
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    await renderTimerRouter();

    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));

    await waitFor(() => expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledTimes(1));
    expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'start', checkEnabled: false }),
      expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
    );
  });

  describe('「勉強中？」確認(5-2b。requirements 3-2, 2026-10-10 追記)', () => {
    it('応答あり: 60分で確認が出る → 「勉強中」を押すと確認が消え、計測が続き、confirm が送られる', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });

      await waitFor(() => screen.getByTestId('study-check-overlay'));
      await fireEvent.press(screen.getByTestId('study-check-confirm-button'));

      await waitFor(() => expect(screen.queryByTestId('study-check-overlay')).toBeNull());
      // 計測は続く(自動停止していない)
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'confirm' }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
    });

    it('応答なし: 70分を過ぎると確認の時刻(60分)で止まり、今日の勉強時間が60分になり、お知らせが一度だけ出る', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(71 * 60 * 1000);
      });

      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      expect(screen.queryByTestId('study-check-overlay')).toBeNull();
      expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 1時間0分');

      await waitFor(() => screen.getByTestId('timer-auto-stop-notice'));
      expect(screen.getByTestId('timer-auto-stop-notice-text').props.children).toBe(
        '「勉強中？」に応答がなかったため、11時00分で計測を停止しました',
      );
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop', clientTimeMs: checkAt(startAt, 1) }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );

      await fireEvent.press(screen.getByTestId('timer-auto-stop-notice-close-button'));
      await waitFor(() => expect(screen.queryByTestId('timer-auto-stop-notice')).toBeNull());

      // 再表示しても二度と出ない
      await cleanup();
      await renderTimerRouter();
      await waitFor(() => screen.getByTestId('timer-elapsed-text'));
      expect(screen.queryByTestId('timer-auto-stop-notice')).toBeNull();
    });

    it('OFF: 70分を過ぎても確認は出ず、自動停止もしない', async () => {
      mockFetchCheckEnabled.mockResolvedValue(false);
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(71 * 60 * 1000);
      });

      expect(screen.queryByTestId('study-check-overlay')).toBeNull();
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
      expect(screen.queryByTestId('timer-auto-stop-notice')).toBeNull();
    });

    it('ホームのタブを表示していても確認が出る', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      await waitFor(() => screen.getByTestId('study-check-overlay'));

      await fireEvent.press(screen.getByText('ホーム'));
      await waitFor(() => screen.getByTestId('home-screen'));
      expect(screen.getByTestId('study-check-overlay')).toBeTruthy();
    });

    it('画面を開き直したとき、応答期限の前なら確認が出る', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      await startLocalSession(startAt, 'seeded-session', true);

      jest.setSystemTime(startAt + 65 * 60 * 1000); // 確認時刻(60分)〜期限(70分)の間
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('study-check-overlay'));
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
    });

    it('画面を開き直したとき、応答期限を過ぎていれば止まってお知らせが出る', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      await startLocalSession(startAt, 'seeded-session', true);

      jest.setSystemTime(startAt + 75 * 60 * 1000); // 確認時刻(60分)の期限(70分)を過ぎている
      await renderTimerRouter();

      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      await waitFor(() => screen.getByTestId('timer-auto-stop-notice'));
      expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 1時間0分');
    });

    it('AppState が active になったとき、無応答の判定をやり直して自動停止し、送信待ちの列を再送する', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      mockFlushStudyEventQueue.mockClear();

      // タイマー(setInterval)を進めず、応答期限(70分)を過ぎた時刻まで一気に進める
      // (バックグラウンドで時間が過ぎ、前面に戻ったときの状況を再現する)
      jest.setSystemTime(startAt + 75 * 60 * 1000);
      await act(async () => {
        triggerAppStateChange('active');
      });

      expect(mockFlushStudyEventQueue).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      await waitFor(() => screen.getByTestId('timer-auto-stop-notice'));
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop', clientTimeMs: checkAt(startAt, 1) }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
    });
  });

  describe('「勉強中？」の通知(5-2c。requirements 3-2)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockFetchActiveGoalDailyTargets.mockResolvedValue({ minDailyMinutes: 60, goalDailyMinutes: 120 });
      mockFetchCheckEnabled.mockResolvedValue(true);
    });

    afterEach(() => {
      // getPermissionsAsync は mockResolvedValue(永続)で上書きするテストがあるため、既定(許可あり)に戻す
      // (clearAllMocks は呼び出し履歴だけを消し、mockResolvedValue の実装は消さないため明示的に戻す)
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted', granted: true });
    });

    it('開始すると確認の時刻(60分後)にローカル通知を予約する', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));

      await waitFor(() =>
        expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
            trigger: { type: 'timeInterval', seconds: 60 * 60 },
          }),
        ),
      );
    });

    describe('開発用の短縮設定(5-3e-2)', () => {
      let scheduleSpy: jest.SpyInstance;

      beforeEach(() => {
        mockGetStudyCheckDevOverride.mockReturnValue({ intervalMs: 120_000, responseWindowMs: 60_000 });
        // 呼び出し時刻を検証しつつ、実物の scheduleStudyCheckNotification を通して Expo の予約も確認する。
        scheduleSpy = jest.spyOn(studyCheckNotifications, 'scheduleStudyCheckNotification');
      });

      afterEach(() => {
        scheduleSpy.mockRestore();
      });

      it('開始すると実物の短縮設定・計算で開始から120秒後の通知を予約する', async () => {
        const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
        jest.setSystemTime(startAt);
        await renderTimerRouter();

        await waitFor(() => screen.getByTestId('timer-toggle-button'));
        await fireEvent.press(screen.getByTestId('timer-toggle-button'));

        await waitFor(() => expect(scheduleSpy).toHaveBeenCalledWith(startAt + 120_000, TIMER_TEST_UID));
        expect(mockGetStudyCheckDevOverride).toHaveBeenCalled();
        expect(Notifications.scheduleNotificationAsync).toHaveBeenLastCalledWith(
          expect.objectContaining({
            identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
            trigger: { type: 'timeInterval', seconds: 120 },
          }),
        );
      });

      it('短縮設定の通知に150秒時点で応答すると、開始から240秒後の通知を残り90秒で予約する', async () => {
        const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
        jest.setSystemTime(startAt);
        await renderTimerRouter();

        await waitFor(() => screen.getByTestId('timer-toggle-button'));
        await fireEvent.press(screen.getByTestId('timer-toggle-button'));
        await waitFor(() => expect(scheduleSpy).toHaveBeenCalledWith(startAt + 120_000, TIMER_TEST_UID));

        await act(async () => {
          jest.advanceTimersByTime(150_000); // 確認(120秒)から応答期限(180秒)までの間
        });
        await waitFor(() => screen.getByTestId('study-check-overlay'));
        const handleResponse = getLatestNotificationResponseHandler();
        scheduleSpy.mockClear();
        (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();
        (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();

        await act(async () => {
          handleResponse(makeStudyCheckResponse(Date.now()));
        });

        await waitFor(() => expect(scheduleSpy).toHaveBeenCalledWith(startAt + 240_000, TIMER_TEST_UID));
        expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'confirm', clientTimeMs: startAt + 150_000 }),
          expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
        );
        expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
          STUDY_CHECK_NOTIFICATION_IDENTIFIER,
        );
        expect(Notifications.scheduleNotificationAsync).toHaveBeenLastCalledWith(
          expect.objectContaining({
            identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
            trigger: { type: 'timeInterval', seconds: 90 },
          }),
        );
        await waitFor(() => expect(screen.queryByTestId('study-check-overlay')).toBeNull());
        expect(screen.getByTestId('timer-status-text')).toBeTruthy();
      });
    });

    it('確認OFFのときは通知を予約しない', async () => {
      mockFetchCheckEnabled.mockResolvedValue(false);
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('停止すると予約していた通知を取り消す', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();

      await fireEvent.press(screen.getByTestId('timer-toggle-button'));

      await waitFor(() =>
        expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
          STUDY_CHECK_NOTIFICATION_IDENTIFIER,
        ),
      );
    });

    it('アプリ内の確認に応答すると、予約を取り消して次の確認(120分後)を予約する', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      await waitFor(() => screen.getByTestId('study-check-overlay'));
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();
      (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

      await fireEvent.press(screen.getByTestId('study-check-confirm-button'));

      await waitFor(() =>
        expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
          STUDY_CHECK_NOTIFICATION_IDENTIFIER,
        ),
      );
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
          trigger: { type: 'timeInterval', seconds: 60 * 60 },
        }),
      );
    });

    it('初めて開始したときだけ通知の許可を求める', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button')); // start
      await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));

      await fireEvent.press(screen.getByTestId('timer-toggle-button')); // stop
      await fireEvent.press(screen.getByTestId('timer-toggle-button')); // start (2回目)

      await waitFor(() => screen.getByTestId('timer-status-text'));
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('起動中に通知のアクション「勉強中」が押されると confirm が送られ、次の確認が予約される', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      await waitFor(() => screen.getByTestId('study-check-overlay'));

      const handleResponse = getLatestNotificationResponseHandler();
      (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

      await act(async () => {
        handleResponse(makeStudyCheckResponse(Date.now()));
      });

      await waitFor(() => expect(screen.queryByTestId('study-check-overlay')).toBeNull());
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'confirm' }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
      await waitFor(() =>
        expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
          expect.objectContaining({ trigger: { type: 'timeInterval', seconds: 60 * 60 } }),
        ),
      );
    });

    it('起動時に、通知のアクション「勉強中」への最後の応答があれば confirm として扱う(getLastNotificationResponse)', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      await startLocalSession(startAt, 'seeded-session', true);
      const respondedAt = startAt + 65 * 60 * 1000; // 1回目の確認(60分)〜期限(70分)の間
      jest.setSystemTime(respondedAt);
      (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(
        makeStudyCheckResponse(respondedAt),
      );

      await renderTimerRouter();

      await waitFor(() =>
        expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'seeded-session', action: 'confirm', clientTimeMs: respondedAt }),
          expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
        ),
      );
      expect(screen.queryByTestId('study-check-overlay')).toBeNull();
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
    });

    it('応答期限を過ぎてから届いた通知の応答は無視し、すでに無応答として自動停止する', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      await startLocalSession(startAt, 'seeded-session', true);
      const lateRespondedAt = startAt + 75 * 60 * 1000; // 1回目の確認(60分)の期限(70分)を過ぎている
      jest.setSystemTime(lateRespondedAt);
      (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(
        makeStudyCheckResponse(lateRespondedAt),
      );

      await renderTimerRouter();

      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      await waitFor(() => screen.getByTestId('timer-auto-stop-notice'));
      expect(mockEnqueueAndSendStudyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'confirm' }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop', clientTimeMs: checkAt(startAt, 1) }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
    });

    it('確認が ON で通知が許可されていないとき、タイマー画面に案内を出す', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied', granted: false });
      jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-notification-permission-notice'));
      expect(screen.getByTestId('timer-notification-permission-notice').props.children).toBe(
        '通知がオフのため、アプリを閉じていると計測開始から60分で計測が止まります。設定アプリで通知を許可してください',
      );
    });

    it('通知が許可されているときは案内を出さない', async () => {
      jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      expect(screen.queryByTestId('timer-notification-permission-notice')).toBeNull();
    });

    it('確認が OFF のときは、通知が許可されていなくても案内を出さない', async () => {
      mockFetchCheckEnabled.mockResolvedValue(false);
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied', granted: false });
      jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      expect(screen.queryByTestId('timer-notification-permission-notice')).toBeNull();
    });
  });

  describe('ロック画面との同期(5-3c-5b。requirements 3-2「アプリとロック画面の計測の共有」)', () => {
    it('開始すると StudySync に正しい引数(sessionId・startAt・checkEnabled)で開始を伝え、確認の設定を覚えさせる', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));

      await waitFor(() => expect(mockNotifyNativeMeasurementStart).toHaveBeenCalledTimes(1));
      const [sessionId, startAtArg, checkEnabledArg] = mockNotifyNativeMeasurementStart.mock.calls[0] as [
        string,
        number,
        boolean,
      ];
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
      expect(startAtArg).toBe(startAt);
      expect(checkEnabledArg).toBe(true);
      expect(mockRememberCheckEnabledSetting).toHaveBeenCalledWith(true, TIMER_TEST_UID);
    });

    it('停止すると StudySync に開始と同じ sessionId で停止を伝える', async () => {
      jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => expect(mockNotifyNativeMeasurementStart).toHaveBeenCalledTimes(1));
      const [startedSessionId] = mockNotifyNativeMeasurementStart.mock.calls[0] as [string];

      await fireEvent.press(screen.getByTestId('timer-toggle-button'));

      await waitFor(() => expect(mockNotifyNativeMeasurementStop).toHaveBeenCalledWith(startedSessionId));
    });

    it('確認(「勉強中」ボタン)への応答で addNativeConfirmation を呼ぶ', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt);
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));
      await waitFor(() => screen.getByTestId('timer-status-text'));

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      await waitFor(() => screen.getByTestId('study-check-overlay'));

      await fireEvent.press(screen.getByTestId('study-check-confirm-button'));

      await waitFor(() => expect(mockAddNativeConfirmation).toHaveBeenCalled());
    });

    it('ロック画面で開始された状態を取り込み、続きとして表示する(サーバーには送らない)', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      jest.setSystemTime(startAt + 3 * 60 * 1000);
      mockReconcileWithLockscreen.mockResolvedValue({
        sessions: [
          { sessionId: 'lockscreen-session', startAt, stopAt: null, checkEnabled: true, confirmations: [] },
        ],
        changed: true,
      });

      await renderTimerRouter();

      await waitFor(() =>
        expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:03:00'),
      );
      expect(screen.getByTestId('timer-status-text')).toBeTruthy();
      // 取り込み(アプリ発の開始ではない)なので、アプリからの開始の送信は行わない
      expect(mockEnqueueAndSendStudyEvent).not.toHaveBeenCalled();
      expect(mockNotifyNativeMeasurementStart).not.toHaveBeenCalled();
    });

    it('ロック画面で止められた計測を stopAt で閉じる(お知らせは出さず、サーバーにも送らない)', async () => {
      const startAt = new Date('2026-10-10T10:00:00+09:00').getTime();
      await startLocalSession(startAt, 'session-1', true);
      const stopAt = startAt + 5 * 60 * 1000;
      jest.setSystemTime(startAt + 10 * 60 * 1000);
      mockReconcileWithLockscreen.mockResolvedValue({
        sessions: [{ sessionId: 'session-1', startAt, stopAt, checkEnabled: true, confirmations: [] }],
        changed: true,
      });

      await renderTimerRouter();

      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:00:00');
      expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 0時間5分');
      expect(screen.queryByTestId('timer-auto-stop-notice')).toBeNull();
      expect(mockEnqueueAndSendStudyEvent).not.toHaveBeenCalled();
    });

    it('StudySync の呼び出しが失敗(例外)しても、アプリの計測は続く', async () => {
      mockNotifyNativeMeasurementStart.mockRejectedValue(new Error('native error'));
      jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
      await renderTimerRouter();

      await waitFor(() => screen.getByTestId('timer-toggle-button'));
      await fireEvent.press(screen.getByTestId('timer-toggle-button'));

      await waitFor(() => screen.getByTestId('timer-status-text'));
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'start' }),
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
    });
  });
});


describe('P-042 daily targets after real tab return', () => {
  it('refreshes both target bars without remounting or changing measurement', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-14T10:00:00+09:00'));
    mockFetchActiveGoalDailyTargets.mockResolvedValue({ minDailyMinutes: 60, goalDailyMinutes: 120 });
    mockFetchCheckEnabled.mockResolvedValue(false);
    mockReconcileWithLockscreen.mockImplementation(async (sessions: unknown) => ({ sessions, changed: false }));
    try {
      await AsyncStorage.clear();
      await startLocalSession(Date.now() - 30 * 60000, 'p042-session', false);
      await renderTimerRouter();
      await waitFor(() => expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 0時間30分'));
      const timer = screen.getByTestId('timer-elapsed-text');
      await fireEvent.press(screen.getByText('ホーム'));
      mockFetchActiveGoalDailyTargets.mockResolvedValue({ minDailyMinutes: 120, goalDailyMinutes: 240 });
      await fireEvent.press(screen.getByText('タイマー'));
      await waitFor(() => {
        const fill = screen.getByTestId('timer-min-progress-bar-fill');
        expect(Object.assign({}, ...fill.props.style).width).toBe('25%');
      });
      expect(Object.assign({}, ...screen.getByTestId('timer-goal-progress-bar-fill').props.style).width).toBe('12.5%');
      expect(screen.getByTestId('timer-elapsed-text')).toBe(timer);
      expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 0時間30分');
    } finally {
      await cleanup();
      await AsyncStorage.clear();
      jest.useRealTimers();
      jest.clearAllMocks();
    }
  });
});
