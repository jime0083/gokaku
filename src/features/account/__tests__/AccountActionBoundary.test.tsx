import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AppState, Text, type AppStateStatus } from 'react-native';

import RootLayout from '@/app/_layout';
import HomeScreen from '@/app/(tabs)/home';
import LaunchScreen from '@/app/index';
import { getCurrentUid } from '@/config/firebase';
import { loadSubscriptionSession } from '@/features/billing/subscriptionRepository';
import { fetchHomeData } from '@/features/home/homeDataRepository';
import { loadGoalReplacement } from '@/features/onboarding/replacementStorage';
import { loadOnboardingDraft } from '@/features/onboarding/storage';
import { INITIAL_ONBOARDING_DRAFT } from '@/features/onboarding/types';
import { openSettingsLink } from '@/features/settings/settingsLinks';

import { accountActionService } from '../accountActionService';

jest.mock('@/features/xLink/relinkIntentStorage', () => ({
  loadRelinkIntent: jest.fn(async () => false),
  saveRelinkIntent: jest.fn(async () => {}),
  clearRelinkIntent: jest.fn(async () => {}),
}));

jest.mock('@/features/billing/subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(async (uid: string) => ({
    uid, registered: true, xLinked: true, access: 'allowed' as const,
  })),
  subscribeSubscriptionAuth: jest.fn(() => jest.fn()),
}));

jest.mock('../accountActionService', () => ({
  accountActionService: {
    inspectPending: jest.fn(),
    perform: jest.fn(),
    resume: jest.fn(),
  },
}));
jest.mock('../../../../modules/study-sync/src/StudySyncModule');
jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/deviceToken/useDeviceTokenSync', () => ({ useDeviceTokenSync: jest.fn() }));
jest.mock('@/features/home/homeDataRepository', () => ({ fetchHomeData: jest.fn() }));
jest.mock('@/features/onboarding/replacementStorage', () => ({ loadGoalReplacement: jest.fn() }));
jest.mock('@/features/onboarding/storage', () => ({ loadOnboardingDraft: jest.fn() }));
jest.mock('@/features/settings/settingsLinks', () => ({ openSettingsLink: jest.fn() }));

type Inspection = Awaited<ReturnType<typeof accountActionService.inspectPending>>;
type Outcome = Awaited<ReturnType<typeof accountActionService.perform>>;

const empty: Inspection = { checkpoint: null, nativeBlock: null, retryOnly: false };
const complete: Outcome = { result: { status: 'complete' }, retryOnly: false };
const incomplete: Outcome = {
  result: { status: 'incomplete', reason: 'retry-required' },
  retryOnly: true,
};
const checkpoint: Inspection = {
  checkpoint: { uid: 'account-a', action: 'logout', phase: 'cloud-pending' },
  nativeBlock: null,
  retryOnly: true,
};
const goal = {
  type: 'cert' as const, certId: 'other', certOtherName: '検定',
  targetHours: 100, examDate: '2099-01-01' as const,
  minDailyMinutes: 10, goalDailyMinutes: 20,
  startDate: '2026-10-14' as const, status: 'active' as const,
  createdAt: 1, estimatedHours: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const listeners = new Set<(status: AppStateStatus) => void>();
const service = jest.mocked(accountActionService);
// Keep the immediate return value: Expo attaches getPathname to this object,
// whereas RNTL's screen and the awaited RenderResult do not have that helper.
let routerResult: ReturnType<typeof renderRouter> | undefined;

async function open(url = '/home') {
  await act(async () => {
    routerResult = renderRouter({
      _layout: RootLayout,
      index: LaunchScreen,
      '(tabs)/home': HomeScreen,
      'onboarding/pace': () => <Text testID="replacement-resumed">replacement</Text>,
      'onboarding/index': () => <Text testID="draft-resumed">draft</Text>,
    }, { initialUrl: url });
  });
}

async function menu(action: 'logout' | 'delete' = 'logout') {
  await waitFor(() => expect(screen.getByTestId('home-edit-button')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('home-edit-button'));
  await fireEvent.press(screen.getByTestId(action === 'logout' ? 'home-logout' : 'home-delete-account'));
  await waitFor(() => expect(screen.queryByTestId('account-action-guard')).toBeNull());
  await waitFor(() => screen.getByTestId('account-action-submit'));
}

async function foreground() {
  await act(async () => {
    for (const listener of listeners) listener('active');
  });
}

function setSubscriptionRegistered(registered: boolean) {
  jest.mocked(loadSubscriptionSession).mockReset().mockImplementation(async (uid) => ({
    uid, registered, xLinked: true, access: 'allowed',
  }));
}

function succeed() {
  service.perform.mockImplementation(async (_action, _uid, { launch }) => {
    service.inspectPending.mockResolvedValue(empty);
    jest.mocked(loadGoalReplacement).mockResolvedValue(null);
    jest.mocked(getCurrentUid).mockReturnValue(null);
    await launch();
    return complete;
  });
}

beforeEach(() => {
  routerResult = undefined;
  setSubscriptionRegistered(true);
  service.inspectPending.mockReset().mockResolvedValue(empty);
  service.perform.mockReset().mockResolvedValue(incomplete);
  service.resume.mockReset().mockResolvedValue(incomplete);
  jest.mocked(getCurrentUid).mockReturnValue('account-a');
  jest.mocked(loadGoalReplacement).mockReset().mockResolvedValue(null);
  jest.mocked(loadOnboardingDraft).mockReset().mockResolvedValue(INITIAL_ONBOARDING_DRAFT);
  jest.mocked(openSettingsLink).mockReset().mockResolvedValue(undefined);
  jest.mocked(fetchHomeData).mockResolvedValue({
    status: 'ok',
    data: { goalId: 'goal-a', goal, goalDocument: goal, dailyResults: [], sessions: [], notice: null },
  });
  listeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
});

afterEach(async () => {
  await cleanup();
  listeners.clear();
  jest.restoreAllMocks();
});

it.each(['logout', 'delete'] as const)('Home→%s確認→実launchで初回画面へ遷移', async (action) => {
  succeed();
  await open();
  await menu(action);
  expect(service.perform).not.toHaveBeenCalled();
  expect(screen.getByText(action === 'logout' ? 'ログアウトしますか？' : 'アカウントを削除しますか？')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => expect(routerResult?.getPathname()).toBe('/'));
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(service.perform).toHaveBeenCalledWith(action, 'account-a', { launch: expect.any(Function) });
  expect(screen.queryByTestId('account-action-popup')).toBeNull();
  expect(service.resume).not.toHaveBeenCalled();
});

it('キャンセルはserviceを実行せずHomeへ戻る', async () => {
  await open();
  await menu();
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  expect(routerResult?.getPathname()).toBe('/home');
  expect(screen.queryByTestId('account-action-popup')).toBeNull();
  expect(service.perform).not.toHaveBeenCalled();
});

it('削除確認のサブスク管理を既存openSettingsLinkへ接続する', async () => {
  await open();
  await menu('delete');
  expect(screen.getByText('アカウント削除だけではAppleの定期課金は停止しません')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('account-subscription'));
  expect(openSettingsLink).toHaveBeenCalledWith('subscription');
  expect(service.perform).not.toHaveBeenCalled();
});

it('失敗を保持しCPのUID/actionで明示再試行する', async () => {
  service.perform.mockImplementationOnce(async () => {
    service.inspectPending.mockResolvedValue(checkpoint);
    return incomplete;
  });
  await open();
  await menu();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => screen.getByTestId('account-action-error'));
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(routerResult?.getPathname()).toBe('/home');
  jest.mocked(getCurrentUid).mockReturnValue('account-b');
  succeed();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => expect(routerResult?.getPathname()).toBe('/'));
  expect(service.perform).toHaveBeenNthCalledWith(2, 'logout', 'account-a', { launch: expect.any(Function) });
});

it('処理中はキャンセルと重複実行を無効にする', async () => {
  const pending = deferred<Outcome>();
  service.perform.mockReturnValueOnce(pending.promise);
  await open();
  await menu();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => expect(service.perform).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(screen.getByTestId('account-action-submit')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('account-action-cancel'));
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(service.perform).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(incomplete); });
  await waitFor(() => expect(screen.getByTestId('account-action-submit')).toBeEnabled());
});

it('再起動CPがreplacement/draft復帰より優先しcloudを自動再送しない', async () => {
  service.inspectPending.mockResolvedValue(checkpoint);
  jest.mocked(getCurrentUid).mockReturnValue('account-b');
  jest.mocked(loadGoalReplacement).mockResolvedValue({
    uid: 'account-b', expectedGoalId: 'old',
    draft: INITIAL_ONBOARDING_DRAFT, committedGoalId: 'new',
  });
  await open('/');
  await waitFor(() => screen.getByTestId('account-action-popup'));
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(loadGoalReplacement).not.toHaveBeenCalled();
  expect(loadOnboardingDraft).not.toHaveBeenCalled();
  expect(service.perform).not.toHaveBeenCalled();
  expect(service.resume).not.toHaveBeenCalled();
  expect(routerResult?.getPathname()).toBe('/');
  succeed();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(service.perform).toHaveBeenCalledWith('logout', 'account-a', { launch: expect.any(Function) });
});

it('cloud成功確定CPだけresumeへ配線しlaunch後に初回画面を解放する', async () => {
  service.inspectPending.mockResolvedValue({
    ...checkpoint,
    checkpoint: { uid: 'account-a', action: 'delete', phase: 'sign-out' },
  });
  service.resume.mockImplementation(async ({ launch }) => {
    service.inspectPending.mockResolvedValue(empty);
    jest.mocked(getCurrentUid).mockReturnValue(null);
    await launch();
    return complete;
  });
  await open('/');
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(service.resume).toHaveBeenCalledWith({ launch: expect.any(Function) });
  expect(service.perform).not.toHaveBeenCalled();
  expect(routerResult?.getPathname()).toBe('/');
});

it('native-only blockをcloud成功と見なさず、明示performへ渡す', async () => {
  service.inspectPending.mockResolvedValue({
    checkpoint: null,
    nativeBlock: { version: 1, uid: 'native-owner', action: 'delete', operationId: 'native-operation' },
    retryOnly: true,
  });
  await open('/');
  await waitFor(() => screen.getByTestId('account-action-popup'));
  expect(service.resume).not.toHaveBeenCalled();
  expect(service.perform).not.toHaveBeenCalled();
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(service.perform).toHaveBeenCalledWith('delete', 'native-owner', { launch: expect.any(Function) });
  expect(routerResult?.getPathname()).toBe('/');
  expect(screen.getByTestId('account-action-popup')).toBeTruthy();
});

it('CPとnative blockが同時にある場合もCPのidentityを採用する', async () => {
  service.inspectPending.mockResolvedValue({
    ...checkpoint,
    nativeBlock: { version: 1, uid: 'native-owner', action: 'delete', operationId: 'native-operation' },
  });
  await open('/');
  await waitFor(() => screen.getByTestId('account-action-popup'));
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  expect(service.perform).toHaveBeenCalledWith('logout', 'account-a', { launch: expect.any(Function) });
});

it('unknown readは汎用error overlayを保持しretryでstrict inspectする', async () => {
  service.inspectPending.mockRejectedValueOnce(new Error('private-details'));
  await open('/');
  await waitFor(() => screen.getByTestId('account-action-inspect-error'));
  expect(screen.queryByText('private-details')).toBeNull();
  expect(loadGoalReplacement).not.toHaveBeenCalled();
  expect(loadOnboardingDraft).not.toHaveBeenCalled();
  expect(screen.queryByTestId('account-action-cancel')).toBeNull();
  service.inspectPending.mockResolvedValue(checkpoint);
  await fireEvent.press(screen.getByTestId('account-action-inspect-retry'));
  await waitFor(() => screen.getByTestId('account-action-popup'));
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(service.perform).not.toHaveBeenCalled();
});

it('identity不明のretryOnlyを推測で通常操作へ解放しない', async () => {
  service.inspectPending.mockResolvedValue({ ...empty, retryOnly: true });
  await open('/');
  await waitFor(() => screen.getByTestId('account-action-inspect-error'));
  expect(loadGoalReplacement).not.toHaveBeenCalled();
  expect(service.perform).not.toHaveBeenCalled();
  expect(service.resume).not.toHaveBeenCalled();
});

it('foregroundでCPを検査しHome操作より優先する', async () => {
  await open();
  await waitFor(() => expect(screen.queryByTestId('account-action-guard')).toBeNull());
  const home = screen.getByTestId('home-screen');
  service.inspectPending.mockResolvedValue(checkpoint);
  await foreground();
  await waitFor(() => screen.getByTestId('account-action-popup'));
  expect(screen.getByTestId('account-action-content', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
  expect(screen.getByTestId('home-screen', { includeHiddenElements: true })).toBe(home);
  expect(service.perform).not.toHaveBeenCalled();
  expect(service.resume).not.toHaveBeenCalled();
});

it('古いforeground inspect完了で進行中performやretry overlayを消さない', async () => {
  await open();
  await menu();
  const oldRead = deferred<Inspection>();
  const operation = deferred<Outcome>();
  service.inspectPending.mockReturnValueOnce(oldRead.promise);
  await foreground();
  service.perform.mockReturnValueOnce(operation.promise);
  await fireEvent.press(screen.getByTestId('account-action-submit', { includeHiddenElements: true }));
  await waitFor(() => expect(service.perform).toHaveBeenCalledTimes(1));
  await act(async () => { oldRead.resolve(empty); });
  expect(screen.getByTestId('account-action-popup')).toBeTruthy();
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  service.inspectPending.mockResolvedValue(checkpoint);
  await act(async () => { operation.resolve(incomplete); });
  await waitFor(() => expect(screen.getByTestId('account-action-submit')).toBeEnabled());
  expect(screen.getByTestId('account-action-cancel')).toBeDisabled();
  expect(routerResult?.getPathname()).toBe('/home');
});

it('replacement読込途中にforeground CPを検出したら遅い読込で遷移しない', async () => {
  setSubscriptionRegistered(false);
  const replacement = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadGoalReplacement).mockReturnValueOnce(replacement.promise);
  await open('/');
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
  service.inspectPending.mockResolvedValue(checkpoint);
  await foreground();
  await waitFor(() => screen.getByTestId('account-action-popup'));
  await act(async () => {
    replacement.resolve({
      uid: 'account-a', expectedGoalId: 'old',
      draft: INITIAL_ONBOARDING_DRAFT, committedGoalId: 'new',
    });
  });
  expect(routerResult?.getPathname()).toBe('/');
  expect(screen.queryByTestId('replacement-resumed')).toBeNull();
});

it('perform後のunknown readも完了扱いにせずerror overlayへ移る', async () => {
  await open();
  await menu();
  service.perform.mockImplementationOnce(async () => {
    service.inspectPending.mockRejectedValue(new Error('unknown'));
    return incomplete;
  });
  await fireEvent.press(screen.getByTestId('account-action-submit'));
  await waitFor(() => screen.getByTestId('account-action-inspect-error'));
  expect(routerResult?.getPathname()).toBe('/home');
  expect(screen.getByTestId('account-action-content', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
});

it('P083 初回replacement確認が終わるまで開始できない', async () => {
  setSubscriptionRegistered(false);
  const replacement = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadGoalReplacement).mockReturnValueOnce(replacement.promise);
  await open('/');
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  const content = screen.getByTestId('subscription-content', { includeHiddenElements: true });
  expect(content.props.pointerEvents).toBe('none');
  expect(content.props.accessibilityElementsHidden).toBe(true);
  expect(content.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(screen.getByTestId('onboarding-start-button', { includeHiddenElements: true })).toBeDisabled();
  await fireEvent.press(screen.getByTestId('onboarding-start-button', { includeHiddenElements: true }));
  expect(loadOnboardingDraft).not.toHaveBeenCalled();

  await act(async () => { replacement.resolve(null); });
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(routerResult?.getPathname()).toBe('/');
});

it('P083 ready復帰後も新しいreplacement確認が終わるまで開始できない', async () => {
  setSubscriptionRegistered(false);
  await open('/');
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(loadGoalReplacement).toHaveBeenCalledTimes(1);

  const inspection = deferred<Inspection>();
  const replacement = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  service.inspectPending.mockReturnValueOnce(inspection.promise);
  await foreground();
  await waitFor(() => screen.getByTestId('account-action-guard'));
  expect(screen.getByTestId('onboarding-start-button', { includeHiddenElements: true })).toBeDisabled();

  jest.mocked(loadGoalReplacement).mockReturnValueOnce(replacement.promise);
  await act(async () => { inspection.resolve(empty); });
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  const content = screen.getByTestId('subscription-content', { includeHiddenElements: true });
  expect(content.props.pointerEvents).toBe('none');
  expect(content.props.accessibilityElementsHidden).toBe(true);
  expect(content.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(screen.getByTestId('onboarding-start-button', { includeHiddenElements: true })).toBeDisabled();
  await fireEvent.press(screen.getByTestId('onboarding-start-button', { includeHiddenElements: true }));
  expect(loadOnboardingDraft).not.toHaveBeenCalled();

  await act(async () => { replacement.resolve(null); });
  await waitFor(() => expect(screen.getByTestId('onboarding-start-button')).toBeEnabled());
  expect(routerResult?.getPathname()).toBe('/');
});

it('P083 replacement読込中にUIDが変わったら元UIDの入力へ遷移しない', async () => {
  setSubscriptionRegistered(false);
  const replacement = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadGoalReplacement).mockReturnValueOnce(replacement.promise);
  await open('/');
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledWith('account-a'));
  jest.mocked(getCurrentUid).mockReturnValue('account-b');

  await act(async () => {
    replacement.resolve({
      uid: 'account-a', expectedGoalId: 'old',
      draft: INITIAL_ONBOARDING_DRAFT, committedGoalId: 'new',
    });
  });

  expect(routerResult?.getPathname()).toBe('/');
  expect(screen.queryByTestId('replacement-resumed')).toBeNull();
  expect(screen.queryByTestId('draft-resumed')).toBeNull();
  expect(loadOnboardingDraft).not.toHaveBeenCalled();
});
