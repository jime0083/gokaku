/**
 * アプリのタイマーとロック画面(ライブアクティビティ・ロック画面コントロール)の計測の共有(5-3c-5b。
 * requirements 3-2「アプリとロック画面の計測の共有」2026-10-10 決定)。
 *
 * - アプリで開始・停止・自動停止したとき: StudySync.startMeasurement/stopMeasurement を呼び、
 *   計測中の状態(App Group。5-3c-3)を書き・消す(ライブアクティビティの表示)。
 *   サーバーへの送信は今までどおり recordStudyEvent だけで行う(StudySync.startMeasurement/stopMeasurement は
 *   5-3c-5a で nativeSync に送らなくなっている)
 * - 確認への応答(アプリ内・通知のアクション): App Group の計測中の状態の confirmations にも足す
 * - 確認 ON/OFF の設定を App Group に覚えさせる(計測中の状態とは別の値)
 * - アプリを開いたとき・他のアプリから戻ったとき: 計測中の状態を読み、ロック画面での開始・停止を
 *   端末の記録に取り込む(reconcileWithLockscreen)
 *
 * modules/study-sync/src/StudySyncModule は import すると requireNativeModule が即座に実行されるため
 * (studySyncAuthContext.ts と同じ理由)、実際に呼ぶ関数の中でだけ require する。
 * StudySync の呼び出しが失敗(例外)しても、アプリの計測(端末内の記録)は止めない(呼び出し側の指示)。
 * native通知・設定helperは例外を外に出さない。reconcileの所有/lease違反は呼出側へ返す
 */
import { getCurrentUid } from '@/config/firebase';
import type { AccountOperationLease } from '@/features/account/accountOperationGate';
import { fetchActiveGoalId } from '@/features/goals/activeGoalRepository';

import { adoptRemoteActiveSession, findActiveSession, stopLocalSession, type LocalStudySession } from './storage';

// 型だけの import(値は参照しない)なので requireNativeModule は走らない
import type { ActiveStudySession, LastLockscreenStop } from '../../../modules/study-sync/src/StudySync.types';

type StudySyncNativeBridge = {
  startMeasurement(
    uid: string,
    goalId: string,
    sessionId: string,
    startAt: number,
    checkEnabled: boolean,
  ): Promise<boolean>;
  stopMeasurement(uid: string, goalId: string, sessionId: string): Promise<boolean>;
  getActiveSession(): ActiveStudySession | null;
  setActiveSession(session: ActiveStudySession): boolean;
  setCheckEnabledSetting(enabled: boolean): void;
  setCheckEnabledSettingForAccount(uid: string, enabled: boolean): void;
  getLastLockscreenStop(): LastLockscreenStop | null;
  clearLastLockscreenStop(): void;
};

/** require に失敗(ネイティブモジュール未登録。Jest 環境を含む)した場合は null を返す */
function getStudySync(): StudySyncNativeBridge | null {
  try {
    return (
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../modules/study-sync/src/StudySyncModule') as { default: StudySyncNativeBridge }
    ).default;
  } catch {
    return null;
  }
}

/**
 * アプリで計測を開始したときに呼ぶ(requirements 3-2)。
 * ログインしていない・有効な目標がないときは何もしない。StudySync の呼び出しが例外を投げても無視する
 */
export async function notifyNativeMeasurementStart(
  sessionId: string,
  startAt: number,
  checkEnabled: boolean,
): Promise<void> {
  try {
    const uid = getCurrentUid();
    if (!uid) return;
    const goalId = await fetchActiveGoalId();
    if (!goalId) return;
    const studySync = getStudySync();
    if (!studySync) return;
    await studySync.startMeasurement(uid, goalId, sessionId, startAt, checkEnabled);
  } catch {
    // 無視する(requirements 3-2: StudySync の呼び出しが失敗してもアプリの計測は止めない)
  }
}

/** アプリで計測を停止したとき(無応答による自動停止を含む)に呼ぶ */
export async function notifyNativeMeasurementStop(sessionId: string): Promise<void> {
  try {
    const uid = getCurrentUid();
    if (!uid) return;
    const goalId = await fetchActiveGoalId();
    if (!goalId) return;
    const studySync = getStudySync();
    if (!studySync) return;
    await studySync.stopMeasurement(uid, goalId, sessionId);
  } catch {
    // 無視する
  }
}

/**
 * 確認への応答(アプリ内・通知のアクション)を App Group の計測中の状態にも反映する
 * (getActiveSession → confirmations に足す → setActiveSession)。
 * 計測中の状態が無い・読み書きに失敗した場合は何もしない
 */
export function addNativeConfirmation(
  now: number,
  expectedUid?: string,
  sessionId?: string,
): void {
  try {
    const studySync = getStudySync();
    if (!studySync) return;
    const active = studySync.getActiveSession();
    if (!active) return;
    if (expectedUid !== undefined && active.uid !== expectedUid) return;
    if (sessionId !== undefined && active.sessionId !== sessionId) return;
    studySync.setActiveSession({ ...active, confirmations: [...active.confirmations, now] });
  } catch {
    // 無視する
  }
}

/** 確認 ON/OFF の設定を App Group に覚えさせる(計測中の状態とは別の値。5-3c-3) */
export function rememberCheckEnabledSetting(checkEnabled: boolean, ownerUid?: string): void {
  try {
    if (ownerUid === undefined) {
      getStudySync()?.setCheckEnabledSetting(checkEnabled);
    } else {
      if (getCurrentUid() !== ownerUid) return;
      getStudySync()?.setCheckEnabledSettingForAccount(ownerUid, checkEnabled);
    }
  } catch {
    // 無視する
  }
}

export type LockscreenReconcileResult = {
  sessions: LocalStudySession[];
  /** 取り込み(開始・停止)が行われ、表示・通知の予約を直す必要があるか */
  changed: boolean;
};

/**
 * ロック画面での開始・停止を端末の記録に取り込む(requirements 3-2。5-3c-5b)。
 * アプリを開いたとき・他のアプリから戻ったときに呼ぶ。
 *
 * - App Group にあって端末にない計測(ロック画面で開始): 端末に取り込む(サーバーには送らない)
 * - 端末にあって App Group が空(ロック画面で停止): getLastLockscreenStop の sessionId が
 *   一致するときだけ、その stopAt で端末の記録を止める(サーバーには送らない)。取り込んだら
 *   clearLastLockscreenStop を呼ぶ。一致しない・無ければ何もしない
 *   (想定外のケース。データを失わない側に倒し、端末の記録はそのままにする)
 * - 両方にあり sessionId が違う場合も想定外として何もしない(データを失わない側に倒す)
 * - StudySync の呼び出しが例外を投げた場合も、端末の記録は変えない(sessions をそのまま返す)
 */
export async function reconcileWithLockscreen(
  sessions: LocalStudySession[],
  now: number,
  expectedUid?: string,
  lease?: AccountOperationLease,
): Promise<LockscreenReconcileResult> {
  const assertOwner = (value: { uid?: string } | null) => {
    lease?.assertCurrentUid();
    if (expectedUid !== undefined && value?.uid !== undefined && value.uid !== expectedUid) {
      throw new Error('timer-session-owner-mismatch');
    }
  };
  assertOwner(findActiveSession(sessions));
  const studySync = getStudySync();
  if (!studySync) {
    return { sessions, changed: false };
  }

  let remoteActive: ActiveStudySession | null = null;
  let lastLockscreenStop: LastLockscreenStop | null = null;
  try {
    remoteActive = studySync.getActiveSession();
  } catch {
    remoteActive = null;
  }
  try {
    lastLockscreenStop = studySync.getLastLockscreenStop();
  } catch {
    lastLockscreenStop = null;
  }

  const localActive = findActiveSession(sessions);
  assertOwner(remoteActive);

  if (!localActive && remoteActive) {
    // ロック画面で開始された計測を端末に取り込む
    const updated = await adoptRemoteActiveSession(now, remoteActive);
    lease?.assertCurrentUid();
    return { sessions: updated, changed: true };
  }

  if (localActive && !remoteActive) {
    // ロック画面で止められたかもしれない。sessionId が一致するときだけ取り込む
    if (lastLockscreenStop && lastLockscreenStop.sessionId === localActive.sessionId) {
      const updated = await stopLocalSession(now, lastLockscreenStop.stopAt);
      lease?.assertCurrentUid();
      try {
        studySync.clearLastLockscreenStop();
      } catch {
        // 無視する
      }
      return { sessions: updated, changed: true };
    }
    // 想定外(getLastLockscreenStop が無い・別の sessionId): 端末の記録はそのままにし、何もしない
    return { sessions, changed: false };
  }

  // localActive && remoteActive で sessionId が違う場合(想定外)も、何もしない(データを失わない側に倒す)
  return { sessions, changed: false };
}
