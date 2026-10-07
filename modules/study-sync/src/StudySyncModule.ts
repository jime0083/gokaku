import { NativeModule, requireNativeModule } from 'expo';

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
  startMeasurement(uid: string, goalId: string): Promise<boolean>;
  stopMeasurement(uid: string, goalId: string): Promise<boolean>;
  scheduleCheckNotification(afterSeconds: number, goalId: string): Promise<void>;
  flushQueue(): Promise<number>;
  getPendingQueueCount(): number;
  requestNotificationPermission(): Promise<boolean>;
  /** 直前の送信(startMeasurement/stopMeasurement/flushQueue)が失敗した理由。無ければ null */
  getLastSyncErrorReason(): string | null;
}

export default requireNativeModule<StudySyncModule>('StudySync');
