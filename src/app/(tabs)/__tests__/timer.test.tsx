import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/**
 * タイマー画面(5-1a)の画面テスト。有効な目標の読み込み(activeGoalRepository)はモックにし、
 * renderRouter で実際の画面(下部タブを含む)を使って次を確認する(CLAUDE.md: router のモックで
 * 「呼ばれたこと」だけを確かめるテストにしない)。
 * - 開始前は 00:00:00
 * - 開始 → 停止で今日の勉強時間が増える
 * - 計測中は「勉強中」とタブの印が出る
 * - 再表示(アンマウント・再マウント)しても計測中なら経過時間が続く
 */
const mockFetchActiveGoalDailyTargets = jest.fn();
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalDailyTargets: mockFetchActiveGoalDailyTargets,
}));

/**
 * renderRouter の初期レンダリングを await act で包む(renderRouter 自体は同期的に返すが、
 * 内部の初期レンダリングが非同期の act を使うため。CLAUDE.md・backNavigation.test.tsx と同じ対策)
 */
async function renderTimerRouter(): Promise<void> {
  await act(async () => {
    renderRouter('src/app', { initialUrl: '/timer' });
  });
}

describe('タイマー画面(5-1a。requirements 3-2, 4-6)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetchActiveGoalDailyTargets.mockResolvedValue({
      minDailyMinutes: 60,
      goalDailyMinutes: 120,
    });
  });

  afterEach(async () => {
    cleanup();
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

    cleanup();

    jest.setSystemTime(new Date('2026-10-10T10:03:00+09:00'));
    await renderTimerRouter();

    await waitFor(() =>
      expect(screen.getByTestId('timer-elapsed-text').props.children).toBe('00:03:00'),
    );
    expect(screen.getByTestId('timer-status-text')).toBeTruthy();
  });
});
