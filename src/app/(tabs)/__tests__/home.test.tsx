import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import StudySync from '../../../../modules/study-sync/src/StudySyncModule';
import * as firebaseConfig from '@/config/firebase';
import { loadGoalReplacement } from '@/features/onboarding/replacementStorage';

import type { DateKey, HomeDailyResult, JudgementSession } from '@shared/index';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import type { HomeDataResult } from '@/features/home/homeDataRepository';
import { loadLocalSessions, startLocalSession } from '@/features/timer/storage';

jest.mock('@/features/billing/subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(async (uid: string) => ({
    uid, registered: true, xLinked: true, access: 'allowed' as const,
  })),
  subscribeSubscriptionAuth: jest.fn(() => jest.fn()),
}));

jest.mock('@/config/firebase', () => ({
  ...jest.requireActual<typeof import('@/config/firebase')>('@/config/firebase'),
  getCurrentUid: jest.fn(),
}));

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
 * ホーム画面(6-1。requirements 4-6)の画面テスト。
 * データの読み込み層(homeDataRepository)はモックにし、計算(shared/homeSummary.ts)は実物を使う
 * (CLAUDE.md: router のモックで「呼ばれたこと」だけを確かめるテストにしない。計算の正しさは
 * shared/__tests__/homeSummary.test.ts で確認済みのため、ここでは画面への反映を確認する)
 */
jest.mock('../../../../modules/study-sync/src/StudySyncModule');
jest.mock('@/features/deviceToken/useDeviceTokenSync', () => ({
  useDeviceTokenSync: jest.fn(),
}));
const mockGetXPending = jest.fn(async () => ({ pending: null }));
jest.mock('@/features/xLink/xLinkApi', () => ({
  xLinkApi: { getPending: mockGetXPending, begin: jest.fn(), complete: jest.fn(),
    confirm: jest.fn(), discard: jest.fn() },
}));
const mockLoadSettings = jest.fn();
const mockUpdateSettings = jest.fn();
jest.mock('@/features/settings/settingsRepository', () => ({ loadSettings: mockLoadSettings, updateSettings: mockUpdateSettings }));
const mockFetchHomeData = jest.fn();
const mockUpdateGoalNumbers = jest.fn();
jest.mock('@/features/goals/editGoalRepository', () => ({ updateGoalNumbers: mockUpdateGoalNumbers }));
jest.mock('@/features/home/homeDataRepository', () => ({
  fetchHomeData: mockFetchHomeData,
}));

const mockFetchDailyTargets = jest.fn(async () => ({ minDailyMinutes: 60, goalDailyMinutes: 120 }));
const mockFetchActiveGoalId = jest.fn();
jest.mock('@/features/goals/activeGoalRepository', () => ({
  fetchActiveGoalDailyTargets: mockFetchDailyTargets,
  fetchActiveGoalId: mockFetchActiveGoalId,
}));
const mockFetchCheckEnabled = jest.fn(async () => false);
jest.mock('@/features/timer/checkEnabledRepository', () => ({
  fetchCheckEnabled: mockFetchCheckEnabled,
}));
jest.mock('@/features/timer/studyEventSender', () => ({
  enqueueAndSendStudyEvent: jest.fn(async () => undefined),
  flushStudyEventQueue: jest.fn(async () => undefined),
}));
jest.mock('@/features/timer/lockscreenSync', () => ({
  notifyNativeMeasurementStart: jest.fn(async () => undefined),
  notifyNativeMeasurementStop: jest.fn(async () => undefined),
  addNativeConfirmation: jest.fn(async () => undefined),
  rememberCheckEnabledSetting: jest.fn(async () => undefined),
  reconcileWithLockscreen: jest.fn(async (sessions: unknown) => ({ sessions, changed: false })),
}));

beforeEach(() => {
  jest.mocked(firebaseConfig.getCurrentUid).mockReset().mockReturnValue('owner');
  jest.mocked(StudySync.isAccountOperationBlocked).mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function triggerAppStateChange(state: string): void {
  const listener = AppState.addEventListener as jest.Mock;
  // React Nativeのモックはremove後もmock.callsを保持する。実際に有効な購読だけに配る。
  listener.mock.calls.forEach(([event, handler], index) => {
    const subscription = listener.mock.results[index]?.value as { remove: jest.Mock } | undefined;
    if (event === 'change' && subscription?.remove.mock.calls.length === 0) {
      (handler as (state: string) => void)(state);
    }
  });
}

const GOAL_ID = 'goal-1';

/** ProgressBar の塗り(-fill)の幅を取り出す(src/components/__tests__/ProgressBar.test.tsx と同じ方法) */
function fillWidth(testID: string): unknown {
  const fill = screen.getByTestId(`${testID}-fill`);
  const style = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
  return style.width;
}

function okResult(overrides: {
  targetHours: number;
  startDate?: string;
  examDate?: string;
  dailyResults?: HomeDailyResult[];
  sessions?: JudgementSession[];
  notice?: { message: string } | null;
}): HomeDataResult {
  return {
    status: 'ok',
    data: {
      goalId: GOAL_ID,
      goal: {
        startDate: (overrides.startDate ?? '2026-10-01') as DateKey,
        examDate: (overrides.examDate ?? '2026-10-20') as DateKey,
        targetHours: overrides.targetHours,
      },
      dailyResults: overrides.dailyResults ?? [],
      sessions: overrides.sessions ?? [],
      notice: overrides.notice ?? null,
    },
  };
}

function dailyResult(
  date: string,
  studiedMinutes: number,
  metMin: boolean,
  metGoal: boolean,
): HomeDailyResult {
  return { date: date as DateKey, goalId: GOAL_ID, studiedMinutes, metMin, metGoal };
}

/** renderRouter の初期レンダリングを await act で包む(CLAUDE.md の決まり) */
async function renderHomeRouter(): Promise<void> {
  await act(async () => {
    renderRouter('src/app', { initialUrl: '/home' });
  });
}

describe('ホーム画面(6-1。requirements 4-6)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
  });

  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('0件(記録なし): 達成率0.0%、残り必要時間は目標そのまま、達成日数は0日/経過0日', async () => {
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10 }));
    await renderHomeRouter();

    await waitFor(() => expect(screen.getByTestId('home-percent-text').props.children).toBe('0.0%'));
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('0時間0分');
    expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと10日');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe(
      '残り必要時間 10時間0分',
    );
    expect(screen.getByTestId('home-met-min-days-text').props.children).toBe('0日 / 経過0日');
    expect(screen.getByTestId('home-met-goal-days-text').props.children).toBe('0日 / 経過0日');
    expect(screen.queryByTestId('home-notice-banner')).toBeNull();
  });

  it('途中: 判定済みの日から達成率・達成日数を計算する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 10, // 600分
        dailyResults: [
          dailyResult('2026-10-05', 120, true, false),
          dailyResult('2026-10-06', 30, false, false),
        ],
      }),
    );
    await renderHomeRouter();

    await waitFor(() => expect(screen.getByTestId('home-percent-text').props.children).toBe('25.0%'));
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間30分');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe(
      '残り必要時間 7時間30分',
    );
    expect(screen.getByTestId('home-met-min-days-text').props.children).toBe('1日 / 経過2日');
    expect(screen.getByTestId('home-met-goal-days-text').props.children).toBe('0日 / 経過2日');
  });

  it('100%超: 達成率は実数で表示し、進捗スライダーは満タンになる', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 1, // 60分
        dailyResults: [dailyResult('2026-10-05', 90, true, true)],
      }),
    );
    await renderHomeRouter();

    await waitFor(() => expect(screen.getByTestId('home-percent-text').props.children).toBe('150.0%'));
    expect(fillWidth('home-progress-bar')).toBe('100%');
  });

  it('残り必要時間が0未満: 「達成済み」と表示する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 1, // 60分
        dailyResults: [dailyResult('2026-10-05', 90, true, true)],
      }),
    );
    await renderHomeRouter();

    await waitFor(() =>
      expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe('達成済み'),
    );
  });

  it('3桁の区切り: 積み上げ時間・残り必要時間の時間に3桁ごとのカンマが入る(problem P-017)', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 2000, // 120,000分
        dailyResults: [dailyResult('2026-10-05', 75000, true, true)],
      }),
    );
    await renderHomeRouter();

    await waitFor(() =>
      expect(screen.getByTestId('home-accumulated-text').props.children).toBe('1,250時間0分'),
    );
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe(
      '残り必要時間 750時間0分',
    );
  });

  it('お知らせがあるとき: 一番上に表示する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({ targetHours: 10, notice: { message: 'X連携が切れています' } }),
    );
    await renderHomeRouter();

    await waitFor(() => screen.getByTestId('home-notice-banner'));
    expect(screen.getByTestId('home-notice-text').props.children).toBe('X連携が切れています');
  });

  it('お知らせがないとき: 表示しない', async () => {
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10, notice: null }));
    await renderHomeRouter();

    await waitFor(() => screen.getByTestId('home-percent-text'));
    expect(screen.queryByTestId('home-notice-banner')).toBeNull();
  });

  it('有効な目標がない場合は「目標未設定」と表示する(開発用のフォールバック)', async () => {
    mockFetchHomeData.mockResolvedValue({ status: 'no_goal' } satisfies HomeDataResult);
    await renderHomeRouter();

    await waitFor(() => screen.getByTestId('home-goal-not-set-text'));
  });

  it('通信エラー時は requirements 4-8 の文言と再試行ボタンを表示し、押すと読み直す', async () => {
    mockFetchHomeData.mockResolvedValueOnce({ status: 'error' } satisfies HomeDataResult);
    await renderHomeRouter();

    await waitFor(() => screen.getByTestId('home-error-text'));
    expect(screen.getByTestId('home-error-text').props.children).toBe(
      '通信できませんでした。電波の良い場所で再度お試しください',
    );

    mockFetchHomeData.mockResolvedValueOnce(okResult({ targetHours: 10 }));
    await fireEvent.press(screen.getByTestId('home-retry-button'));

    await waitFor(() => screen.getByTestId('home-percent-text'));
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
  });

  it('試験日が今日: 完了表示と次の目標ボタンを表示し、他の数値を保持する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 10,
        examDate: '2026-10-10', // システム時刻(2026-10-10)と同日
        dailyResults: [dailyResult('2026-10-05', 120, true, false)],
      }),
    );
    await renderHomeRouter();

    await waitFor(() => expect(screen.getByTestId('home-percent-text').props.children).toBe('20.0%'));
    expect(screen.getByTestId('home-days-until-exam-text')).toHaveTextContent('お疲れさまでした');
    expect(screen.getByTestId('home-next-goal-button')).toHaveTextContent('次の目標を設定');
    expect(screen.getByTestId('home-met-min-days-text')).toHaveTextContent('1日 / 経過1日');
    expect(screen.getByTestId('home-met-goal-days-text')).toHaveTextContent('0日 / 経過1日');
    expect(fillWidth('home-progress-bar')).toBe('20%');
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe(
      '残り必要時間 8時間0分',
    );
    expect(screen.getByTestId('home-met-min-days-text').props.children).toBe('1日 / 経過1日');
  });

  it('試験日を過ぎた: 完了表示と次の目標ボタンを表示し、他の数値を保持する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 10,
        examDate: '2026-10-05', // システム時刻(2026-10-10)より前
        dailyResults: [dailyResult('2026-10-05', 120, true, false)],
      }),
    );
    await renderHomeRouter();

    await waitFor(() => expect(screen.getByTestId('home-percent-text').props.children).toBe('20.0%'));
    expect(screen.getByTestId('home-days-until-exam-text')).toHaveTextContent('お疲れさまでした');
    expect(screen.getByTestId('home-next-goal-button')).toHaveTextContent('次の目標を設定');
    expect(screen.getByTestId('home-met-min-days-text')).toHaveTextContent('1日 / 経過1日');
    expect(screen.getByTestId('home-met-goal-days-text')).toHaveTextContent('0日 / 経過1日');
    expect(fillWidth('home-progress-bar')).toBe('20%');
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe(
      '残り必要時間 8時間0分',
    );
  });

  it('試験日の前日(境界): 「あと1日」と表示する', async () => {
    mockFetchHomeData.mockResolvedValue(
      okResult({
        targetHours: 10,
        examDate: '2026-10-11', // システム時刻(2026-10-10)の翌日
      }),
    );
    await renderHomeRouter();

    await waitFor(() =>
      expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと1日'),
    );
    expect(screen.queryByText('お疲れさまでした')).toBeNull();
    expect(screen.queryByTestId('home-next-goal-button')).toBeNull();
  });

  it('編集ボタンがある(押したときの動きは 6-2a で実装)', async () => {
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10 }));
    await renderHomeRouter();

    await waitFor(() => screen.getByTestId('home-edit-button'));
  });

  it('Home→Timer→Home: 計測後のサーバー記録を再取得して表示する(P-040)', async () => {
    const startAt = Date.now();
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10 }));
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    const home = screen.getByTestId('home-screen');

    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => screen.getByTestId('timer-status-text'));
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10, sessions: [{
      id: 'recorded', goalId: GOAL_ID, startAt, stopAt: Date.now(),
      checkEnabled: false, confirmations: [],
    }] }));
    await fireEvent.press(screen.getByText('ホーム'));
    await waitFor(() => expect(screen.getByTestId('home-accumulated-text').props.children).toBe('0時間1分'));
    expect(screen.getByTestId('home-screen')).toBe(home);
    expect(screen.getByTestId('home-percent-text').props.children).toBe('0.1%');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe('残り必要時間 9時間59分');
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
  });

  it('取得済みの計測中セッションは時間経過で再計算し、毎秒の通信をしない(P-040)', async () => {
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10, sessions: [{
      id: 'running', goalId: GOAL_ID, startAt: Date.now(), stopAt: null,
      checkEnabled: false, confirmations: [],
    }] }));
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('0時間1分');
    expect(screen.getByTestId('home-remaining-minutes-text').props.children).toBe('残り必要時間 9時間59分');
    expect(mockFetchHomeData).toHaveBeenCalledTimes(1);
  });

  it('前面復帰で日付とサーバーの確定結果を更新する(P-040)', async () => {
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10 }));
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await act(async () => { triggerAppStateChange('background'); });
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10,
      dailyResults: [dailyResult('2026-10-10', 120, true, false)],
    }));
    jest.setSystemTime(new Date('2026-10-11T00:01:00+09:00'));
    await act(async () => { triggerAppStateChange('active'); });
    await waitFor(() => expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分'));
    expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと9日');
    expect(screen.getByTestId('home-met-min-days-text').props.children).toBe('1日 / 経過1日');
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
  });

  it('日本時間0:00で再取得し、dailyResultsをセッションより優先する(P-040)', async () => {
    jest.setSystemTime(new Date('2026-10-10T23:59:59+09:00'));
    const data = { targetHours: 10, sessions: [{ id: 'running', goalId: GOAL_ID,
      startAt: new Date('2026-10-10T23:00:00+09:00').getTime(), stopAt: null,
      checkEnabled: false, confirmations: [],
    }] };
    mockFetchHomeData.mockResolvedValue(okResult(data));
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    mockFetchHomeData.mockResolvedValue(okResult({ ...data,
      dailyResults: [dailyResult('2026-10-10', 90, true, true)],
    }));
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await waitFor(() => expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと9日'));
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('1時間30分');
    expect(screen.getByTestId('home-met-goal-days-text').props.children).toBe('1日 / 経過1日');
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('1時間31分');
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
  });


  it('非表示・バックグラウンドでは日付が変わってもHomeの通信をしない(P-040)', async () => {
    jest.setSystemTime(new Date('2026-10-10T23:59:59+09:00'));
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10 }));
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await fireEvent.press(screen.getByText('タイマー'));
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(mockFetchHomeData).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('ホーム'));
    await waitFor(() => expect(mockFetchHomeData).toHaveBeenCalledTimes(2));
    await act(async () => { triggerAppStateChange('background'); });
    jest.setSystemTime(new Date('2026-10-12T00:00:00+09:00'));
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('home-days-until-exam-text', { includeHiddenElements: true }).props.children).toBe('あと9日');
    await act(async () => { triggerAppStateChange('active'); });
    await waitFor(() => expect(mockFetchHomeData).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと8日');
  });

  it('前面復帰後の取得結果を、復帰前の遅い取得で上書きしない(P-040)', async () => {
    let resolveOld!: (result: HomeDataResult) => void;
    mockFetchHomeData.mockImplementationOnce(() => new Promise<HomeDataResult>((resolve) => {
      resolveOld = resolve;
    }));
    await renderHomeRouter();
    await waitFor(() => expect(mockFetchHomeData).toHaveBeenCalledTimes(1));
    await act(async () => { triggerAppStateChange('background'); });
    mockFetchHomeData.mockResolvedValue(okResult({ targetHours: 10,
      dailyResults: [dailyResult('2026-10-09', 120, true, false)],
    }));
    await act(async () => { triggerAppStateChange('active'); });
    await waitFor(() => expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分'));
    await act(async () => { resolveOld(okResult({ targetHours: 10 })); });
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分');
    expect(mockFetchHomeData).toHaveBeenCalledTimes(2);
  });

});


describe('6-2a goal edit popup through real tabs', () => {
  const goalDocument = {
    type: 'exam' as const, university: '大学', targetDeviation: 60.1, currentDeviation: 50.1, subjectCount: 3,
    estimatedHours: { status: 'ok' as const, lowerHours: 900, upperHours: 1500 },
    targetHours: 10, examDate: '2026-10-20' as DateKey, startDate: '2026-10-01' as DateKey,
    status: 'active' as const, createdAt: 1, minDailyMinutes: 60, goalDailyMinutes: 120,
  };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    const result = okResult({ targetHours: 10, dailyResults: [dailyResult('2026-10-05', 120, true, true)] });
    if (result.status === 'ok') result.data.goalDocument = goalDocument;
    mockFetchHomeData.mockResolvedValue(result);
    mockUpdateGoalNumbers.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
    jest.useRealTimers();
    jest.clearAllMocks();
    mockUpdateGoalNumbers.mockReset();
  });
  async function openEdit() {
    await renderHomeRouter();
    await waitFor(() => expect(screen.getByTestId('home-percent-text')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-numbers'));
  }


  it('7-1c A: settings dirty blocks relink; cancel/reopen enters relink and explicitly returns home', async () => {
    mockLoadSettings.mockResolvedValue({ uid: 'home-test-user', checkEnabled: true, xPostEnabled: false });
    jest.mocked(firebaseConfig.getCurrentUid).mockReturnValue('home-test-user');
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-x-relink')).toBeEnabled());
    await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', false);
    await fireEvent.press(screen.getByTestId('settings-x-relink'));
    expect(screen.getByTestId('settings-x-relink-dirty')).toBeTruthy();
    expect(mockGetXPending).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('settings-cancel'));
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-x-relink')).toBeEnabled());
    await fireEvent.press(screen.getByTestId('settings-x-relink'));
    await waitFor(() => expect(screen.getByTestId('x-link-home')).toBeTruthy());
    expect(screen.queryByTestId('settings-popup')).toBeNull();
    expect(mockGetXPending).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('x-link-home'));
    await waitFor(() => expect(screen.getByTestId('home-screen')).toBeTruthy());
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('prefills all fields; cancel discards and reopens original values', async () => {
    await openEdit();
    expect(screen.getByTestId('edit-target-hours-input').props.value).toBe('10');
    expect(screen.getByTestId('edit-target-deviation-input').props.value).toBe('60.1');
    expect(screen.getByTestId('edit-current-deviation-input').props.value).toBe('50.1');
    expect(screen.getByTestId('edit-min-value').props.children).toBe('1時間0分');
    expect(screen.getByTestId('edit-goal-value').props.children).toBe('2時間0分');
    await fireEvent.changeText(screen.getByTestId('edit-target-hours-input'), '20');
    await fireEvent.press(screen.getByTestId('edit-subject-increment'));
    await fireEvent.press(screen.getByTestId('edit-cancel'));
    expect(screen.queryByTestId('goal-edit-popup')).toBeNull();
    expect(mockUpdateGoalNumbers).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-numbers'));
    expect(screen.getByTestId('edit-target-hours-input').props.value).toBe('10');
    expect(screen.getByTestId('edit-subject-value').props.children).toBe(3);
  });

  it('changes all fields, saves once, closes, recalculates without resetting accumulated/history', async () => {
    await openEdit();
    await fireEvent.changeText(screen.getByTestId('edit-target-hours-input'), '20');
    await fireEvent.changeText(screen.getByTestId('edit-target-deviation-input'), '70.1');
    await fireEvent.changeText(screen.getByTestId('edit-current-deviation-input'), '55.1');
    await fireEvent.press(screen.getByTestId('edit-subject-increment'));
    expect(screen.getByTestId('edit-target-hours-input').props.value).toBe('20');
    await fireEvent.press(screen.getByTestId('edit-exam-date-open'));
    await fireEvent(screen.getByTestId('edit-exam-date-picker'), 'change', { type: 'set' }, new Date(2026, 9, 30));
    for (const field of ['min', 'goal']) {
      await fireEvent.press(screen.getByTestId(`edit-${field}-row`));
      await fireEvent(screen.getByTestId('edit-hour-picker'), 'valueChange', field === 'min' ? 2 : 3);
      await fireEvent(screen.getByTestId('edit-minute-picker'), 'valueChange', 10);
      await fireEvent.press(screen.getByTestId('edit-time-done'));
    }
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.queryByTestId('goal-edit-popup')).toBeNull());
    expect(mockUpdateGoalNumbers).toHaveBeenCalledTimes(1);
    expect(mockUpdateGoalNumbers).toHaveBeenCalledWith('goal-1', 'exam', {
      targetHoursText: '20', examDate: '2026-10-30', targetDeviationText: '70.1', currentDeviationText: '55.1',
      subjectCount: 4, minDailyMinutes: 130, goalDailyMinutes: 190,
    }, expect.any(Number));
    expect(screen.getByTestId('home-percent-text').props.children).toBe('10.0%');
    expect(screen.getByTestId('home-days-until-exam-text').props.children).toBe('あと20日');
    expect(screen.getByTestId('home-accumulated-text').props.children).toBe('2時間0分');
    expect(screen.getByTestId('home-met-min-days-text').props.children).toBe('1日 / 経過1日');
  });

  it('invalid input disables save, offline retains values and retries; deviation never auto changes hours', async () => {
    await openEdit();
    await fireEvent.changeText(screen.getByTestId('edit-target-deviation-input'), '75');
    expect(screen.getByTestId('edit-target-hours-input').props.value).toBe('10');
    await fireEvent.changeText(screen.getByTestId('edit-target-hours-input'), '0');
    expect(screen.getByTestId('edit-save')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('edit-target-hours-input'), '20');
    mockUpdateGoalNumbers.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.getByText('通信できませんでした。電波の良い場所で再度お試しください')).toBeTruthy());
    expect(screen.getByTestId('edit-target-hours-input').props.value).toBe('20');
    expect(screen.getByTestId('home-percent-text').props.children).toBe('20.0%');
    await fireEvent.press(screen.getByTestId('edit-retry'));
    await waitFor(() => expect(screen.queryByTestId('goal-edit-popup')).toBeNull());
    expect(mockUpdateGoalNumbers).toHaveBeenCalledTimes(2);
  });

  it('save propagates new daily targets to the already-mounted timer on actual tab return (P-042)', async () => {
    await startLocalSession(Date.now() - 30 * 60000, 'edit-propagation', false);
    await openEdit();
    await fireEvent.press(screen.getByTestId('edit-cancel'));
    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => expect(fillWidth('timer-min-progress-bar')).toBe('50%'));
    const timer = screen.getByTestId('timer-elapsed-text');
    await fireEvent.press(screen.getByText('ホーム'));
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-numbers'));
    for (const field of ['min', 'goal']) {
      await fireEvent.press(screen.getByTestId(`edit-${field}-row`));
      await fireEvent(screen.getByTestId('edit-hour-picker'), 'valueChange', field === 'min' ? 2 : 4);
      await fireEvent.press(screen.getByTestId('edit-time-done'));
    }
    mockUpdateGoalNumbers.mockImplementationOnce(async (_id, _type, draft) => {
      mockFetchDailyTargets.mockResolvedValue({ minDailyMinutes: draft.minDailyMinutes, goalDailyMinutes: draft.goalDailyMinutes });
    });
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.queryByTestId('goal-edit-popup')).toBeNull());
    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => expect(fillWidth('timer-min-progress-bar')).toBe('25%'));
    expect(fillWidth('timer-goal-progress-bar')).toBe('12.5%');
    expect(screen.getByTestId('timer-elapsed-text')).toBe(timer);
    expect(screen.getByTestId('timer-today-total-text').props.children).toBe('今日の勉強時間 0時間30分');
    mockFetchDailyTargets.mockResolvedValue({ minDailyMinutes: 60, goalDailyMinutes: 120 });
  });

  it('drum opening uses current values, same-value done confirms, clamps 0/16h and rejects effort below minimum', async () => {
    await openEdit();
    await fireEvent.press(screen.getByTestId('edit-min-row'));
    expect(screen.getByTestId('edit-hour-picker').props.selectedValue).toBe(1);
    expect(screen.getByTestId('edit-minute-picker').props.selectedValue).toBe(0);
    await fireEvent.press(screen.getByTestId('edit-time-done'));
    expect(screen.getByTestId('edit-min-value').props.children).toBe('1時間0分');
    await fireEvent.press(screen.getByTestId('edit-min-row'));
    await fireEvent(screen.getByTestId('edit-hour-picker'), 'valueChange', 0);
    expect(screen.getByTestId('edit-minute-picker').props.selectedValue).toBe(10);
    await fireEvent(screen.getByTestId('edit-hour-picker'), 'valueChange', 16);
    expect(screen.getByTestId('edit-minute-picker').props.selectedValue).toBe(0);
    await fireEvent.press(screen.getByTestId('edit-time-done'));
    expect(screen.getByTestId('edit-min-value').props.children).toBe('16時間0分');
    expect(screen.getByTestId('edit-save')).toBeDisabled();
  });

  it('keeps calendar prefill and disables save when chosen tomorrow becomes today in JST', async () => {
    await openEdit();
    await fireEvent.press(screen.getByTestId('edit-exam-date-open'));
    expect(screen.getByTestId('edit-exam-date-picker').props.value).toEqual(new Date(2026, 9, 20));
    await fireEvent(screen.getByTestId('edit-exam-date-picker'), 'change', { type: 'set' }, new Date(2026, 9, 11));
    expect(screen.getByTestId('edit-save')).not.toBeDisabled();
    jest.setSystemTime(new Date('2026-10-11T00:00:00+09:00'));
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(screen.getByTestId('edit-save')).toBeDisabled();
    expect(mockUpdateGoalNumbers).not.toHaveBeenCalled();
  });

  it('cert hides exam fields', async () => {
    const result = okResult({ targetHours: 10 });
    if (result.status === 'ok') result.data.goalDocument = { type: 'cert', certId: 'other', certOtherName: '資格',
      estimatedHours: null, targetHours: 10, examDate: '2026-10-20', startDate: '2026-10-01', status: 'active',
      createdAt: 1, minDailyMinutes: 60, goalDailyMinutes: 120 };
    mockFetchHomeData.mockResolvedValue(result);
    await openEdit();
    expect(screen.queryByTestId('edit-target-deviation-input')).toBeNull();
    expect(screen.queryByTestId('edit-subject-value')).toBeNull();
    await fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(screen.queryByTestId('goal-edit-popup')).toBeNull());
    expect(mockUpdateGoalNumbers.mock.calls[0][1]).toBe('cert');
  });
});


describe('6-2b settings through actual Home/Timer routes', () => {
  let persisted: { uid: string; checkEnabled: boolean; xPostEnabled: boolean };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T10:00:00+09:00'));
    persisted = { uid: 'owner', checkEnabled: false, xPostEnabled: false };
    const result = okResult({ targetHours: 10 });
    if (result.status === 'ok') result.data.goalDocument = { type: 'cert', certId: 'other', certOtherName: '資格',
      estimatedHours: null, targetHours: 10, examDate: '2026-10-20', startDate: '2026-10-01', status: 'active',
      createdAt: 1, minDailyMinutes: 60, goalDailyMinutes: 120 };
    mockFetchHomeData.mockResolvedValue(result);
    mockLoadSettings.mockImplementation(async () => ({ ...persisted }));
    mockUpdateSettings.mockImplementation(async (uid, patch) => { persisted = { uid, ...patch }; });
    mockFetchCheckEnabled.mockImplementation(async () => persisted.checkEnabled);
  });
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
    jest.useRealTimers();
    jest.clearAllMocks();
    mockFetchCheckEnabled.mockImplementation(async () => false);
  });
  async function openSettings() {
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    expect(screen.getByText('目標の数値')).toBeTruthy();
    expect(screen.getByText('設定とリンク')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('home-edit-settings'));
    await waitFor(() => screen.getByTestId('settings-check-toggle'));
  }
  it('menu cancel returns home; settings cancel discards; save closes and reopens saved values after a tab hop', async () => {
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await fireEvent.press(screen.getByTestId('home-edit-button'));
    await fireEvent.press(screen.getByTestId('home-edit-menu-cancel'));
    expect(screen.queryByTestId('home-edit-menu')).toBeNull();
    await openSettings();
    await fireEvent(screen.getByTestId('settings-x-toggle'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('settings-cancel'));
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    await openSettings();
    expect(screen.getByTestId('settings-x-toggle').props.value).toBe(false);
    await fireEvent(screen.getByTestId('settings-x-toggle'), 'valueChange', true);
    await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('settings-save'));
    await waitFor(() => expect(screen.queryByTestId('settings-popup')).toBeNull());
    expect(mockUpdateSettings).toHaveBeenCalledWith('owner', { checkEnabled: true, xPostEnabled: true });
    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByText('ホーム'));
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await openSettings();
    expect(screen.getByTestId('settings-check-toggle').props.value).toBe(true);
    expect(screen.getByTestId('settings-x-toggle').props.value).toBe(true);
  });
  it('settings saved during measurement retain active snapshot/history and apply only to the next start', async () => {
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => screen.getByTestId('timer-toggle-button'));
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => screen.getByTestId('timer-status-text'));
    const before = await loadLocalSessions();
    expect(before[0].checkEnabled).toBe(false);
    await fireEvent.press(screen.getByText('ホーム'));
    await waitFor(() => screen.getByTestId('home-percent-text'));
    await openSettings();
    await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('settings-save'));
    await waitFor(() => expect(screen.queryByTestId('settings-popup')).toBeNull());
    expect(await loadLocalSessions()).toEqual(before);
    await fireEvent.press(screen.getByText('タイマー'));
    await waitFor(() => screen.getByTestId('timer-status-text'));
    expect(await loadLocalSessions()).toEqual(before);
    await act(async () => { jest.advanceTimersByTime(1000); });
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => expect(screen.queryByTestId('timer-status-text')).toBeNull());
    await fireEvent.press(screen.getByTestId('timer-toggle-button'));
    await waitFor(() => screen.getByTestId('timer-status-text'));
    const after = await loadLocalSessions();
    expect(after.find((session) => session.stopAt === null)?.checkEnabled).toBe(true);
    expect(after.find((session) => session.sessionId === before[0].sessionId)?.checkEnabled).toBe(false);
    expect(after.find((session) => session.sessionId === before[0].sessionId)?.confirmations).toEqual(before[0].confirmations);
  });
});

describe('ホーム画面(6-3b。試験日以降)', () => {
  const uid = 'home-next-goal-user';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T00:00:00+09:00'));
    jest.mocked(firebaseConfig.getCurrentUid).mockReturnValue(uid);
    mockFetchActiveGoalId.mockResolvedValue(GOAL_ID);
    jest.mocked(StudySync.getActiveSession).mockReturnValue(null);
    mockFetchHomeData.mockResolvedValue(okResult({
      targetHours: 10,
      examDate: '2026-10-10',
      dailyResults: [dailyResult('2026-10-05', 120, true, false)],
    }));
  });

  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
    jest.mocked(StudySync.getActiveSession).mockReturnValue(null);
    jest.restoreAllMocks();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('表示中にJST前日23:59:59から当日0:00へ切り替わる', async () => {
    jest.setSystemTime(new Date('2026-10-09T14:59:59Z'));
    await renderHomeRouter();
    await waitFor(() =>
      expect(screen.getByTestId('home-days-until-exam-text')).toHaveTextContent('あと1日'),
    );
    expect(screen.queryByTestId('home-next-goal-button')).toBeNull();

    await act(async () => { jest.advanceTimersByTime(1000); });

    await waitFor(() =>
      expect(screen.getByTestId('home-days-until-exam-text')).toHaveTextContent('お疲れさまでした'),
    );
    expect(screen.getByTestId('home-next-goal-button')).toBeEnabled();
    expect(screen.getByTestId('home-percent-text')).toHaveTextContent('20.0%');
    expect(fillWidth('home-progress-bar')).toBe('20%');
    expect(screen.getByTestId('home-accumulated-text')).toHaveTextContent('2時間0分');
    expect(screen.getByTestId('home-remaining-minutes-text')).toHaveTextContent('残り必要時間 8時間0分');
    expect(screen.getByTestId('home-met-min-days-text')).toHaveTextContent('1日 / 経過1日');
    expect(screen.getByTestId('home-met-goal-days-text')).toHaveTextContent('0日 / 経過1日');
  });

  it('次の目標→既存確認→空欄入力へ進み、明示的な戻るでホームへ戻る', async () => {
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-next-goal-button'));
    await fireEvent.press(screen.getByTestId('home-next-goal-button'));
    await waitFor(() => screen.getByText('積み上げ時間は0からになります'));
    expect(await loadGoalReplacement(uid)).toBeNull();

    await fireEvent.press(screen.getByTestId('home-replace-cancel'));
    expect(screen.queryByTestId('home-replace-dialog')).toBeNull();

    await fireEvent.press(screen.getByTestId('home-next-goal-button'));
    await waitFor(() => screen.getByTestId('home-replace-confirm'));
    await fireEvent.press(screen.getByTestId('home-replace-confirm'));
    await waitFor(() => screen.getByTestId('route-select-exam-button'));
    await fireEvent.press(screen.getByTestId('route-select-exam-button'));
    await waitFor(() => screen.getByTestId('university-input'));
    expect(screen.getByTestId('university-input').props.value).toBe('');

    await fireEvent.press(screen.getByTestId('university-back-button'));
    await waitFor(() => screen.getByTestId('route-select-back-button'));
    await fireEvent.press(screen.getByTestId('route-select-back-button'));
    await waitFor(() => screen.getByTestId('home-next-goal-button'));
    expect(await loadGoalReplacement(uid)).toBeNull();
  });

  it('計測中は次の目標を開始せず、ホーム上に停止案内を表示する', async () => {
    await startLocalSession(Date.now(), 'next-goal-active-session', false);
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-next-goal-button'));
    await fireEvent.press(screen.getByTestId('home-next-goal-button'));

    await waitFor(() =>
      expect(screen.getByTestId('home-next-goal-error'))
        .toHaveTextContent('計測中です。先にタイマーを停止してください'),
    );
    expect(screen.queryByTestId('home-replace-dialog')).toBeNull();
    expect(await loadGoalReplacement(uid)).toBeNull();
  });

  it('確認後にUIDが変わった場合は入力へ進まず保存しない', async () => {
    await renderHomeRouter();
    await waitFor(() => screen.getByTestId('home-next-goal-button'));
    await fireEvent.press(screen.getByTestId('home-next-goal-button'));
    await waitFor(() => screen.getByTestId('home-replace-confirm'));
    jest.mocked(firebaseConfig.getCurrentUid).mockReturnValue('other-home-user');

    await fireEvent.press(screen.getByTestId('home-replace-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('home-replace-error'))
        .toHaveTextContent('通信できませんでした。電波の良い場所で再度お試しください'),
    );
    expect(screen.queryByTestId('route-select-exam-button')).toBeNull();
    expect(await loadGoalReplacement(uid)).toBeNull();
    expect(await loadGoalReplacement('other-home-user')).toBeNull();
  });
});
