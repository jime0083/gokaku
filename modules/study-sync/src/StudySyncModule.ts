import { NativeModule, requireNativeModule } from 'expo';

import type { AccountOperationBlock, AccountOperationInspection, ActiveStudySession, LastLockscreenStop } from './StudySync.types';

/**
 * Phase 1-4 技術検証用の native ブリッジ。
 * アプリを開かずに行うロック画面・通知アクションからのサーバー同期の土台で、
 * Phase 5-3 で本実装に置き換える(タイマー画面からの呼び出し方・認証方式は 5-3 で確定する)
 */
declare class StudySyncModule extends NativeModule<Record<string, never>> {
  /** lease不要の永続block snapshot。認可には使わず、不明状態はtrue。 */
  isAccountOperationBlocked(): boolean;
  /** 詳細はlease内fresh read。busy/破損時はthrowする。 */
  getAccountOperationBlock(): AccountOperationBlock | null;
  /** block確立/同UID・action再開だけを行う。所属検査・消去はしない。 */
  beginAccountOperation(uid: string, action: 'logout' | 'delete'): AccountOperationBlock;
  /** 専用lease内のstrict検査。IO失敗・操作不一致はthrow。 */
  inspectAccountOperation(
    uid: string, action: 'logout' | 'delete', operationId: string,
  ): Promise<AccountOperationInspection>;
  /** 対象UIDのみ同期。検査不成立・未送信残留はthrow。返値は送信件数。 */
  drainAccountOperation(
    uid: string, action: 'logout' | 'delete', operationId: string,
  ): Promise<number>;
  /** 専用lease内で対象UIDだけ消去。IO/unknown/未同期ではrejectしblockを保持。 */
  cleanupAccountOperation(
    uid: string, action: 'logout' | 'delete', operationId: string,
  ): Promise<void>;
  /** 消去済みをasync native lease内で検査してblock解除。失敗時はreject。 */
  finishAccountOperation(
    uid: string, action: 'logout' | 'delete', operationId: string,
  ): Promise<void>;
  /** cloud開始前かつJS checkpoint無しを保証したcaller専用。metadataだけ解除。 */
  cancelAccountOperation(
    uid: string, action: 'logout' | 'delete', operationId: string,
  ): void;
  /** 検証用のデバイストークンを Keychain(App Group 共有)に保存する */
  setAuthContext(uid: string, deviceToken: string): void;
  clearAuthContext(): void;
  /** legacy入口。owner receiptを無効化し、現在UIDへ追認しない。 */
  setCurrentGoalId(goalId: string | null): void;
  /** 新値と明示UIDのowner receiptを同じnative lease内に保存。失敗時throw。 */
  setCurrentGoalIdForAccount(uid: string, goalId: string): void;
  setCheckEnabledSettingForAccount(uid: string, enabled: boolean): void;
  /**
   * 計測の開始(5-3c-5a)。nativeSync には送らない(アプリの記録は recordStudyEvent。source=app)。
   * 計測中の状態(App Group。5-3c-3)を書き、ライブアクティビティを出す。通知の予約は呼び出し側(JS)が行う。
   *
   * sessionId は呼び出し側(JS)が作って渡す(端末内保存・Callable への記録と同じ sessionId を使うため。
   * src/features/timer/id.ts の generateLocalId で作る想定)。startAt(epoch ミリ秒)も呼び出し側が渡す
   * (JS の端末内の記録の startAt と、この計測中の状態の startAt を一致させるため)。
   *
   * 戻り値: 計測中の状態の書き込みに成功したか(渡した値の形が不正・native gate取得失敗の場合は false。
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
  /**
   * 開発ビルド専用: キューに溜まっている項目のうち、「トークンを待つ」印が付いている件数(5-3c-6)。
   * Swift 側は #if DEBUG 内でのみ登録するため Release には存在しない。__DEV__ のときだけ呼ぶこと。
   */
  getPendingQueueWaitingForTokenCount(): number;
  /**
   * 確認用(5-3c-6): nativeSync への1回の送信(StudySyncAPI.send)を直接試す。
   * ロック画面コントロール・通知アクションからの送信は自動化できないため、dev-lockscreen-spike から
   * 直接この関数で試す。戻り値は送れたか(true=200)。
   * Swift 側は #if DEBUG 内でのみ登録するため Release には存在しない。__DEV__ のときだけ呼ぶこと。
   */
  debugSendStudySyncEvent(
    uid: string,
    sessionId: string,
    goalId: string,
    action: 'start' | 'stop' | 'confirm',
    clientTimeMs: number,
    idempotencyKey: string,
    checkEnabled: boolean | null,
  ): Promise<boolean>;
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
   * native gate取得失敗もfalse。書き込めたら true
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

  /**
   * 開発ビルド専用(5-3e-2。problem P-011 (3)): 「勉強中？」確認の間隔・応答期限を開発用の短い値に
   * 切り替える(App Group に保存)。両方 null を渡すと本番の値に戻す(設定を消す)。
   * Swift 側はこの関数自体を #if DEBUG でくくっているため、本番ビルド(Release)には存在しない。
   * 呼び出し側は __DEV__ のときだけ呼ぶこと(src/features/timer/studyCheckDevOverride.ts)
   */
  setStudyCheckDevOverride(intervalMs: number | null, responseWindowMs: number | null): void;
  /**
   * 開発ビルド専用(5-3e-2): 上書き設定を読む。無ければ null。
   * Swift 側の実体が #if DEBUG でくくられているため、本番ビルドには存在しない
   */
  getStudyCheckDevOverride(): { intervalMs: number; responseWindowMs: number } | null;
}

export default requireNativeModule<StudySyncModule>('StudySync');
