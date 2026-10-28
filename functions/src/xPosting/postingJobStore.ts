import {
  DocumentReference, Timestamp,
  type DocumentSnapshot, type Firestore, type Transaction,
} from 'firebase-admin/firestore';

import type { PostSkipReason, PostStatus } from '../../../shared/dailyJudgement';
import { isValidDateKey, jstStartOfNextDay } from '../../../shared/date';
import {
  AccountWriteBlockedError, getWritableAccount,
} from '../account/accountWriteGuard';
import { JudgementHistoryReadError } from '../dailyJudgement/historyReader';
import { selectXNotice } from '../domain';
import { createPostingNotice } from './postingNotice';
import {
  readPostingConsent, type PostingConsentReadResult,
} from './postingConsentReader';
import { transitionPostingJob, type PostingJob } from './postingJobState';

type CoreCommand = Parameters<typeof transitionPostingJob>[1];
type WithoutNow<T> = T extends unknown ? Omit<T, 'now'> : never;

export type PostingJobAction = WithoutNow<CoreCommand>;

type FailureReason = 'post_failed' | 'unknown_post' | 'relink_required';

export type PostingJobFeedback = {
  readonly lastHttpStatus?: number;
  readonly failureReason?: FailureReason;
};

type Delivery = {
  readonly lastHttpStatus: number | null;
  readonly failureReason: FailureReason | null;
};

type Unavailable = { readonly status: 'missing' | 'noAccount' | 'deleting' };

export type PostingJobApplyResult =
  | {
      readonly status: 'available';
      readonly job: PostingJob;
      readonly changed: boolean;
      readonly authorizeHttp: boolean;
      readonly forceRefresh: boolean;
    }
  | Unavailable;

export type CancelUncreatedPostingJobResult =
  | { readonly status: 'cancelled' | 'unchanged' }
  | Unavailable;

type TargetResult = {
  readonly goalId: string;
  readonly metMin: boolean;
  readonly postStatus: PostStatus;
  readonly postSkipReasons: readonly PostSkipReason[];
};

type ResultUpdate = {
  postStatus: PostStatus;
  postSkipReasons: PostSkipReason[];
};

const MAX_UID_LENGTH = 128;
const MAX_DOCUMENT_ID_BYTES = 1500;
const MAX_CLAIM_ID_LENGTH = 1500;
const MIN_TIMESTAMP_MS = -62135596800000;
const MAX_TIMESTAMP_MS = 253402300799999;
const POST_STATUSES: readonly PostStatus[] = ['none', 'pending', 'posted', 'failed', 'skipped'];
const SKIP_REASONS: readonly PostSkipReason[] = [
  'start_date', 'x_post_disabled', 'x_not_linked', 'x_post_cancelled',
];

function invalid(): Error {
  return new Error('Invalid posting job input');
}

/** Normalize only synchronous local work, never an SDK read or commit. */
function local<T>(body: () => T): T {
  try {
    return body();
  } catch {
    throw invalid();
  }
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw invalid();
}

function has(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Preserve every own key for strict validation; accessor failures stay local. */
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const source = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(source)) {
    requireValue(typeof key === 'string'
      && Object.prototype.propertyIsEnumerable.call(source, key));
    result[key] = source[key];
  }
  return result;
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  requireValue(Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => has(value, key)));
}

function isDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('/')
    && value !== '.' && value !== '..'
    && !/^__.*__$/.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_DOCUMENT_ID_BYTES
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function requireTime(value: unknown): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_TIMESTAMP_MS && value <= MAX_TIMESTAMP_MS);
}

function requireClaimId(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0
    && value.length <= MAX_CLAIM_ID_LENGTH
    && !/[^A-Za-z0-9_-]/.test(value) && !/^__.*__$/.test(value));
}

function isFailureReason(value: unknown): value is FailureReason {
  return value === 'post_failed' || value === 'unknown_post' || value === 'relink_required';
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function decodeAction(input: PostingJobAction): PostingJobAction {
  const action = record(input);
  switch (action.kind) {
    case 'claim':
      requireKeys(action, ['kind', 'claimId', 'leaseMs']);
      requireClaimId(action.claimId);
      requireValue(typeof action.leaseMs === 'number'
        && Number.isSafeInteger(action.leaseMs) && action.leaseMs > 0);
      break;
    case 'begin_send':
    case 'abort_preparation':
      requireKeys(action, ['kind', 'claimId']);
      requireClaimId(action.claimId);
      break;
    case 'complete': {
      requireKeys(action, ['kind', 'claimId', 'outcome']);
      requireClaimId(action.claimId);
      const outcome = record(action.outcome);
      if (outcome.kind === 'posted') {
        requireKeys(outcome, ['kind', 'postId']);
        requireValue(typeof outcome.postId === 'string'
          && outcome.postId.length > 0 && !/[^0-9]/.test(outcome.postId));
      } else {
        requireKeys(outcome, ['kind']);
        requireValue(outcome.kind === 'retryable'
          || outcome.kind === 'permanent' || outcome.kind === 'unknown');
      }
      action.outcome = outcome;
      break;
    }
    case 'recover':
      requireKeys(action, ['kind']);
      break;
    case 'cancel':
      requireKeys(action, ['kind', 'reason']);
      requireValue(action.reason === 'posting_disabled'
        || action.reason === 'link_changed' || action.reason === 'not_authorized_at_cutoff');
      break;
    default:
      throw invalid();
  }
  return action as unknown as PostingJobAction;
}

function decodeFeedback(
  action: PostingJobAction, input: PostingJobFeedback | undefined,
): PostingJobFeedback | undefined {
  if (input === undefined) return undefined;
  requireValue(action.kind === 'complete' || action.kind === 'abort_preparation');
  const feedback = record(input);
  requireValue(Reflect.ownKeys(feedback).every((key) =>
    key === 'lastHttpStatus' || key === 'failureReason'));
  if (has(feedback, 'lastHttpStatus')) requireValue(isHttpStatus(feedback.lastHttpStatus));
  if (has(feedback, 'failureReason')) requireValue(isFailureReason(feedback.failureReason));
  return feedback as PostingJobFeedback;
}

function requireReference(ref: DocumentReference, path: string): void {
  requireValue(ref instanceof DocumentReference && ref.path === path);
}

function snapshotValue(doc: DocumentSnapshot, ref: DocumentReference): Record<string, unknown> {
  requireValue(doc.exists && doc.id === ref.id);
  requireReference(doc.ref, ref.path);
  return record(doc.data());
}

function decodeStoredJob(doc: DocumentSnapshot, ref: DocumentReference): {
  job: PostingJob; delivery: Delivery;
} {
  const raw = snapshotValue(doc, ref);
  let delivery: Delivery;
  if (has(raw, 'delivery')) {
    const metadata = record(raw.delivery);
    requireKeys(metadata, ['lastHttpStatus', 'failureReason']);
    requireValue(metadata.lastHttpStatus === null || isHttpStatus(metadata.lastHttpStatus));
    requireValue(metadata.failureReason === null || isFailureReason(metadata.failureReason));
    delivery = {
      lastHttpStatus: metadata.lastHttpStatus as number | null,
      failureReason: metadata.failureReason as FailureReason | null,
    };
    delete raw.delivery;
  } else {
    requireValue(raw.status === 'ready' && raw.attempt === 0 && raw.lastClaimId === null);
    delivery = { lastHttpStatus: null, failureReason: null };
  }
  requireValue(raw.date === ref.id);
  // The pure transition validates every remaining core field and key.
  return { job: raw as unknown as PostingJob, delivery };
}

function decodeTarget(doc: DocumentSnapshot, ref: DocumentReference): TargetResult {
  const value = snapshotValue(doc, ref);
  requireValue(isDocumentId(value.goalId));
  requireValue(typeof value.studiedMinutes === 'number'
    && Number.isSafeInteger(value.studiedMinutes) && value.studiedMinutes >= 0);
  requireValue(typeof value.metMin === 'boolean' && typeof value.metGoal === 'boolean');
  requireValue(!value.metGoal || value.metMin);
  requireValue(POST_STATUSES.some((status) => status === value.postStatus));
  requireValue(Array.isArray(value.postSkipReasons));
  const reasons: PostSkipReason[] = [];
  for (const reason of value.postSkipReasons as unknown[]) {
    requireValue(SKIP_REASONS.some((allowed) => allowed === reason));
    reasons.push(reason as PostSkipReason);
  }
  requireValue(new Set(reasons).size === reasons.length);
  if (value.postStatus === 'none') {
    requireValue(value.metMin && reasons.length === 0);
  } else {
    requireValue(!value.metMin && !value.metGoal);
    requireValue(value.postStatus === 'skipped' ? reasons.length > 0 : reasons.length === 0);
  }
  return {
    goalId: value.goalId as string,
    metMin: value.metMin as boolean,
    postStatus: value.postStatus as PostStatus,
    postSkipReasons: reasons,
  };
}

function terminalUpdate(job: PostingJob): ResultUpdate | undefined {
  switch (job.status) {
    case 'posted':
      return { postStatus: 'posted', postSkipReasons: [] };
    case 'failed':
    case 'unknown':
      return { postStatus: 'failed', postSkipReasons: [] };
    case 'cancelled':
      return { postStatus: 'skipped', postSkipReasons: ['x_post_cancelled'] };
    default:
      return undefined;
  }
}

function requireConsistency(job: PostingJob, target: TargetResult): void {
  requireValue(target.goalId === job.goalId && !target.metMin);
  const expected = terminalUpdate(job)
    ?? { postStatus: 'pending', postSkipReasons: [] };
  requireValue(target.postStatus === expected.postStatus
    && target.postSkipReasons.length === expected.postSkipReasons.length
    && target.postSkipReasons.every((reason, index) => reason === expected.postSkipReasons[index]));
}

function needsConsent(job: PostingJob, action: PostingJobAction): boolean {
  return (job.status === 'ready' || job.status === 'preparing')
    && (action.kind === 'claim' || action.kind === 'begin_send'
      || action.kind === 'abort_preparation' || action.kind === 'cancel');
}

function updateDelivery(
  job: PostingJob, previous: Delivery, feedback: PostingJobFeedback | undefined,
): Delivery {
  const lastHttpStatus = feedback?.lastHttpStatus ?? previous.lastHttpStatus;
  let failureReason = feedback?.failureReason ?? previous.failureReason;
  if (job.status === 'unknown') failureReason = 'unknown_post';
  else if (job.status === 'posted') failureReason = null;
  else if (job.status === 'failed') failureReason = feedback?.failureReason ?? 'post_failed';
  return { lastHttpStatus, failureReason };
}

async function readAccount(
  tx: Transaction, userRef: DocumentReference,
): Promise<{ readonly status: 'available'; readonly snapshot: DocumentSnapshot } | Unavailable> {
  try {
    const snapshot = await getWritableAccount(tx, userRef);
    return { status: 'available', snapshot };
  } catch (error) {
    if (error instanceof AccountWriteBlockedError) {
      return { status: error.reason === 'missing' ? 'noAccount' : 'deleting' };
    }
    throw error;
  }
}

async function consentFor(
  tx: Transaction, userRef: DocumentReference, cutoff: Timestamp,
): Promise<PostingConsentReadResult> {
  try {
    return await readPostingConsent(tx, userRef, cutoff);
  } catch (error) {
    if (error instanceof JudgementHistoryReadError) throw invalid();
    throw error;
  }
}

/** Internal persistence only; callers may send HTTP only after apply resolves with permission. */
export function createPostingJobStore(deps: { db: Firestore; now: () => number }): {
  apply(
    uid: string, date: string, action: PostingJobAction, feedback?: PostingJobFeedback,
  ): Promise<PostingJobApplyResult>;
  cancelUncreated(uid: string, date: string): Promise<CancelUncreatedPostingJobResult>;
} {
  const { db, now } = deps;

  function references(uid: string, date: string) {
    const cutoffMs = local(() => {
      requireValue(isDocumentId(uid) && uid.length <= MAX_UID_LENGTH);
      requireValue(typeof date === 'string' && isValidDateKey(date));
      const result = jstStartOfNextDay(date);
      requireTime(result);
      return result;
    });
    const userPath = `users/${uid}`;
    const userRef = db.doc(userPath);
    local(() => requireReference(userRef, userPath));
    const resultRef = userRef.collection('dailyResults').doc(date);
    const jobRef = userRef.collection('postJobs').doc(date);
    local(() => {
      requireReference(resultRef, `${userPath}/dailyResults/${date}`);
      requireReference(jobRef, `${userPath}/postJobs/${date}`);
    });
    return { userRef, resultRef, jobRef, cutoffMs, cutoff: Timestamp.fromMillis(cutoffMs) };
  }

  function trustedTime(cutoffMs: number): number {
    return local(() => {
      const sampled = now();
      requireTime(sampled);
      requireValue(sampled >= cutoffMs);
      return sampled;
    });
  }

  async function apply(
    uid: string, date: string, input: PostingJobAction, inputFeedback?: PostingJobFeedback,
  ): Promise<PostingJobApplyResult> {
    const action = local(() => decodeAction(input));
    const feedback = local(() => decodeFeedback(action, inputFeedback));
    const { userRef, resultRef, jobRef, cutoffMs, cutoff } = references(uid, date);

    return db.runTransaction<PostingJobApplyResult>(async (tx) => {
      const account = await readAccount(tx, userRef);
      if (account.status !== 'available') return account;
      const storedJob = await tx.get(jobRef);
      if (!storedJob.exists) return { status: 'missing' };
      const storedResult = await tx.get(resultRef);
      if (!storedResult.exists) return { status: 'missing' };
      const decoded = local(() => ({
        ...decodeStoredJob(storedJob, jobRef),
        target: decodeTarget(storedResult, resultRef),
      }));
      const consent = needsConsent(decoded.job, action)
        ? await consentFor(tx, userRef, cutoff) : undefined;

      // Every callback attempt completes all reads before sampling its own time.
      const sampled = trustedTime(cutoffMs);
      const computed = local(() => {
        const current = decoded.job;
        const command = { ...action, now: sampled } as CoreCommand;
        // Only claim/recover resolve an expired send before any possible reclaim.
        // An owned completion can still settle a sending job after its lease.
        const base = action.kind === 'claim'
          ? transitionPostingJob(current, { kind: 'recover', now: sampled }).job : current;
        let next = transitionPostingJob(base, command);
        requireConsistency(current, decoded.target);
        if (consent?.status === 'beforeCoverage') throw invalid();
        if (consent?.status === 'allowed') {
          requireValue(consent.linkRevision === current.linkRevision);
        } else if (consent?.status === 'cancelled') {
          // Validate the requested command first, but cancel the original unsent state.
          next = transitionPostingJob(current, {
            kind: 'cancel', now: sampled, reason: consent.reason,
          });
        }
        const changed = next.job !== current;
        const delivery = changed
          ? updateDelivery(next.job, decoded.delivery, feedback) : decoded.delivery;
        return {
          job: next.job, changed, delivery,
          authorizeHttp: changed && next.authorizeHttp,
          resultUpdate: changed ? terminalUpdate(next.job) : undefined,
        };
      });
      if (consent?.status === 'noAccount' || consent?.status === 'deleting') {
        return { status: consent.status };
      }
      // A terminal replay never creates a notice. The existing parent snapshot
      // participates in the same transaction as the new job/result disposition.
      const noticeSelection = computed.changed
        && (computed.job.status === 'failed' || computed.job.status === 'unknown')
        ? local(() => {
          requireValue(computed.delivery.failureReason !== null);
          return selectXNotice(account.snapshot.get('xNotice'), createPostingNotice({
            date: computed.job.date,
            goalId: computed.job.goalId,
            linkRevision: computed.job.linkRevision,
            kind: computed.delivery.failureReason,
          }));
        }) : undefined;
      if (computed.changed) {
        // storedJob.exists and the parent guard were read in this same transaction.
        // Replacing this owned document removes obsolete state-specific core fields.
        tx.set(jobRef, { ...computed.job, delivery: computed.delivery });
        if (computed.resultUpdate !== undefined) tx.update(resultRef, computed.resultUpdate);
        if (noticeSelection?.changed) tx.update(userRef, { xNotice: noticeSelection.notice });
      }
      return {
        status: 'available', job: computed.job, changed: computed.changed,
        authorizeHttp: computed.authorizeHttp,
        forceRefresh: computed.delivery.lastHttpStatus === 401,
      };
    });
  }

  async function cancelUncreated(
    uid: string, date: string,
  ): Promise<CancelUncreatedPostingJobResult> {
    const { userRef, resultRef, jobRef, cutoffMs, cutoff } = references(uid, date);
    return db.runTransaction<CancelUncreatedPostingJobResult>(async (tx) => {
      const account = await readAccount(tx, userRef);
      if (account.status !== 'available') return account;
      const storedJob = await tx.get(jobRef);
      local(() => requireValue(!storedJob.exists));
      const storedResult = await tx.get(resultRef);
      if (!storedResult.exists) return { status: 'missing' };
      const target = local(() => decodeTarget(storedResult, resultRef));
      const consent = target.postStatus === 'pending'
        ? await consentFor(tx, userRef, cutoff) : undefined;

      trustedTime(cutoffMs);
      if (consent?.status === 'noAccount' || consent?.status === 'deleting') {
        return { status: consent.status };
      }
      if (consent?.status !== 'cancelled') return { status: 'unchanged' };
      const update: ResultUpdate = {
        postStatus: 'skipped', postSkipReasons: ['x_post_cancelled'],
      };
      tx.update(resultRef, update);
      return { status: 'cancelled' };
    });
  }

  return { apply, cancelUncreated };
}
