/**
 * アプリの起動時・他のアプリから戻ったとき(AppState が active)に、デバイストークン(5-3a)の
 * 発行・作り直しを試みる(5-3a-2。requirements 3-2)。useTimerSession.ts の AppState の扱いと同じ形。
 * src/app/_layout.tsx(アプリ全体で一度だけマウントされるルートのレイアウト)から呼ぶ
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { ensureDeviceToken } from './ensureDeviceToken';

export function useDeviceTokenSync(): void {
  useEffect(() => {
    void ensureDeviceToken();

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void ensureDeviceToken();
      }
    });
    return () => subscription.remove();
  }, []);
}
