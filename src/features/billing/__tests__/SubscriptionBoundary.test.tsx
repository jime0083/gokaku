import {
  act, cleanup, fireEvent, renderRouter, screen, waitFor,
} from 'expo-router/testing-library';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { AppState, Pressable, Text, TextInput, type AppStateStatus } from 'react-native';

import RootLayout from '@/app/_layout';
import LaunchScreen from '@/app/index';
import * as PrimaryButtonModule from '@/components/PrimaryButton';
import { getCurrentUid } from '@/config/firebase';
import { loadGoalReplacement } from '@/features/onboarding/replacementStorage';
import { INITIAL_ONBOARDING_DRAFT } from '@/features/onboarding/types';

import { recoverStartupPurchases } from '../recoverPendingPurchases';
import { useSubscriptionAccess } from '../SubscriptionBoundary';
import {
  loadSubscriptionSession, subscribeSubscriptionAuth,
} from '../subscriptionRepository';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/deviceToken/useDeviceTokenSync', () => ({ useDeviceTokenSync: jest.fn() }));
jest.mock('@/features/onboarding/replacementStorage', () => ({ loadGoalReplacement: jest.fn() }));
jest.mock('@/features/onboarding/storage', () => ({ loadOnboardingDraft: jest.fn() }));
jest.mock('../subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(),
  subscribeSubscriptionAuth: jest.fn(),
}));
jest.mock('../recoverPendingPurchases', () => ({ recoverStartupPurchases: jest.fn() }));
jest.mock('@/features/account/AccountActionBoundary', () => ({
  AccountActionBoundary: ({ children }: { children: ReactNode }) => children,
  useAccountActions: () => {
    const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
    return useSyncExternalStore(mockSubscribeAccount, () => mockAccount);
  },
}));

const NOW = 1_792_550_000_000;
const UID = 'subscription-user-a';
const initialAppState = AppState.currentState;
const mockAccountListeners = new Set<() => void>();
let mockReady = true;
let mockAccount = { ready: true, isReady: () => mockReady, request: jest.fn() };
function mockSubscribeAccount(listener: () => void) {
  mockAccountListeners.add(listener);
  return () => { mockAccountListeners.delete(listener); };
}

type Session = Awaited<ReturnType<typeof loadSubscriptionSession>>;
const authListeners = new Set<(uid: string | null) => void>();
const appListeners = new Set<(status: AppStateStatus) => void>();
const purchaseFailure = jest.fn();
let result: ReturnType<typeof renderRouter> | undefined;

function session(overrides: Partial<Session> = {}): Session {
  return { uid: UID, registered: true, xLinked: true, access: 'allowed', ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function Paywall() {
  const { afterPurchase } = useSubscriptionAccess();
  return <>
    <Text>paywall</Text>
    <Pressable testID="purchase-completed" onPress={() => {
      void afterPurchase().catch(purchaseFailure);
    }}>
      <Text>server verified and finished</Text>
    </Pressable>
  </>;
}

function Timer() {
  const [value, setValue] = useState('');
  return <TextInput testID="timer-input" value={value} onChangeText={setValue} />;
}

async function open(url = '/') {
  await act(async () => {
    result = renderRouter({
      _layout: RootLayout,
      index: LaunchScreen,
      '(tabs)/home': () => <Text>home</Text>,
      timer: Timer,
      paywall: Paywall,
      'x-link': () => <Pressable testID="x-completed" onPress={() => {
        router.replace('/(tabs)/home');
      }}><Text>x-link</Text></Pressable>,
      'onboarding/index': () => <Text>onboarding</Text>,
      'onboarding/pace': () => <Text>replacement pace</Text>,
    }, { initialUrl: url });
  });
}

async function settled(path: string) {
  await waitFor(() => expect(result?.getPathname()).toBe(path));
  await waitFor(() => expect(screen.queryByTestId('subscription-guard')).toBeNull());
}

async function appState(status: AppStateStatus) {
  await act(async () => {
    AppState.currentState = status;
    for (const listener of appListeners) listener(status);
  });
}

async function accountReady(ready: boolean) {
  await act(async () => {
    mockReady = ready;
    mockAccount = { ...mockAccount, ready };
    for (const listener of mockAccountListeners) listener();
  });
}

beforeEach(() => {
  result = undefined;
  mockReady = true;
  mockAccount = { ready: true, isReady: () => mockReady, request: jest.fn() };
  mockAccountListeners.clear();
  authListeners.clear();
  appListeners.clear();
  purchaseFailure.mockReset();
  AppState.currentState = 'active';
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.mocked(getCurrentUid).mockReset().mockReturnValue(UID);
  jest.mocked(loadGoalReplacement).mockReset().mockResolvedValue(null);
  jest.mocked(loadSubscriptionSession).mockReset().mockResolvedValue(session());
  // 通常ケースはApple処理を保留し、canonical表示が待たされないことも確認。
  jest.mocked(recoverStartupPurchases).mockReset()
    .mockImplementation(() => new Promise<void>(() => {}));
  jest.mocked(subscribeSubscriptionAuth).mockReset().mockImplementation((listener) => {
    authListeners.add(listener);
    return () => { authListeners.delete(listener); };
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') appListeners.add(listener);
    return { remove: () => { appListeners.delete(listener); } };
  });
});

afterEach(async () => {
  await cleanup();
  authListeners.clear();
  appListeners.clear();
  mockAccountListeners.clear();
  AppState.currentState = initialAppState;
  jest.restoreAllMocks();
});

it.each([
  { url: '/', xLinked: true, destination: '/home' },
  { url: '/paywall', xLinked: false, destination: '/x-link' },
])('起動 $url xLinked=$xLinked → $destination', async ({ url, xLinked, destination }) => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ xLinked }));
  const inspection = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  if (url === '/') {
    jest.mocked(loadGoalReplacement).mockReturnValueOnce(inspection.promise);
    jest.mocked(recoverStartupPurchases).mockResolvedValue(undefined);
  }
  await open(url);
  if (url === '/') {
    await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('subscription-guard')).toBeTruthy();
    expect(screen.getByTestId('onboarding-start-button', {
      includeHiddenElements: true,
    })).toBeDisabled();
    await act(async () => { inspection.resolve(null); });
  }
  await settled(destination);
  expect(loadGoalReplacement).toHaveBeenCalledTimes(url === '/' ? 1 : 0);
  expect(loadSubscriptionSession).toHaveBeenCalledWith(UID, NOW);
  if (!xLinked) {
    // サーバー更新後、既存x-link画面がhomeへ進んでも古い値で戻さない。
    await fireEvent.press(screen.getByTestId('x-completed'));
    await settled('/home');
  }
});

it('未ログインは既存launchを維持して契約・購入確認を呼ばない', async () => {
  jest.mocked(getCurrentUid).mockReturnValue(null);
  await open();
  await settled('/');
  expect(screen.getByTestId('onboarding-start-button')).toBeEnabled();
  expect(loadSubscriptionSession).not.toHaveBeenCalled();
  expect(recoverStartupPurchases).not.toHaveBeenCalled();
});

it('未登録のlockedはonboardingを維持し、launchへの戻りも妨げない', async () => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({
    registered: false, access: 'locked', xLinked: false,
  }));
  await open('/onboarding');
  await settled('/onboarding');
  await act(async () => { router.replace('/'); });
  await settled('/');
});

it('登録済みexpiredは別ルート・戻る・onboardingからpaywallへ戻す', async () => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
  await open('/timer');
  await settled('/paywall');
  await act(async () => { router.push('/timer'); });
  await settled('/paywall');
  await act(async () => { router.back(); });
  await settled('/paywall');
  await act(async () => { router.replace('/onboarding'); });
  await settled('/paywall');
});

it('復帰確認中は同一Viewで操作/読み上げを遮断しtimerの入力を保持する', async () => {
  await open('/timer');
  await settled('/timer');
  await fireEvent.changeText(screen.getByTestId('timer-input'), 'running');
  const pending = deferred<Session>();
  jest.mocked(loadSubscriptionSession).mockReturnValueOnce(pending.promise);
  await appState('background');
  await appState('active');
  expect(screen.getByText('契約状態を確認中...')).toBeTruthy();
  const content = screen.getByTestId('subscription-content', { includeHiddenElements: true });
  expect(content.props.pointerEvents).toBe('none');
  expect(content.props.accessibilityElementsHidden).toBe(true);
  expect(content.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(screen.getByTestId('timer-input', { includeHiddenElements: true }).props.value).toBe('running');
  await act(async () => { pending.resolve(session()); });
  await settled('/timer');
  expect(screen.getByTestId('timer-input').props.value).toBe('running');
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(2);
  expect(recoverStartupPurchases).toHaveBeenCalledTimes(1);
});

it('backgroundで起動読取を無効化し、古いallowedでは解除/遷移しない', async () => {
  const old = deferred<Session>();
  jest.mocked(loadSubscriptionSession).mockReturnValueOnce(old.promise);
  await open();
  await appState('background');
  await act(async () => { old.resolve(session()); });
  expect(result?.getPathname()).toBe('/');
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
  await appState('active');
  await settled('/paywall');
});

it('UID変更後は前UIDの契約応答・Launch再開結果を採用しない', async () => {
  const old = deferred<Session>();
  const next = deferred<Session>();
  const oldDraft = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  const nextDraft = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadSubscriptionSession)
    .mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  jest.mocked(loadGoalReplacement)
    .mockReturnValueOnce(oldDraft.promise).mockReturnValueOnce(nextDraft.promise);
  await open();
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.mocked(getCurrentUid).mockReturnValue('subscription-user-b');
    for (const listener of authListeners) listener('subscription-user-b');
  });
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(2));
  await act(async () => {
    old.resolve(session());
    oldDraft.resolve({
      uid: UID, expectedGoalId: 'old-goal', committedGoalId: 'committed',
      draft: INITIAL_ONBOARDING_DRAFT,
    });
    next.resolve(session({ uid: 'subscription-user-b' }));
  });
  expect(result?.getPathname()).toBe('/');
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  expect(screen.getByTestId('onboarding-start-button', {
    includeHiddenElements: true,
  })).toBeDisabled();
  await act(async () => { nextDraft.resolve(null); });
  await settled('/home');
  expect(loadGoalReplacement).toHaveBeenNthCalledWith(1, UID);
  expect(loadGoalReplacement).toHaveBeenNthCalledWith(2, 'subscription-user-b');
});

it.each([
  { xLinked: true, destination: '/home' },
  { xLinked: false, destination: '/x-link' },
])('afterPurchaseはcanonicalを再読込して $destination へ進む', async ({ xLinked, destination }) => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
  await open('/paywall');
  await settled('/paywall');
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ xLinked }));
  await fireEvent.press(screen.getByTestId('purchase-completed'));
  await settled(destination);
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(2);
  expect(purchaseFailure).not.toHaveBeenCalled();
});

it('afterPurchaseの読取失敗は内部エラーを渡さず現在のpaywallを維持する', async () => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
  await open('/paywall');
  await settled('/paywall');
  jest.mocked(loadSubscriptionSession).mockRejectedValueOnce(new Error('internal SDK failure'));
  await fireEvent.press(screen.getByTestId('purchase-completed'));
  await waitFor(() => expect(purchaseFailure).toHaveBeenCalledTimes(1));
  expect(purchaseFailure.mock.calls[0][0].message).toBe(
    '購入の確認ができませんでした。通信状況を確認して「購入の復元」をお試しください',
  );
  await settled('/paywall');
});

it('CP待機中はlookupせず、旧ownerの契約応答・再開報告でも解除しない', async () => {
  mockReady = false;
  mockAccount = { ...mockAccount, ready: false };
  await open();
  expect(loadSubscriptionSession).not.toHaveBeenCalled();
  expect(loadGoalReplacement).not.toHaveBeenCalled();
  const pending = deferred<Session>();
  const oldDraft = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadSubscriptionSession).mockReturnValueOnce(pending.promise);
  jest.mocked(loadGoalReplacement).mockReturnValueOnce(oldDraft.promise);
  await accountReady(true);
  await waitFor(() => expect(loadSubscriptionSession).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
  await accountReady(false);
  await act(async () => {
    pending.resolve(session());
    oldDraft.resolve({
      uid: UID, expectedGoalId: 'old-goal', committedGoalId: 'committed',
      draft: INITIAL_ONBOARDING_DRAFT,
    });
  });
  expect(result?.getPathname()).toBe('/');
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  expect(screen.getByTestId('onboarding-start-button', {
    includeHiddenElements: true,
  })).toBeDisabled();
  await accountReady(true);
  await settled('/home');
  expect(loadGoalReplacement).toHaveBeenCalledTimes(2);
});

it('初回rootはUID別目標変更draftを既存helperで再開しonboardingを維持する', async () => {
  jest.mocked(loadGoalReplacement).mockResolvedValue({
    uid: UID, expectedGoalId: 'old-goal', draft: INITIAL_ONBOARDING_DRAFT,
  });
  await open();
  await settled('/onboarding');
  expect(loadGoalReplacement).toHaveBeenCalledWith(UID);
  expect(loadGoalReplacement).toHaveBeenCalledTimes(1);
  await appState('background');
  await appState('active');
  await settled('/onboarding');
  expect(loadGoalReplacement).toHaveBeenCalledTimes(1);
});

it('起動購入確認を待たずcanonicalを表示し、完了後はcanonicalを再読込する', async () => {
  const recovery = deferred<void>();
  jest.mocked(recoverStartupPurchases).mockReturnValue(recovery.promise);
  jest.mocked(loadSubscriptionSession)
    .mockResolvedValueOnce(session({ access: 'locked' }))
    .mockResolvedValue(session());
  await open();
  await settled('/paywall');
  expect(recoverStartupPurchases).toHaveBeenCalledWith(UID);
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(1);
  await act(async () => { recovery.resolve(undefined); });
  await settled('/home');
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(2);
});

it('復帰確認は古い起動購入確認を無効化し、復帰で購入確認を再実行しない', async () => {
  const recovery = deferred<void>();
  jest.mocked(recoverStartupPurchases).mockReturnValue(recovery.promise);
  await open();
  await settled('/home');
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
  await appState('background');
  await appState('active');
  await settled('/paywall');
  await act(async () => { recovery.resolve(undefined); });
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(2);
  await appState('background');
  await appState('active');
  await settled('/paywall');
  expect(loadSubscriptionSession).toHaveBeenCalledTimes(3);
  expect(recoverStartupPurchases).toHaveBeenCalledTimes(1);
});

it.each([
  { replacement: null, destination: '/home', xLinked: true },
  { replacement: null, destination: '/x-link', xLinked: false },
  {
    replacement: { uid: UID, expectedGoalId: 'old', draft: INITIAL_ONBOARDING_DRAFT },
    destination: '/onboarding', xLinked: true,
  },
  {
    replacement: {
      uid: UID, expectedGoalId: 'old', committedGoalId: 'new',
      draft: INITIAL_ONBOARDING_DRAFT,
    },
    destination: '/onboarding/pace', xLinked: true,
  },
])('P107 読込失敗→再試行は $destination へ進む', async ({
  replacement, destination, xLinked,
}) => {
  const retry = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ xLinked }));
  jest.mocked(loadGoalReplacement)
    .mockRejectedValueOnce(new Error('storage read failed'))
    .mockReturnValueOnce(retry.promise);
  // P099と同様、実部品を描画したまま公開onPressを取得する。
  let retryOnPress: (() => void) | undefined;
  const ActualPrimaryButton = PrimaryButtonModule.PrimaryButton;
  const buttonSpy = jest.spyOn(PrimaryButtonModule, 'PrimaryButton')
    .mockImplementation((props) => {
      if (props.testID === 'launch-inspection-retry') retryOnPress = props.onPress;
      return <ActualPrimaryButton {...props} />;
    });
  try {
    await open();
    await waitFor(() => expect(screen.getByText('再開データを読み込めませんでした')).toBeTruthy());
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('onboarding-start-button', {
      includeHiddenElements: true,
    })).toBeDisabled();
    // 同じ描画のハンドラが連続で呼ばれても、同期的に重複を排除する。
    const press = retryOnPress;
    expect(press).toEqual(expect.any(Function));
    if (!press) throw new Error('Retry button handler was not captured');
    await act(async () => { press(); press(); });
    expect(loadGoalReplacement).toHaveBeenCalledTimes(2);
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('subscription-guard')).toBeTruthy();
    await act(async () => { retry.resolve(replacement); });
    await settled(destination);
    expect(loadGoalReplacement).toHaveBeenNthCalledWith(2, UID);
  } finally {
    buttonSpy.mockRestore();
  }
});

it('P107 再試行も失敗したらデータなしと扱わず、再度明示的に試せる', async () => {
  jest.mocked(loadGoalReplacement)
    .mockRejectedValueOnce(new Error('first'))
    .mockRejectedValueOnce(new Error('second'))
    .mockResolvedValueOnce(null);
  await open();
  await waitFor(() => expect(screen.getByTestId('launch-inspection-retry')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(2));
  expect(screen.getByText('再開データを読み込めませんでした')).toBeTruthy();
  expect(result?.getPathname()).toBe('/');
  await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
  await settled('/home');
});

it('P107 未登録でも読込失敗を表示し、成功まで開始できない', async () => {
  jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ registered: false }));
  jest.mocked(loadGoalReplacement).mockRejectedValueOnce(new Error('storage'));
  await open();
  await waitFor(() => expect(screen.getByTestId('launch-inspection-retry')).toBeTruthy());
  expect(result?.getPathname()).toBe('/');
  await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
  await settled('/');
  expect(screen.getByTestId('onboarding-start-button')).toBeEnabled();
});

it.each(['startup', 'foreground'] as const)(
  'P110 %sの期限切れでも再開読込失敗は停止し、再試行成功後paywallへ進む',
  async (timing) => {
    const retry = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
    jest.mocked(loadSubscriptionSession).mockResolvedValue(session({
      access: timing === 'startup' ? 'locked' : 'allowed',
    }));
    jest.mocked(loadGoalReplacement)
      .mockRejectedValueOnce(new Error('storage'))
      .mockReturnValueOnce(retry.promise);
    await open();
    await waitFor(() => expect(screen.getByText('再開データを読み込めませんでした')).toBeTruthy());
    if (timing === 'foreground') {
      jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ access: 'locked' }));
      await appState('background');
      await appState('active');
      await waitFor(() => expect(loadSubscriptionSession).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText('再開データを読み込めませんでした')).toBeTruthy());
    }
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('subscription-guard')).toBeTruthy();
    const content = screen.getByTestId('subscription-content', { includeHiddenElements: true });
    expect(content.props.pointerEvents).toBe('none');
    expect(content.props.accessibilityElementsHidden).toBe(true);
    expect(content.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.getByTestId('onboarding-start-button', {
      includeHiddenElements: true,
    })).toBeDisabled();
    expect(loadGoalReplacement).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
    expect(loadGoalReplacement).toHaveBeenCalledTimes(2);
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('subscription-guard')).toBeTruthy();
    expect(screen.getByTestId('subscription-content', {
      includeHiddenElements: true,
    }).props.pointerEvents).toBe('none');
    await act(async () => {
      retry.resolve({
        uid: UID, expectedGoalId: 'old', committedGoalId: 'new',
        draft: INITIAL_ONBOARDING_DRAFT,
      });
    });
    await settled('/paywall');
    expect(screen.queryByText('再開データを読み込めませんでした')).toBeNull();
    expect(loadGoalReplacement).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { access: 'locked' as const, destination: '/paywall' },
  { access: 'allowed' as const, destination: '/onboarding/pace' },
])('P107 再試行成功は最新契約$accessと合流する', async ({ access, destination }) => {
  const retry = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  const latest = deferred<Session>();
  jest.mocked(loadGoalReplacement)
    .mockRejectedValueOnce(new Error('storage'))
    .mockReturnValueOnce(retry.promise);
  await open();
  await waitFor(() => expect(screen.getByTestId('launch-inspection-retry')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
  jest.mocked(loadSubscriptionSession).mockReturnValueOnce(latest.promise);
  await appState('background');
  await appState('active');
  await act(async () => {
    retry.resolve({
      uid: UID, expectedGoalId: 'old', committedGoalId: 'new',
      draft: INITIAL_ONBOARDING_DRAFT,
    });
  });
  expect(result?.getPathname()).toBe('/');
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  await act(async () => { latest.resolve(session({ access })); });
  await settled(destination);
});

it.each(['uid', 'owner', 'unmount'] as const)(
  'P107 %s更新前の再試行応答は新しい試行へ通知しない',
  async (change) => {
    const stale = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
    const current = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
    jest.mocked(loadGoalReplacement)
      .mockRejectedValueOnce(new Error('first'))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await open();
    await waitFor(() => expect(screen.getByTestId('launch-inspection-retry')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('launch-inspection-retry'));
    if (change === 'uid') {
      jest.mocked(loadSubscriptionSession).mockResolvedValue(session({ uid: 'next-user' }));
      await act(async () => {
        jest.mocked(getCurrentUid).mockReturnValue('next-user');
        for (const listener of authListeners) listener('next-user');
      });
    } else if (change === 'owner') {
      await accountReady(false);
      await accountReady(true);
    } else {
      await act(async () => { router.replace('/timer'); });
      await waitFor(() => expect(result?.getPathname()).toBe('/timer'));
      await act(async () => { router.replace('/'); });
    }
    await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(3));
    await act(async () => { stale.reject(new Error('obsolete failure')); });
    expect(screen.queryByText('再開データを読み込めませんでした')).toBeNull();
    expect(result?.getPathname()).toBe('/');
    expect(screen.getByTestId('subscription-guard')).toBeTruthy();
    await act(async () => { current.resolve(null); });
    await settled('/home');
  },
);

it('P107 unmount前の同UID/ownerの成功応答も新しい試行に混ぜない', async () => {
  const stale = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  const current = deferred<Awaited<ReturnType<typeof loadGoalReplacement>>>();
  jest.mocked(loadGoalReplacement)
    .mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
  await open();
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(1));
  await act(async () => { router.replace('/timer'); });
  await waitFor(() => expect(result?.getPathname()).toBe('/timer'));
  await act(async () => { router.replace('/'); });
  await waitFor(() => expect(loadGoalReplacement).toHaveBeenCalledTimes(2));
  await act(async () => {
    stale.resolve({
      uid: UID, expectedGoalId: 'old', committedGoalId: 'new',
      draft: INITIAL_ONBOARDING_DRAFT,
    });
  });
  expect(result?.getPathname()).toBe('/');
  expect(screen.getByTestId('subscription-guard')).toBeTruthy();
  await act(async () => { current.resolve(null); });
  await settled('/home');
});
