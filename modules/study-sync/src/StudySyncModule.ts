import { NativeModule, requireNativeModule } from 'expo';

import type { ActiveStudySession, LastLockscreenStop } from './StudySync.types';

/**
 * Phase 1-4 技術検証用の native ブリッジ。
 * アプリを開かずに行うロック画面・通知アクションからのサーバー同期の土台で、
 * Phase 5-3 で本実装に置き換える(タイマー画面からの呼び出し方・認証方式は 5-3 で確定する)
 */
declare class StudySyncModule extends NativeModule<Record<string, never>> {
  /** 検証用のデバイストークンを Keychain(App Group 共有)に保存する */
  setAuthContext(uid: string, deviceToken: string): void;
  clearAuthContext(): void;
  setCurrentGoalId(goalId: string | null): void;
  /**
   * 計測の開始(5-3c-5a)。nativeSync には送らない(アプリの記録は recordStudyEvent。source=app)。
   * 計測中の状態(App Group。5-3c-3)を書き、ライブアクティビティを出す。通知の予約は呼び出し側(JS)が行う。
   *
   * sessionId は呼び出し側(JS)が作って渡す(端末内保存・Callable への記録と同じ sessionId を使うため。
   * src/features/timer/id.ts の generateLocalId で作る想定)。startAt(epoch ミリ秒)も呼び出し側が渡す
   * (JS の端末内の記録の startAt と、この計測中の状態の startAt を一致させるため)。
   *
   * 戻り値: 計測中の状態の書き込みに成功したか(渡した値の形が不正な場合だけ false。
   * ライブアクティビティの表示が OS 側の制約で失敗しても false にはならない)
   */
  startMeasurement(
    uid: string,
    goalId: string,
    sessionId: string,
    startAt: number,
    checkEnabled: boolean,
  ): Promise<boolean>;
  /**
   * 計測の停止(5-3c-5a)。nativeSync には送らない(理由は startMeasurement と同じ)。
   * sessionId は開始時と同じ値を渡す。通知の取り消しは呼び出し側(JS)が行う。
   *
   * 戻り値: 消す前に計測中の状態が実際にあったか(true=あった・消した、false=すでに無かった。
   * 例えばロック画面の停止が先に届いていた場合)
   */
  stopMeasurement(uid: string, goalId: string, sessionId: string): Promise<boolean>;
  flushQueue(): Promise<number>;
  getPendingQueueCount(): number;
  requestNotificationPermission(): Promise<boolean>;
  /** 直前の送信(startMeasurement/stopMeasurement/flushQueue)が失敗した理由。無ければ null */
  getLastSyncErrorReason(): string | null;

  /**
   * 計測中の状態(5-3c-3。App Group に 1 件だけ置く。requirements 3-2)を読む。
   * 計測中でなければ null
   */
  getActiveSession(): ActiveStudySession | null;
  /**
   * 計測中の状態を書く。形が不正(必須項目が無い・型が違う)な場合は書き込みを断り false を返す
   * (例外は投げない)。書き込めたら true
   */
  setActiveSession(session: ActiveStudySession): boolean;
  clearActiveSession(): void;
  /** 確認 ON/OFF の設定(計測中の状態とは別に App Group に覚えておく値)を読む。初期値 true */
  getCheckEnabledSetting(): boolean;
  setCheckEnabledSetting(enabled: boolean): void;

  /**
   * ロック画面(StopStudyIntent)で止めた最後の計測(sessionId・stopAt)を読む(5-3c-5a)。
   * 無ければ null
   */
  getLastLockscreenStop(): LastLockscreenStop | null;
  clearLastLockscreenStop(): void;
}

export default requireNativeModule<StudySyncModule>('StudySync');
