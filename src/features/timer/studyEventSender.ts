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

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';
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
 * - resource-exhausted: 1つの計測に保存できる confirmations の数の上限に達している(5-2a)。
 *   上限に達した状態は送り直しても変わらないため列から外す(5-2b。5-2a からの申し送り)
 * それ以外(認証切れ・サーバー内部エラー・オフライン等の通信エラー)は、やり直せば成功する可能性があるため
 * 列に残して再送する
 */
const PERMANENT_FAILURE_CODES = new Set(['invalid-argument', 'resource-exhausted']);

function isPermanentFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && PERMANENT_FAILURE_CODES.has(code);
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

async function sendPendingEvent(event: PendingStudyEvent): Promise<SendOutcome> {
  const goalId = await fetchActiveGoalId();
  if (!goalId) {
    // 未ログイン・有効な目標がない(実際のユーザーには起きない)。送らずに列に残し、次の機会にやり直す
    return 'kept';
  }
  try {
    await callRecordStudyEvent(event, goalId);
    return 'sent';
  } catch (error) {
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
export async function flushStudyEventQueue(): Promise<void> {
  if (flushing) {
    return;
  }
  flushing = true;
  try {
    for (;;) {
      const queue = await loadStudyEventQueue();
      const [event] = queue;
      if (!event) {
        return;
      }
      const outcome = await sendPendingEvent(event);
      if (outcome === 'kept') {
        return;
      }
      // 'sent'(送信できた) または 'dropped'(送り直しても成功しない) → 列から外して次へ
      await removeStudyEvent(event.idempotencyKey);
    }
  } finally {
    flushing = false;
  }
}

/** enqueueAndSendStudyEvent に渡す値。'start' だけ checkEnabled を必須で持つ(studyEventQueue と同じ理由) */
export type EnqueueStudyEventParams =
  | { sessionId: string; action: 'start'; clientTimeMs: number; checkEnabled: boolean }
  | { sessionId: string; action: 'stop' | 'confirm'; clientTimeMs: number };

/**
 * 開始・停止・確認への応答を送信待ちの列に入れてから送る(requirements 3-2)。
 * sessionId は呼び出し側(useTimerSession)が計測開始時に作ったものを渡す。
 * idempotencyKey は操作ごとにここで作り、送信に失敗して列に残っている間・再送時も同じ値を使う
 */
export async function enqueueAndSendStudyEvent(params: EnqueueStudyEventParams): Promise<void> {
  const idempotencyKey = generateLocalId();
  const event: PendingStudyEvent = { ...params, idempotencyKey };
  await appendStudyEvent(event);
  await flushStudyEventQueue();
}
