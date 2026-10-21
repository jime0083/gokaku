import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import StudySync from '../../../../modules/study-sync/src/StudySyncModule';
import { getCurrentUid } from '@/config/firebase';
import { fetchActiveGoalId } from '@/features/goals/activeGoalRepository';
import { replaceGoal } from '@/features/goals/replaceGoalRepository';
import { fetchHomeData } from '@/features/home/homeDataRepository';
import { loadGoalReplacement, saveGoalReplacement } from '@/features/onboarding/replacementStorage';
import { INITIAL_ONBOARDING_DRAFT } from '@/features/onboarding/types';
import { saveOnboardingDraft, loadOnboardingDraft } from '@/features/onboarding/storage';

jest.mock('@/features/billing/subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(async (uid: string) => ({
    uid, registered: true, xLinked: true, access: 'allowed' as const,
  })),
  subscribeSubscriptionAuth: jest.fn(() => jest.fn()),
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

jest.mock('../../../../modules/study-sync/src/StudySyncModule');
jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn(), connectFirebaseEmulatorsIfNeeded: jest.fn() }));
jest.mock('@/features/deviceToken/useDeviceTokenSync', () => ({ useDeviceTokenSync: jest.fn() }));
jest.mock('@/features/goals/activeGoalRepository', () => ({ fetchActiveGoalId: jest.fn(), fetchActiveGoalDailyTargets: jest.fn() }));
jest.mock('@/features/goals/replaceGoalRepository', () => ({ replaceGoal: jest.fn() }));
jest.mock('@/features/home/homeDataRepository', () => ({ fetchHomeData: jest.fn() }));
jest.mock('@/features/timer/studyEventSender', () => ({ flushStudyEventQueue: jest.fn(), enqueueAndSendStudyEvent: jest.fn() }));
const draft = { ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other', certOtherName: '検定', targetHoursText: '100', examDate: '2099-01-01' as const, minDailyMinutes: 10, goalDailyMinutes: 20 };
const goal = { type: 'cert' as const, certId: 'other', certOtherName: '旧検定', targetHours: 100, examDate: '2099-01-01' as const, minDailyMinutes: 10, goalDailyMinutes: 20, startDate: '2026-10-14' as const, status: 'active' as const, createdAt: 1, estimatedHours: null };
const home = { goalId: 'old', goal, goalDocument: goal, dailyResults: [], sessions: [], notice: null };
const record = { uid: 'router-user', expectedGoalId: 'old', draft };
async function open(url: string) { await act(async () => { renderRouter('src/app', { initialUrl: url }); }); }
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(StudySync.isAccountOperationBlocked).mockReturnValue(false);
  jest.mocked(getCurrentUid).mockReturnValue('router-user');
  jest.mocked(fetchActiveGoalId).mockResolvedValue('old');
  jest.mocked(fetchHomeData).mockResolvedValue({ status: 'ok', data: home });
  jest.mocked(StudySync.getActiveSession).mockReturnValue(null);
  jest.mocked(replaceGoal).mockImplementation(async () => {
    jest.mocked(fetchActiveGoalId).mockResolvedValue('new');
    return { goalId: 'new', goal: { ...goal, certOtherName: '検定' } };
  });
});
afterEach(async () => { await cleanup(); await AsyncStorage.clear(); });

it('Home確認→空欄入力→戻るで破棄しHomeへ。初回draftは保持', async () => {
  await saveOnboardingDraft({ ...INITIAL_ONBOARDING_DRAFT, university: '初回入力' });
  await open('/home');
  await waitFor(() => expect(screen.getByTestId('home-edit-button')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('home-edit-button'));
  await fireEvent.press(screen.getByTestId('home-replace-goal'));
  await waitFor(() => screen.getByText('積み上げ時間は0からになります'));
  expect(await loadGoalReplacement('router-user')).toBeNull();
  await fireEvent.press(screen.getByTestId('home-replace-confirm'));
  await waitFor(() => screen.getByTestId('route-select-exam-button'));
  await fireEvent.press(screen.getByTestId('route-select-exam-button'));
  await waitFor(() => screen.getByTestId('university-input'));
  expect(screen.getByTestId('university-input').props.value).toBe('');
  await fireEvent.changeText(screen.getByTestId('university-input'), '新大学');
  await fireEvent.press(screen.getByTestId('university-back-button'));
  await waitFor(() => screen.getByTestId('route-select-back-button'));
  await fireEvent.press(screen.getByTestId('route-select-back-button'));
  await waitFor(() => screen.getByTestId('home-screen'));
  expect(await loadGoalReplacement('router-user')).toBeNull();
  expect((await loadOnboardingDraft()).university).toBe('初回入力');
  expect(replaceGoal).not.toHaveBeenCalled();
});
it('native計測中はHomeから開始できず停止を案内', async () => {
  jest.mocked(StudySync.getActiveSession).mockReturnValue({ uid: 'router-user', goalId: 'old', sessionId: 's', startAt: Date.now(), checkEnabled: false, confirmations: [] });
  await open('/home'); await waitFor(() => expect(screen.getByTestId('home-edit-button')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('home-edit-button'));
  await fireEvent.press(screen.getByTestId('home-replace-goal'));
  await waitFor(() => screen.getByText('計測中です。先にタイマーを停止してください'));
  expect(screen.queryByTestId('home-replace-confirm')).toBeNull();
  expect(await loadGoalReplacement('router-user')).toBeNull();
});
it('同UIDの終了後再開→入力保持、修正で戻る→失敗保持→再試行成功でHomeを再取得', async () => {
  await saveGoalReplacement(record); await open('/');
  await waitFor(() => screen.getByTestId('pace-register-button'));
  await fireEvent.press(screen.getByTestId('pace-fix-button'));
  await waitFor(() => screen.getByTestId('daily-time-next-button'));
  expect(screen.getByTestId('min-daily-time-value')).toHaveTextContent('0時間10分');
  await fireEvent.press(screen.getByTestId('daily-time-next-button'));
  await waitFor(() => screen.getByTestId('pace-register-button'));
  jest.mocked(replaceGoal).mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByTestId('pace-register-button'));
  await waitFor(() => screen.getByTestId('pace-replacement-retry'));
  expect((await loadGoalReplacement('router-user'))?.draft).toEqual(draft);
  jest.mocked(fetchHomeData).mockResolvedValue({ status: 'ok', data: { ...home, goalId: 'new' } });
  await fireEvent.press(screen.getByTestId('pace-replacement-retry'));
  await waitFor(() => screen.getByTestId('home-percent-text'));
  expect(screen.getByTestId('home-percent-text')).toHaveTextContent('0.0%');
  expect(screen.getByTestId('home-accumulated-text')).toHaveTextContent('0時間0分');
  expect(StudySync.setCurrentGoalIdForAccount).toHaveBeenCalledWith('router-user', 'new');
  expect(await loadGoalReplacement('router-user')).toBeNull();
});
it('別UIDはreplacementを再開せず初回登録のno-opを維持', async () => {
  await saveGoalReplacement(record); jest.mocked(getCurrentUid).mockReturnValue('other-user');
  await saveOnboardingDraft(draft); await open('/onboarding/pace');
  await waitFor(() => screen.getByTestId('pace-register-button'));
  await fireEvent.press(screen.getByTestId('pace-register-button'));
  expect(replaceGoal).not.toHaveBeenCalled();
  expect((await loadGoalReplacement('router-user'))?.draft).toEqual(draft);
});

it('空欄の資格入力を最後まで登録し旧cacheを0にしてHomeへ', async () => {
  await AsyncStorage.setItem('timer:sessions:v1', JSON.stringify([{
    sessionId: 'old-session', startAt: Date.now() - 120000,
    stopAt: Date.now() - 60000, checkEnabled: false, confirmations: [],
  }]));
  await open('/home');
  await waitFor(() => expect(screen.getByTestId('home-edit-button')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('home-edit-button'));
  await fireEvent.press(screen.getByTestId('home-replace-goal'));
  await waitFor(() => screen.getByTestId('home-replace-confirm'));
  await fireEvent.press(screen.getByTestId('home-replace-confirm'));
  await waitFor(() => screen.getByTestId('route-select-cert-button'));
  await fireEvent.press(screen.getByTestId('route-select-cert-button'));
  await waitFor(() => screen.getByTestId('cert-row-other'));
  await fireEvent.press(screen.getByTestId('cert-row-other'));
  await waitFor(() => screen.getByTestId('cert-other-name-input'));
  expect(screen.getByTestId('cert-other-name-input').props.value).toBe('');
  await fireEvent.changeText(screen.getByTestId('cert-other-name-input'), '新検定');
  await fireEvent.press(screen.getByTestId('cert-select-next-button'));
  await waitFor(() => screen.getByTestId('target-hours-input'));
  expect(screen.getByTestId('target-hours-input').props.value).toBe('');
  await fireEvent.changeText(screen.getByTestId('target-hours-input'), '100');
  await fireEvent.press(screen.getByTestId('exam-date-select-button'));
  await fireEvent(screen.getByTestId('exam-date-picker'), 'change',
    { type: 'set' }, new Date('2099-01-01T03:00:00Z'));
  await waitFor(() => expect(screen.getByTestId('target-next-button')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('target-next-button'));
  await waitFor(() => screen.getByTestId('min-daily-time-row'));
  await fireEvent.press(screen.getByTestId('min-daily-time-row'));
  await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));
  await fireEvent.press(screen.getByTestId('goal-daily-time-row'));
  await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));
  await fireEvent.press(screen.getByTestId('daily-time-next-button'));
  await waitFor(() => screen.getByTestId('pace-register-button'));
  jest.mocked(fetchHomeData).mockResolvedValue({
    status: 'ok', data: { ...home, goalId: 'new' },
  });
  await fireEvent.press(screen.getByTestId('pace-register-button'));
  await waitFor(() => screen.getByTestId('home-percent-text'));
  expect(replaceGoal).toHaveBeenCalledTimes(1);
  expect(jest.mocked(replaceGoal).mock.calls[0][2]).toMatchObject({
    type: 'cert', certId: 'other', certOtherName: '新検定',
    targetHoursText: '100', examDate: '2099-01-01',
    minDailyMinutes: 10, goalDailyMinutes: 10,
  });
  expect(JSON.parse((await AsyncStorage.getItem('timer:sessions:v1'))!)).toEqual([]);
  expect(screen.getByTestId('home-accumulated-text')).toHaveTextContent('0時間0分');
  expect(screen.getByTestId('home-percent-text')).toHaveTextContent('0.0%');
  expect(await loadGoalReplacement('router-user')).toBeNull();
});

it('登録API待機中の重複pressと戻るで二重登録・入力破棄をしない', async () => {
  await saveGoalReplacement(record);
  await open('/onboarding/pace');
  await waitFor(() => screen.getByTestId('pace-register-button'));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  jest.mocked(replaceGoal).mockImplementationOnce(async () => {
    await pending;
    jest.mocked(fetchActiveGoalId).mockResolvedValue('new');
    return { goalId: 'new', goal };
  });
  let firstPress!: Promise<void>;
  await act(async () => {
    // fireEvent内部のactを閉じ、handler完了のPromiseはAPI解放後にawaitする。
    firstPress = fireEvent.press(screen.getByTestId('pace-register-button'));
  });
  try {
    await waitFor(() => expect(replaceGoal).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('pace-register-button')).toBeDisabled();
    expect(screen.getByTestId('pace-fix-button')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('pace-register-button'));
    await fireEvent.press(screen.getByTestId('pace-back-button'));
    expect(screen.getByTestId('pace-question-text')).toBeTruthy();
    expect(replaceGoal).toHaveBeenCalledTimes(1);
    expect((await loadGoalReplacement('router-user'))?.draft).toEqual(draft);
    jest.mocked(fetchHomeData).mockResolvedValue({
      status: 'ok', data: { ...home, goalId: 'new' },
    });
  } finally {
    await act(async () => {
      release();
      await firstPress;
    });
  }
  await waitFor(() => screen.getByTestId('home-screen'));
  expect(replaceGoal).toHaveBeenCalledTimes(1);
});

it('入力変更を保存し、画面を閉じて同UIDで開き直しても最新値から再開', async () => {
  await saveGoalReplacement({
    ...record,
    draft: { ...INITIAL_ONBOARDING_DRAFT, type: 'exam', university: '前の大学' },
  });
  await open('/onboarding/university');
  await waitFor(() => screen.getByTestId('university-input'));
  await fireEvent.changeText(screen.getByTestId('university-input'), '最新大学');
  await waitFor(() => expect(screen.getByTestId('university-input').props.value).toBe('最新大学'));
  expect((await loadGoalReplacement('router-user'))?.draft.university).toBe('最新大学');
  await cleanup();
  await open('/');
  await waitFor(() => screen.getByTestId('target-deviation-input'));
  await fireEvent.press(screen.getByTestId('deviation-back-button'));
  await waitFor(() => screen.getByTestId('university-input'));
  expect(screen.getByTestId('university-input').props.value).toBe('最新大学');
  expect(replaceGoal).not.toHaveBeenCalled();
});

it('途中入力後にnative計測開始なら最後の登録も拒否し入力を保持', async () => {
  await saveGoalReplacement(record);
  await open('/onboarding/pace');
  await waitFor(() => screen.getByTestId('pace-register-button'));
  jest.mocked(StudySync.getActiveSession).mockReturnValue({
    uid: 'router-user', goalId: 'old', sessionId: 'started-during-input',
    startAt: Date.now(), checkEnabled: false, confirmations: [],
  });
  await fireEvent.press(screen.getByTestId('pace-register-button'));
  await waitFor(() => screen.getByText('計測中です。先にタイマーを停止してください'));
  expect(replaceGoal).not.toHaveBeenCalled();
  expect((await loadGoalReplacement('router-user'))?.draft).toEqual(draft);
  expect(screen.getByTestId('pace-replacement-retry')).toBeEnabled();
});

it('committedIDの再起動後は後処理だけ再開し新しい停止済みcacheを保持', async () => {
  await saveGoalReplacement({
    ...record, committedGoalId: 'new', oldSessionIds: ['old-session'],
  });
  jest.mocked(fetchActiveGoalId).mockResolvedValue('new');
  const oldSession = {
    sessionId: 'old-session', startAt: 1, stopAt: 2,
    checkEnabled: false, confirmations: [],
  };
  const newSession = { ...oldSession, sessionId: 'new-session' };
  await AsyncStorage.setItem('timer:sessions:v1', JSON.stringify([oldSession, newSession]));
  await open('/');
  await waitFor(() => screen.getByTestId('pace-replacement-retry'));
  jest.mocked(fetchHomeData).mockResolvedValue({
    status: 'ok', data: { ...home, goalId: 'new' },
  });
  await fireEvent.press(screen.getByTestId('pace-replacement-retry'));
  await waitFor(() => screen.getByTestId('home-screen'));
  expect(replaceGoal).not.toHaveBeenCalled();
  expect(JSON.parse((await AsyncStorage.getItem('timer:sessions:v1'))!)).toEqual([newSession]);
  expect(await loadGoalReplacement('router-user')).toBeNull();
});
