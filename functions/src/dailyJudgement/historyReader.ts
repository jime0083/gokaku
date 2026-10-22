/**
 * cutoff直前の判定入力を、呼出側のAdmin transaction内で復元する。
 * 書込み・transaction開始・現在時刻取得は行わない。
 */
import {
  DocumentReference,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import type { JudgementGoal, JudgementUser } from '../../../shared/dailyJudgement';
import {
  compareTimestamps,
  isTimestampLike,
  selectJudgementHistory,
  type JudgementSnapshots,
  type JudgementStream,
} from '../../../shared/judgementHistory';

export type JudgementHistoryReadResult =
  | {
      status: 'available';
      goalId: string;
      goal: JudgementGoal;
      user: JudgementUser;
    }
  | { status: 'beforeCoverage' }
  | { status: 'noAccount' }
  | { status: 'deleting' }
  | { status: 'noGoal' };

/** 欠損・不正値の通知。UID・保存値・SDKエラーを含めない。 */
export class JudgementHistoryReadError extends Error {
  constructor() {
    super('Judgement history read failed');
    this.name = 'JudgementHistoryReadError';
  }
}

const STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSdkTimestamp(value: unknown): value is Timestamp {
  if (!(value instanceof Timestamp) || !isTimestampLike(value)) return false;
  try {
    // SDKの有効範囲も検証する。toMillis/toDateへの変換はしない。
    new Timestamp(value.seconds, value.nanoseconds);
    return true;
  } catch {
    return false;
  }
}

function requireUserReference(ref: DocumentReference): void {
  if (!(ref instanceof DocumentReference)) throw new JudgementHistoryReadError();
  const parts = ref.path.split('/');
  const uid = parts[1];
  if (
    parts.length !== 2
    || parts[0] !== 'users'
    || !uid
    || uid.trim().length === 0
    || uid.length > 128
    || uid === '.'
    || uid === '..'
    || /^__.*__$/.test(uid)
    || Buffer.from(uid, 'utf8').toString('utf8') !== uid
  ) {
    throw new JudgementHistoryReadError();
  }
}

function isRevisions(
  value: unknown,
): value is Record<JudgementStream, number> {
  return isRecord(value)
    && Reflect.ownKeys(value).length === STREAMS.length
    && STREAMS.every((stream) =>
      Object.prototype.hasOwnProperty.call(value, stream)
      && typeof value[stream] === 'number'
      && Number.isSafeInteger(value[stream])
      && value[stream] > 0,
    );
}

async function readStream<S extends JudgementStream>(
  tx: Transaction,
  userRef: DocumentReference,
  stream: S,
  parentRevision: number,
  coverageStart: Timestamp,
  cutoff: Timestamp,
): Promise<JudgementSnapshots[S]> {
  const collection = userRef.collection('judgementHistory')
    .doc(stream).collection('entries');
  const beforeQuery = collection.where('committedAt', '<', cutoff)
    .orderBy('committedAt', 'desc').orderBy('revision', 'desc').limit(1);
  const afterQuery = collection.where('committedAt', '>=', cutoff)
    .orderBy('committedAt', 'asc').orderBy('revision', 'asc').limit(1);
  const [before, after] = await Promise.all([
    tx.get(beforeQuery),
    tx.get(afterQuery),
  ]);
  const candidates = [...before.docs, ...after.docs].map((doc) => {
    const data: unknown = doc.data();
    if (
      !isRecord(data)
      || !isSdkTimestamp(data.committedAt)
      || typeof data.revision !== 'number'
      || !Number.isSafeInteger(data.revision)
      || data.revision <= 0
      || doc.id !== String(data.revision)
      || doc.ref.path !== collection.path + '/' + doc.id
    ) {
      throw new JudgementHistoryReadError();
    }
    // SDK Timestampを秒/nanoのまま渡し、snapshotのnullも保持する。
    return data;
  });
  const selected = selectJudgementHistory({
    stream,
    parentRevision,
    coverageStart,
    cutoff,
    entries: candidates,
  });
  if (selected.status !== 'available') throw new JudgementHistoryReadError();
  return selected.snapshot;
}

/**
 * 親・counter・4streamを必ず渡されたtxで読む。
 * 呼出側は、この呼出しとsessions/dailyResult読取・結果createを
 * 同じrunTransaction callback内で実行できる。
 * SDKのI/O例外は変更せず伝播し、transactionの再試行判定を維持する。
 */
export async function readJudgementHistory(
  tx: Transaction,
  userRef: DocumentReference,
  cutoff: Timestamp,
): Promise<JudgementHistoryReadResult> {
  requireUserReference(userRef);
  if (!isSdkTimestamp(cutoff)) throw new JudgementHistoryReadError();

  const parent = await tx.get(userRef);
  if (!parent.exists) return { status: 'noAccount' };
  const data: unknown = parent.data();
  if (!isRecord(data)) throw new JudgementHistoryReadError();
  if (data.deletionInProgress === true) return { status: 'deleting' };

  const hasStart = Object.prototype.hasOwnProperty.call(data, 'judgementHistoryStartedAt');
  const hasRevisions = Object.prototype.hasOwnProperty.call(data, 'judgementRevisions');
  if (!hasStart && !hasRevisions) return { status: 'beforeCoverage' };
  const startedAt = data.judgementHistoryStartedAt;
  const revisions = data.judgementRevisions;
  if (
    !hasStart
    || !hasRevisions
    || !isSdkTimestamp(startedAt)
    || !isRevisions(revisions)
  ) {
    throw new JudgementHistoryReadError();
  }
  if (compareTimestamps(startedAt, cutoff) >= 0) return { status: 'beforeCoverage' };

  // goalなしでも残るstreamの欠損を正常skipへ置き換えない。
  const [goalSnapshot, settings, xLink, subscription] = await Promise.all([
    readStream(tx, userRef, 'goal', revisions.goal, startedAt, cutoff),
    readStream(tx, userRef, 'settings', revisions.settings, startedAt, cutoff),
    readStream(tx, userRef, 'xLink', revisions.xLink, startedAt, cutoff),
    readStream(tx, userRef, 'subscription', revisions.subscription, startedAt, cutoff),
  ]);
  if (goalSnapshot === null) return { status: 'noGoal' };
  const { goalId, ...goal } = goalSnapshot;
  return {
    status: 'available',
    goalId,
    goal,
    user: {
      subscription,
      xPostEnabled: settings.xPostEnabled,
      xLinked: xLink.xLinked,
    },
  };
}
