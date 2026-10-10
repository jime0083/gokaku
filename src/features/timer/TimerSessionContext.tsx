import { createContext, useContext, type ReactNode } from 'react';

import { useTimerSession, type TimerSessionState } from './useTimerSession';

/**
 * 計測の状態(開始/停止・経過時間・今日の勉強時間)を、タイマー画面と下部タブ(印の表示)の
 * 両方から参照できるようにする Context(requirements 4-6: 計測中はタイマーのタブに小さな印を付ける)。
 * src/app/(tabs)/_layout.tsx で Provider をかぶせ、フックの状態を1つだけ持つ
 * (画面とタブアイコンで別々にポーリングしない)
 */
const TimerSessionContext = createContext<TimerSessionState | null>(null);

export function TimerSessionProvider({ children }: { children: ReactNode }) {
  const state = useTimerSession();
  return <TimerSessionContext.Provider value={state}>{children}</TimerSessionContext.Provider>;
}

export function useTimerSessionContext(): TimerSessionState {
  const context = useContext(TimerSessionContext);
  if (!context) {
    throw new Error('useTimerSessionContext は TimerSessionProvider の内側で使ってください');
  }
  return context;
}
