import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import {
  compareTimestamps,
  isJudgementHistoryEntry,
  isJudgementSnapshot,
  isTimestampLike,
  type JudgementSnapshots,
  type JudgementStream,
} from '../../../shared/judgementHistory';
import { getWritableAccount } from '../account/accountWriteGuard';

export type InitializeHistoryResult = {
  status: 'initialized' | 'alreadyInitialized';
};

/** 保存値・UID・秘密情報をエラーに含めない。SDKのI/O例外は変更せず伝播する。 */
export class InitializeHistoryError extends Error {
  constructor() {
    super('Judgement history initialization failed');
    this.name = 'InitializeHistoryError';
  }
}

const STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;
const LEGACY_DEFAULTS = { xPostEnabled: false, xLinked: false, subscription: null } as const;
const MAX_UID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('/')
    && value !== '.'
    && value !== '..'
    && !/^__.*__$/.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isSdkTimestamp(value: unknown): value is Timestamp {
  if (!(value instanceof Timestamp) || !isTimestampLike(value)) return false;
  try {
    new Timestamp(value.seconds, value.nanoseconds);
    return true;
  } catch {
    return false;
  }
}

function readMetadata(data: Record<string, unknown>): {
  startedAt: Timestamp;
  revisions: Record<JudgementStream, number>;
} | null {
  const hasStart = hasOwn(data, 'judgementHistoryStartedAt');
  const hasRevisions = hasOwn(data, 'judgementRevisions');
  if (!hasStart && !hasRevisions) return null;
  const startedAt = data.judgementHistoryStartedAt;
  const revisions = data.judgementRevisions;
  if (
    !hasStart || !hasRevisions
    || !isSdkTimestamp(startedAt)
    || !isRecord(revisions)
    || Reflect.ownKeys(revisions).length !== STREAMS.length
    || !STREAMS.every((stream) =>
      hasOwn(revisions, stream)
      && typeof revisions[stream] === 'number'
      && Number.isSafeInteger(revisions[stream])
      && revisions[stream] > 0,
    )
  ) {
    throw new InitializeHistoryError();
  }
  return { startedAt, revisions: revisions as Record<JudgementStream, number> };
}

function snapshot<S extends JudgementStream>(stream: S, value: unknown): JudgementSnapshots[S] {
  if (!isJudgementSnapshot(stream, value)) throw new InitializeHistoryError();
  return value;
}

async function readCurrentSnapshots(
  tx: Transaction,
  userRef: DocumentReference,
  data: Record<string, unknown>,
): Promise<JudgementSnapshots> {
  const settings = snapshot('settings', { xPostEnabled: data.xPostEnabled });
  const xLink = snapshot('xLink', { xLinked: data.xLinked });
  const rawSubscription = data.subscription;
  if (rawSubscription !== null && (
    !isRecord(rawSubscription) || !hasOwn(rawSubscription, 'expiresAt')
  )) {
    throw new InitializeHistoryError();
  }
  const subscription = snapshot('subscription', rawSubscription === null
    ? null : { expiresAt: rawSubscription.expiresAt });

  let goal: JudgementSnapshots['goal'] = null;
  if (hasOwn(data, 'activeGoalId') && data.activeGoalId !== null) {
    const goalId = data.activeGoalId;
    if (!isDocumentId(goalId)) throw new InitializeHistoryError();
    const goalDoc = await tx.get(userRef.collection('goals').doc(goalId));
    const currentGoal: unknown = goalDoc.data();
    if (!goalDoc.exists || !isRecord(currentGoal)) throw new InitializeHistoryError();
    goal = snapshot('goal', {
      goalId,
      startDate: currentGoal.startDate,
      examDate: currentGoal.examDate,
      minDailyMinutes: currentGoal.minDailyMinutes,
      goalDailyMinutes: currentGoal.goalDailyMinutes,
    });
  }
  return { goal, settings, xLink, subscription };
}

/** 検証済み最小snapshotはnullかprimitiveのみを持つobject。 */
function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => hasOwn(b, key) && a[key] === b[key]);
}

function entries(userRef: DocumentReference, stream: JudgementStream) {
  return userRef.collection('judgementHistory').doc(stream).collection('entries');
}

/**
 * サーバー内部専用。時刻入力・公開Function・アプリ接続は持たない。
 * 再試行ごとにgetWritableAccount/現在goal/履歴を同じtxで読み直す。
 * 全読取・検証後に既存の親だけupdateし、baselineはcreateのみで保存する。
 */
export async function initializeHistory(db: Firestore, uid: string): Promise<InitializeHistoryResult> {
  if (!isDocumentId(uid) || uid.length > MAX_UID_LENGTH) throw new InitializeHistoryError();
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction<InitializeHistoryResult>(async (tx) => {
    const parent = await getWritableAccount(tx, userRef);
    const data: unknown = parent.data();
    if (!isRecord(data)) throw new InitializeHistoryError();
    const metadata = readMetadata(data);
    const defaults: Record<string, unknown> = {};
    if (metadata === null) {
      for (const key of Object.keys(LEGACY_DEFAULTS) as (keyof typeof LEGACY_DEFAULTS)[]) {
        if (!hasOwn(data, key)) defaults[key] = LEGACY_DEFAULTS[key];
      }
    }
    const current = await readCurrentSnapshots(tx, userRef, { ...data, ...defaults });

    if (metadata !== null) {
      // baselineだけでなく現在counterの4entryを検証する。無変更でもwriteを登録しない。
      await Promise.all(STREAMS.map(async (stream) => {
        const revision = metadata.revisions[stream];
        const entryDoc = await tx.get(entries(userRef, stream).doc(String(revision)));
        const entry: unknown = entryDoc.data();
        if (
          !entryDoc.exists
          || entryDoc.id !== String(revision)
          || !isJudgementHistoryEntry(stream, entry)
          || !isSdkTimestamp(entry.committedAt)
          || entry.revision !== revision
          || !sameSnapshot(entry.after, current[stream])
          || compareTimestamps(entry.committedAt, metadata.startedAt) < 0
          || (revision === 1 && (
            compareTimestamps(entry.committedAt, metadata.startedAt) !== 0
            || !sameSnapshot(entry.before, entry.after)
          ))
        ) {
          throw new InitializeHistoryError();
        }
      }));
      return { status: 'alreadyInitialized' };
    }

    // metadata両absentでも任意ID/不正entryの孤立履歴を見逃さない。
    const history = await Promise.all(STREAMS.map((stream) =>
      tx.get(entries(userRef, stream).limit(1)),
    ));
    if (history.some((result) => !result.empty)) throw new InitializeHistoryError();

    const committedAt = FieldValue.serverTimestamp();
    tx.update(userRef, {
      ...defaults,
      judgementHistoryStartedAt: committedAt,
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    });
    for (const stream of STREAMS) {
      tx.create(entries(userRef, stream).doc('1'), {
        schemaVersion: 1,
        revision: 1,
        committedAt,
        before: current[stream],
        after: current[stream],
      });
    }
    return { status: 'initialized' };
  });
}
