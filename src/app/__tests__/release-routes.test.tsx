import { router } from 'expo-router';
import {
  act, cleanup, fireEvent, renderRouter, screen, waitFor, within,
} from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import RootLayout from '../_layout';
import { useDeviceTokenSync } from '@/features/deviceToken/useDeviceTokenSync';

// RootLayoutとStack/Protected/routerは実物を使用する。
// この単位では認証・契約判定の内部動作を検証せず、境界とnative副作用を隔離する。
jest.mock('@/features/account/AccountActionBoundary', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Native = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AccountActionBoundary: ({ children }: { children: ReactNode }) =>
      React.createElement(Native.View, { testID: 'route-account-boundary' }, children),
  };
});

jest.mock('@/features/billing/SubscriptionBoundary', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Native = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SubscriptionBoundary: ({ children }: { children: ReactNode }) =>
      React.createElement(Native.View, { testID: 'route-subscription-boundary' }, children),
  };
});

jest.mock('@/features/deviceToken/useDeviceTokenSync', () => ({
  useDeviceTokenSync: jest.fn(),
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const DEV_ROUTES = [
  'dev-account-spike',
  'dev-firebase-probe',
  'dev-iap-probe',
  'dev-maestro-text-probe',
  'dev-design-tokens',
  'dev-lockscreen-spike',
] as const;

const NORMAL_ROUTES = [
  ['/', 'index'],
  ['/timer', 'timer'],
  ['/x-link', 'x-link'],
] as const;

function NormalRoute({ name }: { name: string }) {
  return (
    <View testID="route-normal-screen">
      <Text testID={`route-${name}`}>{name}</Text>
      <Pressable testID="route-open-timer" onPress={() => router.push('/(tabs)/timer')}>
        <Text>timer</Text>
      </Pressable>
      <Pressable testID="route-open-x-link" onPress={() => router.push('/x-link')}>
        <Text>x-link</Text>
      </Pressable>
    </View>
  );
}

// 開発画面自身の__DEV__判定や本番サービスへの接続に依存させない。
// 名前付きの無条件描画fixtureで、RootLayoutによるルート遮断だけを観測する。
const devScreens = Object.fromEntries(DEV_ROUTES.map((name) => [
  name,
  jest.fn(function DevelopmentRouteFixture() {
    return <Text testID={`route-${name}`}>{name}</Text>;
  }),
]));

async function open(initialUrl: string) {
  let result!: ReturnType<typeof renderRouter>;
  await act(async () => {
    result = renderRouter({
      _layout: RootLayout,
      index: () => <NormalRoute name="index" />,
      '(tabs)/timer': () => <NormalRoute name="timer" />,
      'x-link': () => <NormalRoute name="x-link" />,
      ...devScreens,
    }, { initialUrl });
  });
  return { route: result };
}

function expectBoundaries(name: string) {
  const account = screen.getByTestId('route-account-boundary');
  const subscription = within(account).getByTestId('route-subscription-boundary');
  expect(within(subscription).getByTestId(`route-${name}`)).toBeTruthy();
  expect(useDeviceTokenSync).toHaveBeenCalled();
}

describe.each([false, true])('RootLayout __DEV__=%s', (isDev) => {
  let originalDevDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      writable: true,
      value: isDev,
    });
  });

  afterEach(async () => {
    try {
      await cleanup();
    } finally {
      if (originalDevDescriptor) {
        Object.defineProperty(globalThis, '__DEV__', originalDevDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, '__DEV__');
      }
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it.each(DEV_ROUTES)('既知のdeep link gokaku:///%sを環境に応じて扱う', async (name) => {
    const { route: result } = await open(`gokaku:///${name}`);

    if (isDev) {
      await waitFor(() => {
        expect(result.getPathname()).toBe(`/${name}`);
        expect(screen.getByTestId(`route-${name}`)).toBeTruthy();
      });
      expect(devScreens[name]).toHaveBeenCalled();
      expectBoundaries(name);
    } else {
      await waitFor(() => {
        expect(result.getPathname()).not.toMatch(/^\/dev-/);
        expect(screen.getByTestId('route-normal-screen')).toBeTruthy();
      });
      for (const devName of DEV_ROUTES) {
        expect(screen.queryByTestId(`route-${devName}`, { includeHiddenElements: true })).toBeNull();
        expect(devScreens[devName]).not.toHaveBeenCalled();
      }
    }
  });

  it.each(NORMAL_ROUTES)('通常ルート%sは境界内で到達できる', async (path, name) => {
    const { route: result } = await open(path);
    await waitFor(() => {
      expect(result.getPathname()).toBe(path);
      expect(screen.getByTestId(`route-${name}`)).toBeTruthy();
    });
    expectBoundaries(name);
  });

  it('index→timer→x-link→戻るで通常ナビゲーションを維持する', async () => {
    const { route: result } = await open('/');
    await waitFor(() => expect(screen.getByTestId('route-index')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('route-open-timer'));
    await waitFor(() => {
      expect(result.getPathname()).toBe('/timer');
      expect(screen.getByTestId('route-timer')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('route-open-x-link'));
    await waitFor(() => {
      expect(result.getPathname()).toBe('/x-link');
      expect(screen.getByTestId('route-x-link')).toBeTruthy();
    });

    await act(async () => { router.back(); });
    await waitFor(() => {
      expect(result.getPathname()).toBe('/timer');
      expect(screen.getByTestId('route-timer')).toBeTruthy();
    });
    expectBoundaries('timer');
  });
});
