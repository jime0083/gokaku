import { NativeModule, requireNativeModule } from 'expo';

import type { ActiveStudySession } from './StudySync.types';

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
   * 計測の開始(5-3c-4)。sessionId は呼び出し側(JS)が作って渡す(端末内保存・Callable への記録と
   * 同じ sessionId を使うため。src/features/timer/id.ts の generateLocalId で作る想定)。
   * checkEnabled は nativeSync へ送る開始時の確認 ON/OFF(requirements 3-2)
   */
  startMeasurement(uid: string, goalId: string, sessionId: string, checkEnabled: boolean): Promise<boolean>;
  /** 計測の停止(5-3c-4)。sessionId は開始時と同じ値を渡す */
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
}

export default requireNativeModule<StudySyncModule>('StudySync');
