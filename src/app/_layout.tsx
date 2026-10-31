import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AccountActionBoundary } from '@/features/account/AccountActionBoundary';
import { SubscriptionBoundary } from '@/features/billing/SubscriptionBoundary';
import { useDeviceTokenSync } from '@/features/deviceToken/useDeviceTokenSync';

export default function RootLayout() {
  // ログイン中のユーザー向けに、デバイストークンの発行・作り直しを起動時・他のアプリから戻ったときに試みる
  // (5-3a-2。requirements 3-2)
  useDeviceTokenSync();

  return (
    <AccountActionBoundary>
      <SubscriptionBoundary>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={__DEV__}>
            <Stack.Screen name="dev-account-spike" />
            <Stack.Screen name="dev-firebase-probe" />
            <Stack.Screen name="dev-iap-probe" />
            <Stack.Screen name="dev-maestro-text-probe" />
            <Stack.Screen name="dev-design-tokens" />
            <Stack.Screen name="dev-lockscreen-spike" />
          </Stack.Protected>
        </Stack>
      </SubscriptionBoundary>
      <StatusBar style="dark" />
    </AccountActionBoundary>
  );
}
