import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AppState } from 'react-native';

import { startLocalSession } from '@/features/timer/storage';

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
 * AppState の 'change' イベントに登録された最後のハンドラを取り出す
 * (@react-native/jest-preset の AppState モックは addEventListener が jest.fn なので、
 * 呼び出し引数からハンドラを直接取り出して呼べる)
 */
function getLatestAppStateChangeHandler(): (state: string) => void {
  const addEventListener = AppState.addEventListener as jest.Mock;
  const call = [...addEventListener.mock.calls].reverse().find(([eventName]) => eventName === 'change');
  if (!call) {
    throw new Error("AppState.addEventListener('change', ...) が呼ばれていない");
  }
  return call[1];
}

describe('タイマー画面(5-1a・5-2b。requirements 3-2, 4-6)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetchActiveGoalDailyTargets.mockResolvedValue({
      minDailyMinutes: 60,
      goalDailyMinutes: 120,
    });
    mockFetchCheckEnabled.mockResolvedValue(true);
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
      await waitFor(() => screen.getByTestId('home-placeholder-text'));
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

      const handleAppStateChange = getLatestAppStateChangeHandler();
      mockFlushStudyEventQueue.mockClear();

      // タイマー(setInterval)を進めず、応答期限(70分)を過ぎた時刻まで一気に進める
      // (バックグラウンドで時間が過ぎ、前面に戻ったときの状況を再現する)
      jest.setSystemTime(startAt + 75 * 60 * 1000);
      await act(async () => {
        handleAppStateChange('active');
      });

      expect(mockFlushStudyEventQueue).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
      await waitFor(() => screen.getByTestId('timer-auto-stop-notice'));
      expect(mockEnqueueAndSendStudyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop', clientTimeMs: checkAt(startAt, 1) }),
      );
    });
  });
});
