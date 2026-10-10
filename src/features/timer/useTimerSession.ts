import { aggregateDailyStudyMinutes, toJstDateKey } from '@shared/index';
import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { generateLocalId } from './id';
import {
  findActiveSession,
  loadLocalSessions,
  startLocalSession,
  stopLocalSession,
  type LocalStudySession,
} from './storage';
import { enqueueAndSendStudyEvent, flushStudyEventQueue } from './studyEventSender';

/** 計測中の経過時間を1秒ごとに更新する間隔(表示用。保存のタイミングには影響しない) */
const TICK_INTERVAL_MS = 1000;

export type TimerSessionState = {
  /** 端末内の保存を読み込み中(初回のみ) */
  isLoading: boolean;
  /** 計測中か */
  isRunning: boolean;
  /** 計測中セッションの経過時間(ミリ秒)。計測していないときは 0 */
  elapsedMs: number;
  /** 今日(日本時間)の勉強時間(分・切り捨て。requirements 3-1) */
  todayMinutes: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * 計測の開始・停止と、経過時間・今日の勉強時間を管理するフック(requirements 3-2, 4-6)。
 * 記録は端末内(AsyncStorage)のみ(サーバー保存は 5-1b)。
 * アプリを閉じても計測は続く: 経過時間は保存された開始時刻から「今 − 開始時刻」で都度計算するため、
 * アンマウント・再マウント(アプリの再表示)をまたいでも正しい値になる
 */
export function useTimerSession(): TimerSessionState {
  const [isLoading, setIsLoading] = useState(true);
  const [sessions, setSessions] = useState<LocalStudySession[]>([]);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    let mounted = true;
    loadLocalSessions().then((loaded) => {
      if (!mounted) return;
      setSessions(loaded);
      setTick(Date.now());
      setIsLoading(false);
    });
    // アプリ起動時に送信待ちの列を再送する(5-1b-2。requirements 3-2)
    void flushStudyEventQueue();
    return () => {
      mounted = false;
    };
  }, []);

  // 他のアプリから戻ったとき(AppState が active)に送信待ちの列を再送する(5-1b-2)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void flushStudyEventQueue();
      }
    });
    return () => subscription.remove();
  }, []);

  const active = findActiveSession(sessions);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active]);

  const start = useCallback(async () => {
    const now = Date.now();
    const sessionId = generateLocalId();
    const updated = await startLocalSession(now, sessionId);
    setSessions(updated);
    setTick(Date.now());
    void enqueueAndSendStudyEvent({ sessionId, action: 'start', clientTimeMs: now });
  }, []);

  const stop = useCallback(async () => {
    const now = Date.now();
    const updated = await stopLocalSession(now);
    setSessions(updated);
    setTick(Date.now());
    if (active) {
      void enqueueAndSendStudyEvent({ sessionId: active.sessionId, action: 'stop', clientTimeMs: now });
    }
  }, [active]);

  const elapsedMs = active ? Math.max(0, tick - active.startAt) : 0;
  const todayMinutes = isLoading
    ? 0
    : aggregateDailyStudyMinutes(sessions, tick)[toJstDateKey(tick)] ?? 0;

  return { isLoading, isRunning: active !== null, elapsedMs, todayMinutes, start, stop };
}
