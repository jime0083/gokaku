import {
  DocumentReference,
  FieldPath,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';

import { isValidDateKey, jstStartOfNextDay } from '../../../shared/date';
import {
  buildMissedStudyPost,
  type MissedStudyDailyResult,
} from '../../../shared/missedStudyPost';
import {
  AccountWriteBlockedError,
  getWritableAccount,
} from '../account/accountWriteGuard';
import {
  readPostingConsent,
  type PostingConsentReadResult,
} from './postingConsentReader';
import { createPostingJob as createInitialPostingJob } from './postingJobState';

export type EnsurePostingJobResult =
  | {
      status: 'created' | 'existing' | 'no_pending'
        | 'noAccount' | 'deleting' | 'beforeCoverage';
    }
  | Extract<PostingConsentReadResult, { status: 'cancelled' }>;

const MAX_UID_LENGTH = 128;
const MAX_DOCUMENT_ID_BYTES = 1500;
const MIN_TIMESTAMP_MS = -62135596800000;
const MAX_TIMESTAMP_MS = 253402300799999;
const POST_STATUSES = ['none', 'pending', 'posted', 'failed', 'skipped'] as const;
const SKIP_REASONS = ['start_date', 'x_post_disabled', 'x_not_linked'] as const;

function invalid(): Error {
  return new Error('Invalid posting job input');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('/')
    && value !== '.'
    && value !== '..'
    && !/^__.*__$/.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_DOCUMENT_ID_BYTES
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function requireDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidDateKey(value)) throw invalid();
}

function requireTime(value: unknown): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < MIN_TIMESTAMP_MS
    || value > MAX_TIMESTAMP_MS
  ) {
    throw invalid();
  }
}

function requireReference(
  ref: DocumentReference,
  expectedPath: string,
): void {
  if (!(ref instanceof DocumentReference) || ref.path !== expectedPath) {
    throw invalid();
  }
}

/** Historical counts only depend on the canonical date, goalId and metMin. */
function decodeCountResult(
  doc: DocumentSnapshot,
  collectionPath: string,
): MissedStudyDailyResult {
  requireDate(doc.id);
  requireReference(doc.ref, `${collectionPath}/${doc.id}`);
  const value: unknown = doc.data();
  if (
    !isRecord(value)
    || !isDocumentId(value.goalId)
    || typeof value.metMin !== 'boolean'
  ) {
    throw invalid();
  }
  return { date: doc.id, goalId: value.goalId, metMin: value.metMin };
}

/** A malformed stored result must not become a successful no_pending outcome. */
function decodeTarget(
  doc: DocumentSnapshot,
  collectionPath: string,
): { result: MissedStudyDailyResult; pending: boolean } {
  const result = decodeCountResult(doc, collectionPath);
  const value: unknown = doc.data();
  if (
    !isRecord(value)
    || typeof value.studiedMinutes !== 'number'
    || !Number.isSafeInteger(value.studiedMinutes)
    || value.studiedMinutes < 0
    || typeof value.metGoal !== 'boolean'
    || (value.metGoal && !result.metMin)
    || typeof value.postStatus !== 'string'
    || !POST_STATUSES.some((status) => status === value.postStatus)
    || !Array.isArray(value.postSkipReasons)
  ) {
    throw invalid();
  }

  const reasons: unknown[] = value.postSkipReasons;
  for (const reason of reasons) {
    if (!SKIP_REASONS.some((allowed) => allowed === reason)) throw invalid();
  }
  if (new Set(reasons).size !== reasons.length) throw invalid();

  if (value.postStatus === 'none') {
    if (!result.metMin || reasons.length !== 0) throw invalid();
  } else {
    if (result.metMin || value.metGoal) throw invalid();
    if (value.postStatus === 'skipped') {
      if (reasons.length === 0) throw invalid();
    } else if (reasons.length !== 0) {
      throw invalid();
    }
  }

  return { result, pending: value.postStatus === 'pending' };
}

/**
 * Internal first-job creation only. No sending, cancellation persistence or app setup.
 * The parent guard, pending result, consent and both count queries share one Admin
 * transaction. Its callback may replay, but its trusted clock value never advances.
 */
export async function ensurePostingJob(
  uid: string,
  date: string,
  deps: { db: Firestore; now: () => number },
): Promise<EnsurePostingJobResult> {
  if (!isDocumentId(uid) || uid.length > MAX_UID_LENGTH) throw invalid();
  requireDate(date);

  const cutoffMs = jstStartOfNextDay(date);
  requireTime(cutoffMs);
  const now = deps.now();
  requireTime(now);
  if (now < cutoffMs) throw invalid();
  const cutoff = Timestamp.fromMillis(cutoffMs);

  const { db } = deps;
  const userPath = `users/${uid}`;
  const userRef = db.doc(userPath);
  requireReference(userRef, userPath);
  const dailyResults = userRef.collection('dailyResults');
  const resultRef = dailyResults.doc(date);
  const jobRef = userRef.collection('postJobs').doc(date);
  requireReference(resultRef, `${userPath}/dailyResults/${date}`);
  requireReference(jobRef, `${userPath}/postJobs/${date}`);
  const monthStart = `${date.slice(0, 7)}-01`;

  return db.runTransaction<EnsurePostingJobResult>(async (tx) => {
    try {
      await getWritableAccount(tx, userRef);
    } catch (error) {
      if (error instanceof AccountWriteBlockedError) {
        if (error.reason === 'missing') return { status: 'noAccount' };
        if (error.reason === 'deleting') return { status: 'deleting' };
      }
      throw error;
    }

    const existing = await tx.get(jobRef);
    // Existing payload validation belongs to the later state store, not creation.
    if (existing.exists) return { status: 'existing' };

    const storedResult = await tx.get(resultRef);
    if (!storedResult.exists) return { status: 'no_pending' };
    const target = decodeTarget(storedResult, dailyResults.path);
    if (!target.pending) return { status: 'no_pending' };

    const consent = await readPostingConsent(tx, userRef, cutoff);
    if (consent.status !== 'allowed') return consent;

    // Built-in single-field/name indexes suffice; no goalId/date composite query.
    const [goalResults, monthlyResults] = await Promise.all([
      tx.get(dailyResults.where('goalId', '==', target.result.goalId)),
      tx.get(dailyResults
        .where(FieldPath.documentId(), '>=', monthStart)
        .where(FieldPath.documentId(), '<=', date)),
    ]);

    const countResults: MissedStudyDailyResult[] = [target.result];
    for (const doc of goalResults.docs) {
      const result = decodeCountResult(doc, dailyResults.path);
      if (result.goalId !== target.result.goalId) throw invalid();
      countResults.push(result);
    }
    for (const doc of monthlyResults.docs) {
      const result = decodeCountResult(doc, dailyResults.path);
      if (result.date < monthStart || result.date > date) throw invalid();
      countResults.push(result);
    }

    // Only synchronous local computation is normalized here. SDK I/O exceptions
    // remain untouched so callers retain their transaction/retry classification.
    const initialJob = (() => {
      try {
        const post = buildMissedStudyPost({
          goalId: target.result.goalId, date, dailyResults: countResults,
        });
        return createInitialPostingJob({
          goalId: target.result.goalId,
          date,
          linkRevision: consent.linkRevision,
          post,
          now,
        });
      } catch {
        throw invalid();
      }
    })();

    tx.create(jobRef, initialJob);
    return { status: 'created' };
  });
}
