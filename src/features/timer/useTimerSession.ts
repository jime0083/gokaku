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

import { getCurrentUid } from '@/config/firebase';
import type { AccountOperationLease } from '@/features/account/accountOperationGate';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';

import { clearAutoStopNotice, loadAutoStopNotice, writeAutoStopNotice, type AutoStopNotice } from './autoStopNotice';
import { fetchCheckEnabled } from './checkEnabledRepository';
import { generateLocalId } from './id';
import {
  addNativeConfirmation,
  notifyNativeMeasurementStart,
  notifyNativeMeasurementStop,
  reconcileWithLockscreen,
  rememberCheckEnabledSetting,
} from './lockscreenSync';
import { getStudyCheckTiming } from './studyCheckDevOverride';
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
 *
 * 間隔・応答期限は getStudyCheckTiming で決める(5-3e-2: 開発ビルドで短い値に切り替えている場合はその値。
 * 本番ビルドは常に shared の既定値=60分・10分)
 */
async function syncScheduledNotification(
  activeSession: LocalStudySession | null,
  now: number,
  lease: AccountOperationLease,
): Promise<void> {
  lease.assertCurrentUid();
  if (!activeSession || !activeSession.checkEnabled) {
    await cancelStudyCheckNotification();
    lease.assertCurrentUid();
    return;
  }
  const { intervalMs, responseWindowMs } = getStudyCheckTiming();
  const end = resolveSessionEnd(toCheckedSession(activeSession), now, intervalMs, responseWindowMs);
  if (end.endReason === 'check_timeout') {
    await cancelStudyCheckNotification();
    lease.assertCurrentUid();
    return;
  }
  const next = nextUnansweredCheckAt(toCheckedSession(activeSession), intervalMs, responseWindowMs);
  if (next === null) {
    await cancelStudyCheckNotification();
    lease.assertCurrentUid();
    return;
  }
  // 予約中の通知を取り消してから次を予約する(requirements 3-2「取り消し、次の確認を予約する」)。
  // scheduleStudyCheckNotification は固定の識別子で予約し直すだけでも置き換わるが、取り消しを明示する
  await cancelStudyCheckNotification();
  lease.assertCurrentUid();
  await scheduleStudyCheckNotification(next, activeSession.uid);
  lease.assertCurrentUid();
}

function assertTimerOwner(value: { uid?: string } | null, expectedUid: string): void {
  if (value?.uid !== undefined && value.uid !== expectedUid) {
    throw new Error('timer-session-owner-mismatch');
  }
}

/** background入口でのみ拒否を受け止める。子処理の完了待ちはtask内で行う。 */
async function runBackgroundTimerMutation(
  task: (lease: AccountOperationLease, expectedUid: string) => Promise<void>,
): Promise<void> {
  try {
    const expectedUid = getCurrentUid();
    if (expectedUid === null) return;
    await accountOperationGate.runNormal(
      expectedUid,
      async (lease) => { await task(lease, expectedUid); },
    );
  } catch {
    // block・認証変更・保存/送信失敗を完了扱いにせず、保存済みデータを保持する。
    // 次の通常の起動・復帰・操作機会で扱い、この入口から再試行は追加しない。
  }
}

/** 保存対象を読み直し、既知UIDだけをcaptured Authと照合する。legacyの所有は補完しない。 */
async function loadOwnedTimerSessions(
  expectedUid: string,
  lease: AccountOperationLease,
): Promise<LocalStudySession[]> {
  const stored = await loadLocalSessions();
  lease.assertCurrentUid();
  assertTimerOwner(findActiveSession(stored), expectedUid);
  return stored;
}

/** 一方が失敗しても、起動済みの子処理が全て終わるまで通常leaseを解放しない。 */
async function settleTimerChildren(children: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(children);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
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
  const applyConfirmation = useCallback(async (
    sessionsSnapshot: LocalStudySession[],
    now: number,
    lease: AccountOperationLease,
    expectedUid: string,
  ) => {
    lease.assertCurrentUid();
    const target = findActiveSession(sessionsSnapshot);
    assertTimerOwner(target, expectedUid);
    if (!target) return;
    const { intervalMs, responseWindowMs } = getStudyCheckTiming();
    if (findPendingCheckAt(toCheckedSession(target), now, intervalMs, responseWindowMs) === null) {
      return;
    }
    const updated = await addLocalConfirmation(now);
    lease.assertCurrentUid();
    setSessions(updated);
    sessionsRef.current = updated;
    setTick(Date.now());
    addNativeConfirmation(now, expectedUid, target.sessionId);
    await settleTimerChildren([
      syncScheduledNotification(findActiveSession(updated), now, lease),
      enqueueAndSendStudyEvent({
        sessionId: target.sessionId,
        action: 'confirm',
        clientTimeMs: now,
        ...(target.uid === undefined ? {} : { uid: target.uid }),
      }, lease),
    ]);
    lease.assertCurrentUid();
  }, []);

  useEffect(() => {
    let mounted = true;
    configureStudyCheckNotifications();
    const responseSubscription = addStudyCheckConfirmListener(({ respondedAtMs }) => {
      void runBackgroundTimerMutation(async (lease, expectedUid) => {
        const loaded = await loadOwnedTimerSessions(expectedUid, lease);
        if (!mounted) return;
        await applyConfirmation(loaded, respondedAtMs, lease, expectedUid);
      });
    });

    void runBackgroundTimerMutation(async (lease, expectedUid) => {
      const loaded = await loadOwnedTimerSessions(expectedUid, lease);
      if (!mounted) return;
      const now = Date.now();
      const reconciled = await reconcileWithLockscreen(loaded, now, expectedUid, lease);
      lease.assertCurrentUid();
      assertTimerOwner(findActiveSession(reconciled.sessions), expectedUid);
      if (!mounted) return;
      setSessions(reconciled.sessions);
      sessionsRef.current = reconciled.sessions;
      setTick(Date.now());
      setIsLoading(false);
      const launchResponse = consumeLastStudyCheckConfirmOnLaunch();
      await settleTimerChildren([
        (async () => {
          if (launchResponse) {
            const latest = await loadOwnedTimerSessions(expectedUid, lease);
            if (!mounted) return;
            await applyConfirmation(latest, launchResponse.respondedAtMs, lease, expectedUid);
          } else {
            await syncScheduledNotification(findActiveSession(reconciled.sessions), now, lease);
          }
        })(),
        flushStudyEventQueue(lease),
      ]);
      lease.assertCurrentUid();
    }).then(() => {
      if (mounted) setIsLoading(false);
    });

    void loadAutoStopNotice().then((notice) => {
      if (mounted) setAutoStopNoticeState(notice);
    }).catch(() => {
      // 読込失敗時も保存済みnoticeを消去しない。
    });
    return () => {
      mounted = false;
      responseSubscription.remove();
    };
  }, [applyConfirmation]);

  useEffect(() => {
    let mounted = true;
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') return;
      void runBackgroundTimerMutation(async (lease, expectedUid) => {
        const loaded = await loadOwnedTimerSessions(expectedUid, lease);
        if (!mounted) return;
        const now = Date.now();
        const reconciled = await reconcileWithLockscreen(loaded, now, expectedUid, lease);
        lease.assertCurrentUid();
        assertTimerOwner(findActiveSession(reconciled.sessions), expectedUid);
        if (!mounted) return;
        setSessions(reconciled.sessions);
        sessionsRef.current = reconciled.sessions;
        setTick(Date.now());
        await settleTimerChildren([
          syncScheduledNotification(findActiveSession(reconciled.sessions), now, lease),
          flushStudyEventQueue(lease),
        ]);
        lease.assertCurrentUid();
      });
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
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
    const { intervalMs, responseWindowMs } = getStudyCheckTiming();
    const end = resolveSessionEnd(toCheckedSession(storedActive), tick, intervalMs, responseWindowMs);
    if (end.endReason !== 'check_timeout') {
      return;
    }
    autoStoppingRef.current = true;
    void runBackgroundTimerMutation(async (lease, expectedUid) => {
      assertTimerOwner(storedActive, expectedUid);
      const loaded = await loadOwnedTimerSessions(expectedUid, lease);
      const target = findActiveSession(loaded);
      if (!target || target.sessionId !== storedActive.sessionId) return;
      const currentEnd = resolveSessionEnd(toCheckedSession(target), tick, intervalMs, responseWindowMs);
      if (currentEnd.endReason !== 'check_timeout') return;
      const stoppedAt = currentEnd.endAt;
      const updated = await stopLocalSession(tick, stoppedAt);
      lease.assertCurrentUid();
      setSessions(updated);
      sessionsRef.current = updated;
      await writeAutoStopNotice(stoppedAt, target.uid);
      lease.assertCurrentUid();
      setAutoStopNoticeState({
        stoppedAt, ...(target.uid === undefined ? {} : { uid: target.uid }),
      });
      await settleTimerChildren([
        cancelStudyCheckNotification(),
        notifyNativeMeasurementStop(target.sessionId).catch(() => {}),
        enqueueAndSendStudyEvent({
          sessionId: target.sessionId, action: 'stop', clientTimeMs: stoppedAt,
          ...(target.uid === undefined ? {} : { uid: target.uid }),
        }, lease),
      ]);
      lease.assertCurrentUid();
    }).then(() => {
      autoStoppingRef.current = false;
    });
  }, [storedActive, tick]);

  // 5-3e-2: 開発ビルドで短い間隔に切り替えている場合はその値を使う(本番ビルドは常に60分・10分)
  const { intervalMs: checkIntervalMs, responseWindowMs: checkResponseWindowMs } = getStudyCheckTiming();
  const effectiveEnd = storedActive
    ? resolveSessionEnd(toCheckedSession(storedActive), tick, checkIntervalMs, checkResponseWindowMs)
    : null;
  const isRunning = effectiveEnd !== null && effectiveEnd.endReason !== 'check_timeout';
  const elapsedMs = isRunning && storedActive ? Math.max(0, tick - storedActive.startAt) : 0;
  const pendingCheck =
    isRunning && storedActive
      ? findPendingCheckAt(toCheckedSession(storedActive), tick, checkIntervalMs, checkResponseWindowMs) !== null
      : false;

  const start = useCallback(async () => {
    const ownerUid = getCurrentUid();
    if (ownerUid === null) return;
    await accountOperationGate.runNormal(ownerUid, async (lease) => {
      const stored = await loadOwnedTimerSessions(ownerUid, lease);
      if (findActiveSession(stored)) return;
      const now = Date.now();
      const sessionId = generateLocalId();
      await requestNotificationPermissionOnce();
      lease.assertCurrentUid();
      const checkEnabled = await fetchCheckEnabled();
      lease.assertCurrentUid();
      rememberCheckEnabledSetting(checkEnabled, ownerUid);
      const updated = await startLocalSession(now, sessionId, checkEnabled, ownerUid);
      lease.assertCurrentUid();
      setSessions(updated);
      sessionsRef.current = updated;
      setTick(Date.now());
      await settleTimerChildren([
        syncScheduledNotification(findActiveSession(updated), now, lease),
        notifyNativeMeasurementStart(sessionId, now, checkEnabled).catch(() => {}),
        enqueueAndSendStudyEvent({
          sessionId, action: 'start', clientTimeMs: now, checkEnabled, uid: ownerUid,
        }, lease),
      ]);
      lease.assertCurrentUid();
    });
  }, []);

  const stop = useCallback(async () => {
    const expectedUid = getCurrentUid();
    if (expectedUid === null) return;
    await accountOperationGate.runNormal(expectedUid, async (lease) => {
      const stored = await loadOwnedTimerSessions(expectedUid, lease);
      const now = Date.now();
      const target = findActiveSession(stored);
      const updated = await stopLocalSession(now);
      lease.assertCurrentUid();
      setSessions(updated);
      sessionsRef.current = updated;
      setTick(Date.now());
      await settleTimerChildren([
        cancelStudyCheckNotification(),
        ...(target ? [
          notifyNativeMeasurementStop(target.sessionId).catch(() => {}),
          enqueueAndSendStudyEvent({
            sessionId: target.sessionId,
            action: 'stop',
            clientTimeMs: now,
            ...(target.uid === undefined ? {} : { uid: target.uid }),
          }, lease),
        ] : []),
      ]);
      lease.assertCurrentUid();
    });
  }, []);

  const confirm = useCallback(async () => {
    const expectedUid = getCurrentUid();
    if (expectedUid === null) return;
    await accountOperationGate.runNormal(expectedUid, async (lease) => {
      const stored = await loadOwnedTimerSessions(expectedUid, lease);
      await applyConfirmation(stored, Date.now(), lease, expectedUid);
      lease.assertCurrentUid();
    });
  }, [applyConfirmation]);

  const dismissAutoStopNotice = useCallback(async () => {
    const expectedUid = getCurrentUid();
    if (expectedUid === null) return;
    await accountOperationGate.runNormal(expectedUid, async (lease) => {
      await loadOwnedTimerSessions(expectedUid, lease);
      const notice = await loadAutoStopNotice();
      lease.assertCurrentUid();
      assertTimerOwner(notice, expectedUid);
      await clearAutoStopNotice();
      lease.assertCurrentUid();
      setAutoStopNoticeState(null);
    });
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
