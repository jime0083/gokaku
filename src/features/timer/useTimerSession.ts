import {
  aggregateEffectiveDailyStudyMinutes,
  findPendingCheckAt,
  nextUnansweredCheckAt,
  resolveSessionEnd,
  toJstDateKey,
  type CheckedStudySession,
} from '@shared/index';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { clearAutoStopNotice, loadAutoStopNotice, writeAutoStopNotice, type AutoStopNotice } from './autoStopNotice';
import { fetchCheckEnabled } from './checkEnabledRepository';
import { generateLocalId } from './id';
import {
  addLocalConfirmation,
  findActiveSession,
  loadLocalSessions,
  startLocalSession,
  stopLocalSession,
  type LocalStudySession,
} from './storage';
import {
  addStudyCheckConfirmListener,
  cancelStudyCheckNotification,
  configureStudyCheckNotifications,
  consumeLastStudyCheckConfirmOnLaunch,
  requestNotificationPermissionOnce,
  scheduleStudyCheckNotification,
} from './studyCheckNotifications';
import { enqueueAndSendStudyEvent, flushStudyEventQueue } from './studyEventSender';

/** 計測中の経過時間を1秒ごとに更新する間隔(表示用。保存のタイミングには影響しない) */
const TICK_INTERVAL_MS = 1000;

export type TimerSessionState = {
  /** 端末内の保存を読み込み中(初回のみ) */
  isLoading: boolean;
  /** 計測中か(「勉強中？」への無応答による自動停止が確定した場合は false になる。5-2b) */
  isRunning: boolean;
  /** 計測中セッションの経過時間(ミリ秒)。計測していない・自動停止後は 0 */
  elapsedMs: number;
  /** 今日(日本時間)の勉強時間(分・切り捨て。requirements 3-1)。自動停止後は停止時刻までの分 */
  todayMinutes: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * 「勉強中？」確認への応答待ち(60分ごと。requirements 3-2, 2026-10-10 追記)。
   * true の間、どのタブでも画面の上に「勉強中？」を重ねて表示する(src/features/timer/StudyCheckOverlay.tsx)
   */
  pendingCheck: boolean;
  /** 確認への応答(ボタン「勉強中」)。応答を端末に保存しサーバーへ送る */
  confirm: () => Promise<void>;
  /** 無応答による自動停止のお知らせ(requirements 3-2, 2026-10-10 追記)。閉じるまで表示する */
  autoStopNotice: AutoStopNotice | null;
  /** お知らせの「閉じる」。以後同じお知らせは表示しない */
  dismissAutoStopNotice: () => Promise<void>;
};

/** LocalStudySession → shared/studyCheck.ts の関数に渡す形(計測中前提。stopAt は常に null) */
function toCheckedSession(session: LocalStudySession): CheckedStudySession {
  return {
    startAt: session.startAt,
    stopAt: null,
    checkEnabled: session.checkEnabled,
    confirmations: session.confirmations,
  };
}

/**
 * 計測中セッションの「勉強中？」通知予約を、現在の状態に合わせる(5-2c。requirements 3-2)。
 * - 計測していない・確認OFF: 予約を取り消す
 * - すでに無応答が確定している(check_timeout): 取り消す(停止自体の保存は別の処理が行う)
 * - それ以外: まだ応答していない最初の確認の時刻(先の確認でもよい)を予約する
 * 開始・応答・停止のたびに加え、画面を開いたとき・他のアプリから戻ったときにも呼ぶ
 * (requirements 3-2「予約の状態を、計測中のセッションに合わせて直す」)
 */
async function syncScheduledNotification(
  activeSession: LocalStudySession | null,
  now: number,
): Promise<void> {
  if (!activeSession || !activeSession.checkEnabled) {
    await cancelStudyCheckNotification();
    return;
  }
  const end = resolveSessionEnd(toCheckedSession(activeSession), now);
  if (end.endReason === 'check_timeout') {
    await cancelStudyCheckNotification();
    return;
  }
  const next = nextUnansweredCheckAt(toCheckedSession(activeSession));
  if (next === null) {
    await cancelStudyCheckNotification();
    return;
  }
  // 予約中の通知を取り消してから次を予約する(requirements 3-2「取り消し、次の確認を予約する」)。
  // scheduleStudyCheckNotification は固定の識別子で予約し直すだけでも置き換わるが、取り消しを明示する
  await cancelStudyCheckNotification();
  await scheduleStudyCheckNotification(next);
}

/**
 * 計測の開始・停止・「勉強中？」確認・自動停止と、経過時間・今日の勉強時間を管理するフック
 * (requirements 3-2, 4-6)。記録は端末内(AsyncStorage)が正(サーバー保存は 5-1b・5-2a)。
 * アプリを閉じても計測は続く: 経過時間は保存された開始時刻から「今 − 開始時刻」で都度計算するため、
 * アンマウント・再マウント(アプリの再表示)をまたいでも正しい値になる。
 *
 * 無応答による自動停止(5-2b)は、実際にローカル保存・サーバー送信が完了する前でも、
 * shared/studyCheck.ts の resolveSessionEnd を使って表示(isRunning・elapsedMs・todayMinutes)を
 * 即座に「止まった時刻(t_k)まで」に補正する。保存・送信は別の effect が1回だけ行う
 * (気づくタイミング: 画面を開いたとき・他のアプリから戻ったとき・表示中に時間が過ぎたとき)
 */
export function useTimerSession(): TimerSessionState {
  const [isLoading, setIsLoading] = useState(true);
  const [sessions, setSessions] = useState<LocalStudySession[]>([]);
  const [tick, setTick] = useState(() => Date.now());
  const [autoStopNotice, setAutoStopNoticeState] = useState<AutoStopNotice | null>(null);
  const autoStoppingRef = useRef(false);
  // 通知のリスナー(マウント中ずっと有効)が常に最新の sessions を見られるようにする
  // (addStudyCheckConfirmListener は mount 時に1回だけ登録するため、state の closure に頼れない)
  const sessionsRef = useRef<LocalStudySession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  /**
   * 通知のアクション「勉強中」(起動中の応答・起動時の最後の応答)から、アプリ内の確認への応答
   * (ボタン「勉強中」)と同じ処理を行う(5-2c)。渡した sessions のスナップショットに計測中の
   * セッションがなければ何もしない(すでに自動停止が確定している・計測していない場合は無視する)。
   * findPendingCheckAt で、今がどの確認の応答待ちでもない(応答期限を過ぎた・確認前など)場合も
   * 無視する(requirements 3-2, 5-2c)
   */
  const applyConfirmation = useCallback(async (sessionsSnapshot: LocalStudySession[], now: number) => {
    const target = findActiveSession(sessionsSnapshot);
    if (!target) return;
    if (findPendingCheckAt(toCheckedSession(target), now) === null) {
      // 応答期限(確認の時刻 + 10分)を過ぎてから届いた応答・どの確認にも対応しない応答は無視する
      // (requirements 3-2, 5-2c。すでに自動停止の扱い)
      return;
    }
    const updated = await addLocalConfirmation(now);
    setSessions(updated);
    setTick(Date.now());
    void enqueueAndSendStudyEvent({ sessionId: target.sessionId, action: 'confirm', clientTimeMs: now });
    await syncScheduledNotification(findActiveSession(updated), now);
  }, []);

  useEffect(() => {
    let mounted = true;
    configureStudyCheckNotifications();

    const responseSubscription = addStudyCheckConfirmListener(({ respondedAtMs }) => {
      void applyConfirmation(sessionsRef.current, respondedAtMs);
    });

    loadLocalSessions().then((loaded) => {
      if (!mounted) return;
      setSessions(loaded);
      sessionsRef.current = loaded;
      setTick(Date.now());
      setIsLoading(false);

      // アプリが終了していて通知のアクションから起動された場合の応答(5-2-0 の制約)
      const launchResponse = consumeLastStudyCheckConfirmOnLaunch();
      if (launchResponse) {
        void applyConfirmation(loaded, launchResponse.respondedAtMs);
      } else {
        void syncScheduledNotification(findActiveSession(loaded), Date.now());
      }
    });
    loadAutoStopNotice().then((notice) => {
      if (mounted) setAutoStopNoticeState(notice);
    });
    // アプリ起動時に送信待ちの列を再送する(5-1b-2。requirements 3-2)
    void flushStudyEventQueue();
    return () => {
      mounted = false;
      responseSubscription.remove();
    };
  }, [applyConfirmation]);

  // 他のアプリから戻ったとき(AppState が active)に、無応答の判定をやり直し、送信待ちの列を再送し、
  // 通知の予約の状態を直す(5-2c。requirements 3-2「予約の状態を、計測中のセッションに合わせて直す」)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        const now = Date.now();
        setTick(now);
        void flushStudyEventQueue();
        void syncScheduledNotification(findActiveSession(sessionsRef.current), now);
      }
    });
    return () => subscription.remove();
  }, []);

  const storedActive = findActiveSession(sessions);

  useEffect(() => {
    if (!storedActive) return;
    const interval = setInterval(() => setTick(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [storedActive]);

  // 無応答による自動停止の検知と反映(5-2b。requirements 3-2)。
  // sessions・tick が変わるたびに判定し、無応答が確定していれば一度だけ停止を保存・送信する
  useEffect(() => {
    if (!storedActive || autoStoppingRef.current) {
      return;
    }
    const end = resolveSessionEnd(toCheckedSession(storedActive), tick);
    if (end.endReason !== 'check_timeout') {
      return;
    }
    autoStoppingRef.current = true;
    const stoppedAt = end.endAt;
    const sessionId = storedActive.sessionId;
    void (async () => {
      const updated = await stopLocalSession(tick, stoppedAt);
      setSessions(updated);
      await writeAutoStopNotice(stoppedAt);
      setAutoStopNoticeState({ stoppedAt });
      void enqueueAndSendStudyEvent({ sessionId, action: 'stop', clientTimeMs: stoppedAt });
      await cancelStudyCheckNotification();
    })().finally(() => {
      autoStoppingRef.current = false;
    });
  }, [storedActive, tick]);

  const effectiveEnd = storedActive ? resolveSessionEnd(toCheckedSession(storedActive), tick) : null;
  const isRunning = effectiveEnd !== null && effectiveEnd.endReason !== 'check_timeout';
  const elapsedMs = isRunning && storedActive ? Math.max(0, tick - storedActive.startAt) : 0;
  const pendingCheck =
    isRunning && storedActive ? findPendingCheckAt(toCheckedSession(storedActive), tick) !== null : false;

  const start = useCallback(async () => {
    const now = Date.now();
    const sessionId = generateLocalId();
    // 初めて計測を開始したときにだけ、通知の許可を求める(requirements 3-2)
    await requestNotificationPermissionOnce();
    const checkEnabled = await fetchCheckEnabled();
    const updated = await startLocalSession(now, sessionId, checkEnabled);
    setSessions(updated);
    setTick(Date.now());
    void enqueueAndSendStudyEvent({ sessionId, action: 'start', clientTimeMs: now, checkEnabled });
    await syncScheduledNotification(findActiveSession(updated), now);
  }, []);

  const stop = useCallback(async () => {
    const now = Date.now();
    const target = findActiveSession(sessions);
    const updated = await stopLocalSession(now);
    setSessions(updated);
    setTick(Date.now());
    if (target) {
      void enqueueAndSendStudyEvent({ sessionId: target.sessionId, action: 'stop', clientTimeMs: now });
    }
    await cancelStudyCheckNotification();
  }, [sessions]);

  const confirm = useCallback(async () => {
    await applyConfirmation(sessions, Date.now());
  }, [sessions, applyConfirmation]);

  const dismissAutoStopNotice = useCallback(async () => {
    await clearAutoStopNotice();
    setAutoStopNoticeState(null);
  }, []);

  const todayMinutes = isLoading
    ? 0
    : aggregateEffectiveDailyStudyMinutes(sessions, tick)[toJstDateKey(tick)] ?? 0;

  return {
    isLoading,
    isRunning,
    elapsedMs,
    todayMinutes,
    start,
    stop,
    pendingCheck,
    confirm,
    autoStopNotice,
    dismissAutoStopNotice,
  };
}
