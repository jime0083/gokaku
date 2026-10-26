/**
 * 確定dailyResultに対応する待機投稿の送信前同意を同じtx内で確認する。
 * 判定結果・学習数値・投稿回数を変更せず、送信やjob更新も行わない。
 */
import {
  DocumentReference,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import {
  compareTimestamps,
  isJudgementHistoryEntry,
  isTimestampLike,
  type JudgementStream,
} from '../../../shared/judgementHistory';
import {
  JudgementHistoryReadError,
  readJudgementStreamPoint,
  type JudgementStreamPoint,
} from '../dailyJudgement/historyReader';

export type PostingConsentReadResult =
  | { status: 'allowed'; linkRevision: number }
  | {
      status: 'cancelled';
      reason: 'posting_disabled' | 'link_changed' | 'not_authorized_at_cutoff';
    }
  | { status: 'beforeCoverage' }
  | { status: 'noAccount' }
  | { status: 'deleting' };

const STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** 既存history readerと同じ所有userパスの契約をI/O前に検証する。 */
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

/**
 * cutoff直前の点から現在counterまでのsettingsだけをrevision順に読む。
 * OFFを見つけても終端まで検証し、不正履歴を正常中止へ置き換えない。
 */
async function readPostingDisabledSinceCutoff(
  tx: Transaction,
  userRef: DocumentReference,
  point: JudgementStreamPoint<'settings'>,
  currentRevision: number,
  currentEnabled: boolean,
  cutoff: Timestamp,
): Promise<boolean> {
  let revision = point.revision;
  let committedAt = point.committedAt;
  let enabled = point.snapshot.xPostEnabled;
  let disabled = false;

  if (revision < currentRevision) {
    const collection = userRef.collection('judgementHistory')
      .doc('settings').collection('entries');
    const suffix = await tx.get(collection.where('revision', '>', revision)
      .where('revision', '<=', currentRevision).orderBy('revision', 'asc'));
    for (const doc of suffix.docs) {
      const data: unknown = doc.data();
      if (
        !isJudgementHistoryEntry('settings', data)
        || !isSdkTimestamp(data.committedAt)
        || doc.id !== String(data.revision)
        || doc.ref.path !== collection.path + '/' + doc.id
        || data.revision !== revision + 1
        || data.revision > currentRevision
        || compareTimestamps(data.committedAt, cutoff) < 0
        || compareTimestamps(data.committedAt, committedAt) < 0
        || data.before.xPostEnabled !== enabled
      ) {
        throw new JudgementHistoryReadError();
      }
      revision = data.revision;
      committedAt = data.committedAt;
      enabled = data.after.xPostEnabled;
      if (!enabled) disabled = true;
    }
  }
  if (revision !== currentRevision || enabled !== currentEnabled) {
    throw new JudgementHistoryReadError();
  }
  return disabled;
}

/**
 * 世代不変ならcutoffの点が現在値。世代変更時は現在counterのentryも検証し、
 * rootのboolと最新snapshotを照合する。世代差はtrue→trueでも中止対象。
 */
async function readCurrentLink(
  tx: Transaction,
  userRef: DocumentReference,
  point: JudgementStreamPoint<'xLink'>,
  currentRevision: number,
  cutoff: Timestamp,
): Promise<boolean> {
  if (point.revision === currentRevision) return point.snapshot.xLinked;

  const collection = userRef.collection('judgementHistory')
    .doc('xLink').collection('entries');
  const doc = await tx.get(collection.doc(String(currentRevision)));
  const data: unknown = doc.data();
  if (
    !doc.exists
    || !isJudgementHistoryEntry('xLink', data)
    || !isSdkTimestamp(data.committedAt)
    || data.revision !== currentRevision
    || doc.id !== String(data.revision)
    || doc.ref.path !== collection.path + '/' + doc.id
    || compareTimestamps(data.committedAt, cutoff) < 0
    || compareTimestamps(data.committedAt, point.committedAt) < 0
  ) {
    throw new JudgementHistoryReadError();
  }
  return data.after.xLinked;
}

/**
 * 全readを渡されたtxで行う。SDK例外は捕捉せず再試行判定へ伝播する。
 * goal/subscriptionの適格性は上位jobが確定dailyResultで確認済みとする。
 * OFF→ONでも過去のOFFを保持するため、同じcutoffの旧待機は復活しない。
 * 外部送信開始後の取り消しや、永続jobの状態遷移はこのreaderの責務外。
 */
export async function readPostingConsent(
  tx: Transaction,
  userRef: DocumentReference,
  cutoff: Timestamp,
): Promise<PostingConsentReadResult> {
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
  if (typeof data.xPostEnabled !== 'boolean' || typeof data.xLinked !== 'boolean') {
    throw new JudgementHistoryReadError();
  }

  const [settings, xLink] = await Promise.all([
    readJudgementStreamPoint(
      tx, userRef, 'settings', revisions.settings, startedAt, cutoff,
    ),
    readJudgementStreamPoint(
      tx, userRef, 'xLink', revisions.xLink, startedAt, cutoff,
    ),
  ]);
  const [postingDisabled, currentLinked] = await Promise.all([
    readPostingDisabledSinceCutoff(
      tx, userRef, settings, revisions.settings, data.xPostEnabled, cutoff,
    ),
    readCurrentLink(tx, userRef, xLink, revisions.xLink, cutoff),
  ]);
  if (currentLinked !== data.xLinked) throw new JudgementHistoryReadError();

  if (!settings.snapshot.xPostEnabled || !xLink.snapshot.xLinked) {
    return { status: 'cancelled', reason: 'not_authorized_at_cutoff' };
  }
  if (xLink.revision !== revisions.xLink) {
    return { status: 'cancelled', reason: 'link_changed' };
  }
  if (postingDisabled) return { status: 'cancelled', reason: 'posting_disabled' };
  return { status: 'allowed', linkRevision: xLink.revision };
}
