import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useDeviceTokenSync } from '@/features/deviceToken/useDeviceTokenSync';

export default function RootLayout() {
  // ログイン中のユーザー向けに、デバイストークンの発行・作り直しを起動時・他のアプリから戻ったときに試みる
  // (5-3a-2。requirements 3-2)
  useDeviceTokenSync();

  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="dark" />
    </>
  );
}
