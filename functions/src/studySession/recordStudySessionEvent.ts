import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { toJstDateKey } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';

/**
 * 計測の開始・停止・「勉強中？」確認への応答を受け取り、時刻の補正(requirements 3-2)をして
 * users/{uid}/sessions/{sessionId} に保存する処理の本体。
 *
 * Callable(recordStudyEvent。5-1b-1・5-2a)と、ロック画面・通知アクションからの同期(nativeSync。5-3)の
 * 両方から呼べるように、認証方式に依存しない形(uid は呼び出し側が確定させたものを渡す)にしている。
 *
 * 時刻の補正(requirements 3-2。start・stop・confirm のどの操作にも同じ補正をかける):
 * - 端末時刻(clientTimeMs)がサーバー受信時刻より未来 → サーバー受信時刻に置き換える
 * - 端末時刻の日本時間の日付について、users/{uid}/dailyResults/{YYYY-MM-DD} が
 *   すでにある(0:00 の判定が確定済み)→ サーバー受信時刻に置き換える
 *
 * 二重記録の防止: 同じ idempotencyKey を2回処理しない(users/{uid}/sessionEvents/{idempotencyKey} に
 * 処理済みの印を残し、2回目以降は何もせず 'duplicate' を返す)。
 *
 * 1つの sessionId に、すでに値がある startAt/stopAt・goalId/source/endReason・checkEnabled を別の値で
 * 上書きしようとした場合は、最初に書き込まれた値を残して無視する(開始より先に停止や確認応答が届いても、
 * 後から届いた開始と揃って正しいセッションになる)。
 *
 * confirm(5-2a。requirements 3-2「確認への応答もサーバーに送り、sessions の confirmations[] に保存する」):
 * - 補正後の応答時刻を confirmations[](epoch ミリ秒の配列)に追加する。順序は問わない
 *   (shared/studyCheck.ts の CheckedStudySession.confirmations は「順不同」の配列として扱う)
 * - 同じ idempotencyKey の再送は上の二重記録防止で弾かれるため、ここでの追加だけを考えればよい
 * - confirm が start より先に届いても、sessions ドキュメントがまだ無くても confirmations に追加できる
 * - 1つのセッションに保存できる confirmations の数には上限(MAX_CONFIRMATIONS_PER_SESSION)を設ける。
 *   上限に達している場合は RecordStudySessionEventError('confirmation-limit-exceeded') を投げる
 *
 * checkEnabled(5-2a。requirements 3-2「開始時の確認 ON/OFF を sessions の checkEnabled に保存する」):
 * - action が 'start' のときだけ受け取り、保存する(必須。既にある場合は最初の値を残す)
 * - start 以外の操作で checkEnabled が送られてきても無視する(読み取らない)
 *
 * endReason の check_timeout(無応答による自動停止の反映)は 5-2b で扱う。このタスクでは endReason は常に 'manual'
 */

export const RECORD_STUDY_EVENT_ACTIONS = ['start', 'stop', 'confirm'] as const;
export type RecordStudyEventAction = (typeof RECORD_STUDY_EVENT_ACTIONS)[number];

/**
 * 1つのセッションに保存できる confirmations の数の上限(5-2a)。
 * 確認は60分ごとなので、500件は約20.8日間の継続した応答に相当する
 * (checkEnabled ON では無応答が10分続くと自動停止するため、実際のセッションがこれに近づくことは想定していない)。
 * 通常のセッション長を大きく超える安全域を確保しつつ、不正な再送やバグによる無制限なドキュメントの肥大化を防ぐ
 */
export const MAX_CONFIRMATIONS_PER_SESSION = 500;

// requirements.md 5: sessions.source(app/lockscreen)
export const RECORD_STUDY_EVENT_SOURCES = ['app', 'lockscreen'] as const;
export type RecordStudyEventSource = (typeof RECORD_STUDY_EVENT_SOURCES)[number];

export type RecordStudySessionEventInput = {
  sessionId: string;
  goalId: string;
  action: RecordStudyEventAction;
  source: RecordStudyEventSource;
  clientTimeMs: number;
  idempotencyKey: string;
  /**
   * 計測開始時点の「勉強中？」確認の ON/OFF(requirements 3-2)。
   * action が 'start' のときに使う値。他の action では無視する
   */
  checkEnabled?: boolean;
};

export type RecordStudySessionEventDeps = {
  /** サーバー受信時刻(epoch ミリ秒)。テストから固定できるようにする */
  now: () => number;
};

export function createProductionRecordStudySessionEventDeps(): RecordStudySessionEventDeps {
  return { now: () => Date.now() };
}

export type RecordStudySessionEventResult = { status: 'recorded' | 'duplicate' };

export type RecordStudySessionEventErrorReason = 'goal-not-found' | 'confirmation-limit-exceeded';

/** 内部の詳細を含まない、呼び出し側(Callable・nativeSync)が文言に変換するためのエラー */
export class RecordStudySessionEventError extends Error {
  readonly reason: RecordStudySessionEventErrorReason;

  constructor(reason: RecordStudySessionEventErrorReason, message: string) {
    super(message);
    this.name = 'RecordStudySessionEventError';
    this.reason = reason;
  }
}

export async function recordStudySessionEvent(
  uid: string,
  input: RecordStudySessionEventInput,
  deps: RecordStudySessionEventDeps,
): Promise<RecordStudySessionEventResult> {
  ensureAdminApp();
  const db = getFirestore();

  // goalId が本人の実在する目標かを確認する(他人の goalId・架空の goalId を拒否。requirements 5)
  const goalSnap = await db.doc(`users/${uid}/goals/${input.goalId}`).get();
  if (!goalSnap.exists) {
    throw new RecordStudySessionEventError('goal-not-found', '指定された目標が見つかりません');
  }

  return db.runTransaction(async (tx) => {
    const eventRef = db.doc(`users/${uid}/sessionEvents/${input.idempotencyKey}`);
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) {
      return { status: 'duplicate' };
    }

    const sessionRef = db.doc(`users/${uid}/sessions/${input.sessionId}`);
    const sessionSnap = await tx.get(sessionRef);
    const existing = (sessionSnap.exists ? sessionSnap.data() : undefined) ?? {};

    const serverReceivedAtMs = deps.now();
    let correctedTimeMs = input.clientTimeMs;
    if (input.clientTimeMs > serverReceivedAtMs) {
      // 端末時刻がサーバー受信時刻より未来(requirements 3-2)
      correctedTimeMs = serverReceivedAtMs;
    } else {
      const dateKey = toJstDateKey(input.clientTimeMs);
      const dailyResultSnap = await tx.get(db.doc(`users/${uid}/dailyResults/${dateKey}`));
      if (dailyResultSnap.exists) {
        // 端末時刻の日付について 0:00 の判定が確定済み(requirements 3-2)
        correctedTimeMs = serverReceivedAtMs;
      }
    }

    // すでにある値は残して無視する(最初に書き込まれた値を正とする)
    const update: Record<string, unknown> = {};
    if (!('goalId' in existing)) update.goalId = input.goalId;
    if (!('source' in existing)) update.source = input.source;
    if (!('endReason' in existing)) update.endReason = 'manual';

    if (input.action === 'start') {
      if (!('startAt' in existing)) update.startAt = correctedTimeMs;
      if (!('checkEnabled' in existing) && typeof input.checkEnabled === 'boolean') {
        update.checkEnabled = input.checkEnabled;
      }
    } else if (input.action === 'stop') {
      if (!('stopAt' in existing)) update.stopAt = correctedTimeMs;
    } else {
      // confirm(5-2a): 補正後の応答時刻を confirmations[] に追加する(順序は問わない)
      const existingConfirmations = Array.isArray(existing.confirmations)
        ? (existing.confirmations as number[])
        : [];
      if (existingConfirmations.length >= MAX_CONFIRMATIONS_PER_SESSION) {
        throw new RecordStudySessionEventError(
          'confirmation-limit-exceeded',
          '1つの計測に保存できる応答の数の上限に達しています',
        );
      }
      update.confirmations = [...existingConfirmations, correctedTimeMs];
    }

    tx.set(sessionRef, update, { merge: true });
    tx.set(eventRef, {
      sessionId: input.sessionId,
      action: input.action,
      processedAt: FieldValue.serverTimestamp(),
    });

    return { status: 'recorded' };
  });
}
