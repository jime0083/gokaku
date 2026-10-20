/**
 * タイマーの開始・停止を Cloud Functions(recordStudyEvent)に送る層(5-1b-2。requirements 3-2)。
 * 操作はまず送信待ちの列(studyEventQueue.ts。AsyncStorage)に入れてから送る。送れたものは列から消し、
 * 送れなかったものは列に残して、次の機会(アプリ起動時・他のアプリから戻ったとき・次の操作時)に
 * 同じ idempotencyKey で再送する。
 *
 * verifyApplePurchase.ts と同じ理由で、@react-native-firebase/* は実際に呼び出す関数の中でだけ require する
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded, getCurrentUid } from '@/config/firebase';
import type { AccountOperationLease } from '@/features/account/accountOperationGate';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';
import { fetchActiveGoalId } from '@/features/goals/activeGoalRepository';

import { generateLocalId } from './id';
import {
  appendStudyEvent,
  loadStudyEventQueue,
  removeStudyEvent,
  type PendingStudyEvent,
} from './studyEventQueue';

export type StudyEventAction = PendingStudyEvent['action'];

/**
 * recordStudyEvent(Cloud Functions)が送り直しても結果が変わらない場合に返す HttpsError の code。
 * - invalid-argument: 入力の形が不正・指定された目標が見つからない(4-2c-0 で確認した通り、RNFB では
 *   接頭辞なしの値。入力はこのモジュールが組み立てる固定の形のため実際には起きない想定だが、将来の変更で
 *   起きても再送を繰り返さないよう同じ扱いにする)
 * それ以外(認証切れ・サーバー内部エラー・オフライン等の通信エラー)は、やり直せば成功する可能性があるため
 * 列に残して再送する
 */
const PERMANENT_FAILURE_CODES = new Set(['invalid-argument']);

/**
 * resource-exhausted は理由(details.reason)によって扱いを分ける(5-3b-2。5-2b からの申し送り。requirements 3-2)。
 * - confirmation-limit-exceeded: 1つの計測に保存できる confirmations の数の上限に達している(5-2a)。
 *   上限に達した状態は送り直しても変わらないため列から外す(5-2b からの対応を維持)
 * - rate-limited: ユーザーごとの1分あたりの呼び出し回数の上限に達している(5-3b-2)。
 *   少し待てば(次の1分になれば)通るようになるため、列から外さず残して再送する
 * reason が上のどちらでもない(想定外)場合は、データを失わない側に倒して列に残す
 */
const PERMANENT_RESOURCE_EXHAUSTED_REASONS = new Set(['confirmation-limit-exceeded']);

function isPermanentFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') {
    return false;
  }
  if (PERMANENT_FAILURE_CODES.has(code)) {
    return true;
  }
  if (code === 'resource-exhausted') {
    const reason = (error as { details?: { reason?: unknown } } | null | undefined)?.details?.reason;
    return typeof reason === 'string' && PERMANENT_RESOURCE_EXHAUSTED_REASONS.has(reason);
  }
  return false;
}

async function callRecordStudyEvent(event: PendingStudyEvent, goalId: string): Promise<void> {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;

  const callable = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), 'recordStudyEvent');
  await callable({
    sessionId: event.sessionId,
    goalId,
    action: event.action,
    source: 'app',
    clientTimeMs: event.clientTimeMs,
    idempotencyKey: event.idempotencyKey,
    // recordStudyEvent は action が 'start' のときだけ checkEnabled(boolean)を必須で受け取る(5-2a)。
    // users.checkEnabled を読んだ値(5-2b。呼び出し側の enqueueAndSendStudyEvent が event に積む)を送る
    ...(event.action === 'start' ? { checkEnabled: event.checkEnabled } : {}),
  });
}

type SendOutcome = 'sent' | 'dropped' | 'kept';

function matchesEventOwner(event: PendingStudyEvent, expectedUid: string): boolean {
  return getCurrentUid() === expectedUid && (event.uid === undefined || event.uid === expectedUid);
}

async function sendPendingEvent(
  event: PendingStudyEvent,
  expectedUid: string,
  lease: AccountOperationLease,
): Promise<SendOutcome> {
  if (!matchesEventOwner(event, expectedUid)) return 'kept';
  lease.assertCurrentUid();
  const goalId = await fetchActiveGoalId();
  if (!matchesEventOwner(event, expectedUid)) return 'kept';
  lease.assertCurrentUid();
  if (!goalId) {
    // 未ログイン・有効な目標がない(実際のユーザーには起きない)。送らずに列に残し、次の機会にやり直す
    return 'kept';
  }
  try {
    await callRecordStudyEvent(event, goalId);
    if (!matchesEventOwner(event, expectedUid)) return 'kept';
    lease.assertCurrentUid();
    return 'sent';
  } catch (error) {
    if (!matchesEventOwner(event, expectedUid)) return 'kept';
    lease.assertCurrentUid();
    return isPermanentFailure(error) ? 'dropped' : 'kept';
  }
}

let flushing = false;

/**
 * 送信待ちの列を古い順に送り直す。
 * アプリ起動時・他のアプリから戻ったとき(AppState が active)・次の操作時(enqueueAndSendStudyEvent)に呼ぶ。
 * すでに実行中の場合は何もしない(同時に2回走らないようにする。その回で送れなかった分は、
 * 次にこの関数が呼ばれる機会に改めて送られる)
 */
export async function flushStudyEventQueue(parentLease?: AccountOperationLease): Promise<void> {
  const expectedUid = getCurrentUid();
  if (!expectedUid) return;
  await accountOperationGate.runNormal(expectedUid, async (lease) => {
    await drainStudyEventQueue(expectedUid, lease, false);
  }, parentLease);
}

/**
 * account側はraw strict inspectionを先に完了し、有効なaccount permitを渡す。
 * 対象UIDの残件なしを確認できた場合だけtrue。競合・再送待ちはfalse。
 * 通常writerのleaseとしてpermitを流用しない。
 */
export async function flushStudyEventQueueForAccount(
  expectedUid: string,
  accountPermit: AccountOperationLease,
): Promise<boolean> {
  accountPermit.assertCurrentUid();
  if (!expectedUid || getCurrentUid() !== expectedUid) throw new Error('uid-changed');
  const complete = await drainStudyEventQueue(expectedUid, accountPermit, true);
  accountPermit.assertCurrentUid();
  if (getCurrentUid() !== expectedUid) throw new Error('uid-changed');
  return complete;
}

async function drainStudyEventQueue(
  expectedUid: string,
  lease: AccountOperationLease,
  accountOnly: boolean,
): Promise<boolean> {
  lease.assertCurrentUid();
  if (flushing) return false;
  flushing = true;
  try {
    for (;;) {
      lease.assertCurrentUid();
      const queue = await loadStudyEventQueue();
      if (getCurrentUid() !== expectedUid) return false;
      lease.assertCurrentUid();
      const event = accountOnly ? queue.find((item) => item.uid === expectedUid) : queue[0];
      if (!event) return true;
      if (!matchesEventOwner(event, expectedUid)) return false;
      const outcome = await sendPendingEvent(event, expectedUid, lease);
      if (outcome === 'kept' || (accountOnly && outcome === 'dropped') || !matchesEventOwner(event, expectedUid)) return false;
      lease.assertCurrentUid();
      // 所有付きeventの同key別UID/legacyは削除しない。
      await removeStudyEvent(event.idempotencyKey, event.uid, lease.assertCurrentUid);
      if (getCurrentUid() !== expectedUid) return false;
      lease.assertCurrentUid();
    }
  } finally {
    flushing = false;
  }
}

/** enqueueAndSendStudyEvent に渡す値。'start' だけ checkEnabled を必須で持つ(studyEventQueue と同じ理由) */
export type EnqueueStudyEventParams = { uid?: string } & (
  | { sessionId: string; action: 'start'; clientTimeMs: number; checkEnabled: boolean }
  | { sessionId: string; action: 'stop' | 'confirm'; clientTimeMs: number }
);

/**
 * 開始・停止・確認への応答を送信待ちの列に入れてから送る(requirements 3-2)。
 * sessionId は呼び出し側(useTimerSession)が計測開始時に作ったものを渡す。
 * idempotencyKey は操作ごとにここで作り、送信に失敗して列に残っている間・再送時も同じ値を使う
 */
export async function enqueueAndSendStudyEvent(
  params: EnqueueStudyEventParams,
  parentLease?: AccountOperationLease,
): Promise<void> {
  const currentUid = getCurrentUid();
  if (!currentUid) return;
  const expectedUid = params.uid ?? currentUid;
  await accountOperationGate.runNormal(expectedUid, async (lease) => {
    lease.assertCurrentUid();
    const idempotencyKey = generateLocalId();
    // UID省略の旧呼出しにownerを追認しない。
    const event: PendingStudyEvent = { ...params, idempotencyKey };
    await appendStudyEvent(event, undefined, lease.assertCurrentUid);
    if (getCurrentUid() !== expectedUid) return;
    lease.assertCurrentUid();
    await flushStudyEventQueue(lease);
    if (getCurrentUid() !== expectedUid) return;
    lease.assertCurrentUid();
  }, parentLease);
}
