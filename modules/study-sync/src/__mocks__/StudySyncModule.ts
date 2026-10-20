import type { AccountOperationBlock, AccountOperationInspection, ActiveStudySession, LastLockscreenStop } from '../StudySync.types';

/**
 * modules/study-sync/src/StudySyncModule(ネイティブモジュール)の Jest 用の手動モック(5-3c-3)。
 *
 * modules/study-sync/src/StudySyncModule は import すると requireNativeModule が即座に実行され、
 * Jest(ネイティブモジュール未登録)環境では例外になる。このファイルに差し替えるには、
 * テスト側で次のように明示的に呼ぶ(Jest の仕様上、ユーザーのモジュールの手動モックは
 * factory を省略した jest.mock 呼び出しをしないと picked up されない):
 *
 *   jest.mock('<相対パスで ../../../../modules/study-sync/src/StudySyncModule>');
 *
 * 個別のテストは、必要な関数の戻り値だけ `.mockReturnValue(...)` / `.mockResolvedValue(...)` で
 * 上書きする。各関数の既定値は「送信成功・計測中の状態なし・確認 ON」など、このモックを使う既存テストの
 * 動きに影響しない値にしている
 */
const studySyncModuleMock = {
  isAccountOperationBlocked: jest.fn<boolean, []>(() => false),
  getAccountOperationBlock: jest.fn<AccountOperationBlock | null, []>(() => null),
  // 専用操作の既定値で成功を捏造しない。使用するテストが根拠ある結果を設定する。
  beginAccountOperation: jest.fn<AccountOperationBlock, [uid: string, action: 'logout' | 'delete']>(() => {
    throw new Error('beginAccountOperation mock is not configured');
  }),
  inspectAccountOperation: jest.fn<
    Promise<AccountOperationInspection>,
    [uid: string, action: 'logout' | 'delete', operationId: string]
  >(() => Promise.reject(new Error('inspectAccountOperation mock is not configured'))),
  drainAccountOperation: jest.fn<
    Promise<number>, [uid: string, action: 'logout' | 'delete', operationId: string]
  >(() => Promise.reject(new Error('drainAccountOperation mock is not configured'))),
  cleanupAccountOperation: jest.fn<
    Promise<void>, [uid: string, action: 'logout' | 'delete', operationId: string]
  >(() => Promise.reject(new Error('cleanupAccountOperation mock is not configured'))),
  finishAccountOperation: jest.fn<
    Promise<void>, [uid: string, action: 'logout' | 'delete', operationId: string]
  >(() => Promise.reject(new Error('finishAccountOperation mock is not configured'))),
  cancelAccountOperation: jest.fn<
    void, [uid: string, action: 'logout' | 'delete', operationId: string]
  >(() => { throw new Error('cancelAccountOperation mock is not configured'); }),
  setAuthContext: jest.fn<void, [uid: string, deviceToken: string]>(),
  clearAuthContext: jest.fn<void, []>(),
  getLastSyncErrorReason: jest.fn<string | null, []>(() => null),
  setCurrentGoalId: jest.fn<void, [goalId: string | null]>(),
  setCurrentGoalIdForAccount: jest.fn<void, [uid: string, goalId: string]>(),
  setCheckEnabledSettingForAccount: jest.fn<void, [uid: string, enabled: boolean]>(),
  startMeasurement: jest.fn<
    Promise<boolean>,
    [uid: string, goalId: string, sessionId: string, startAt: number, checkEnabled: boolean]
  >(() => Promise.resolve(true)),
  stopMeasurement: jest.fn<Promise<boolean>, [uid: string, goalId: string, sessionId: string]>(() =>
    Promise.resolve(true),
  ),
  flushQueue: jest.fn<Promise<number>, []>(() => Promise.resolve(0)),
  getPendingQueueCount: jest.fn<number, []>(() => 0),
  getPendingQueueWaitingForTokenCount: jest.fn<number, []>(() => 0),
  debugSendStudySyncEvent: jest.fn<
    Promise<boolean>,
    [
      uid: string,
      sessionId: string,
      goalId: string,
      action: 'start' | 'stop' | 'confirm',
      clientTimeMs: number,
      idempotencyKey: string,
      checkEnabled: boolean | null,
    ]
  >(() => Promise.resolve(true)),
  requestNotificationPermission: jest.fn<Promise<boolean>, []>(() => Promise.resolve(true)),
  getActiveSession: jest.fn<ActiveStudySession | null, []>(() => null),
  setActiveSession: jest.fn<boolean, [session: ActiveStudySession]>(() => true),
  clearActiveSession: jest.fn<void, []>(),
  getCheckEnabledSetting: jest.fn<boolean, []>(() => true),
  setCheckEnabledSetting: jest.fn<void, [enabled: boolean]>(),
  getLastLockscreenStop: jest.fn<LastLockscreenStop | null, []>(() => null),
  clearLastLockscreenStop: jest.fn<void, []>(),
  setStudyCheckDevOverride: jest.fn<void, [intervalMs: number | null, responseWindowMs: number | null]>(),
  getStudyCheckDevOverride: jest.fn<{ intervalMs: number; responseWindowMs: number } | null, []>(() => null),
};

export default studySyncModuleMock;
