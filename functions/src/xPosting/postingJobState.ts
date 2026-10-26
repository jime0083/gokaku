/**
 * Pure posting-job transitions. Persist a returned sending job before HTTP.
 * authorizeHttp permits one call only after that persistence succeeds.
 */
import { isValidDateKey } from '../../../shared/date';
import type { MissedStudyPost } from '../../../shared/missedStudyPost';

const FAILURE = 'Invalid posting job input';
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 300_000;
const MIN_EPOCH_MS = -62_135_596_800_000;
const MAX_EPOCH_MS = 253_402_300_799_999;
const MAX_MEDIA_COUNT = 4;
const MAX_CLAIM_ID_LENGTH = 1500;

type PostSnapshot = {
  readonly text: string;
  readonly mediaIds: readonly string[];
  readonly counts: {
    readonly monthlyMissedDays: number;
    readonly totalMissedDays: number;
  };
};

type Common = {
  readonly goalId: string;
  readonly date: string;
  readonly linkRevision: number;
  readonly createdAt: number;
  readonly post: PostSnapshot;
  readonly attempt: number;
};

type Claim = {
  readonly id: string;
  readonly expiresAt: number;
};

type CancelReason =
  | 'posting_disabled'
  | 'link_changed'
  | 'not_authorized_at_cutoff';

export type PostingJob = Common & (
  | {
      readonly status: 'ready';
      readonly nextAt: number;
      readonly lastClaimId: string | null;
    }
  | { readonly status: 'preparing'; readonly claim: Claim }
  | {
      readonly status: 'sending';
      readonly claim: Claim;
      readonly startedAt: number;
    }
  | { readonly status: 'posted'; readonly postId: string }
  | { readonly status: 'cancelled'; readonly reason: CancelReason }
  | { readonly status: 'failed' }
  | { readonly status: 'unknown' }
);

type CreateInput = {
  goalId: string;
  date: string;
  linkRevision: number;
  post: MissedStudyPost;
  now: number;
};

type Outcome =
  | { readonly kind: 'posted'; readonly postId: string }
  | { readonly kind: 'retryable' | 'permanent' | 'unknown' };

type Command =
  | {
      readonly kind: 'claim';
      readonly claimId: string;
      readonly now: number;
      readonly leaseMs: number;
    }
  | { readonly kind: 'begin_send'; readonly claimId: string; readonly now: number }
  | { readonly kind: 'abort_preparation'; readonly claimId: string; readonly now: number }
  | {
      readonly kind: 'complete';
      readonly claimId: string;
      readonly now: number;
      readonly outcome: Outcome;
    }
  | { readonly kind: 'recover'; readonly now: number }
  | { readonly kind: 'cancel'; readonly now: number; readonly reason: CancelReason };

type TransitionResult = {
  readonly job: PostingJob;
  readonly authorizeHttp: boolean;
};

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireRecord(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  requireValue(actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}

function isUtf8(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function requirePositiveInteger(value: unknown): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function requireTime(value: unknown): asserts value is number {
  requireValue(typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_EPOCH_MS
    && value <= MAX_EPOCH_MS);
}

function deadline(now: number, duration: number): number {
  const result = now + duration;
  requireTime(result);
  requireValue(result > now);
  return result;
}

function requireClaimId(value: unknown): asserts value is string {
  requireValue(typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CLAIM_ID_LENGTH
    && !/[^A-Za-z0-9_-]/.test(value)
    && !/^__.*__$/.test(value));
}

function requireNumericId(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value));
}

function requireReason(value: unknown): asserts value is CancelReason {
  requireValue(value === 'posting_disabled'
    || value === 'link_changed'
    || value === 'not_authorized_at_cutoff');
}

function requireIdentity(value: Record<string, unknown>): void {
  requireValue(isUtf8(value.goalId) && value.goalId.trim().length > 0);
  requireValue(typeof value.date === 'string' && isValidDateKey(value.date));
  requirePositiveInteger(value.linkRevision);
}

function requirePost(value: unknown): asserts value is PostSnapshot {
  requireRecord(value);
  requireKeys(value, ['text', 'mediaIds', 'counts']);
  requireValue(isUtf8(value.text) && value.text.length > 0);
  requireValue(Array.isArray(value.mediaIds) && value.mediaIds.length <= MAX_MEDIA_COUNT);
  // Iterate every index, including holes in sparse arrays.
  for (const id of value.mediaIds as unknown[]) requireNumericId(id);
  requireRecord(value.counts);
  requireKeys(value.counts, ['monthlyMissedDays', 'totalMissedDays']);
  requirePositiveInteger(value.counts.monthlyMissedDays);
  requirePositiveInteger(value.counts.totalMissedDays);
}

function requireClaim(value: unknown, createdAt: number): asserts value is Claim {
  requireRecord(value);
  requireKeys(value, ['id', 'expiresAt']);
  requireClaimId(value.id);
  requireTime(value.expiresAt);
  requireValue(value.expiresAt > createdAt);
}

const COMMON_KEYS = [
  'goalId', 'date', 'linkRevision', 'createdAt', 'post', 'attempt', 'status',
] as const;

function requireJob(value: unknown): asserts value is PostingJob {
  requireRecord(value);
  requireIdentity(value);
  requireTime(value.createdAt);
  requirePost(value.post);
  requireValue(typeof value.attempt === 'number'
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 0
    && value.attempt <= MAX_ATTEMPTS);
  const attempt = value.attempt as number;
  switch (value.status) {
    case 'ready':
      requireKeys(value, [...COMMON_KEYS, 'nextAt', 'lastClaimId']);
      requireValue(attempt < MAX_ATTEMPTS);
      requireTime(value.nextAt);
      requireValue(value.nextAt >= value.createdAt);
      if (value.lastClaimId !== null) requireClaimId(value.lastClaimId);
      requireValue(attempt === 0 || value.lastClaimId !== null);
      break;
    case 'preparing':
      requireKeys(value, [...COMMON_KEYS, 'claim']);
      requireValue(attempt < MAX_ATTEMPTS);
      requireClaim(value.claim, value.createdAt);
      break;
    case 'sending':
      requireKeys(value, [...COMMON_KEYS, 'claim', 'startedAt']);
      requireValue(attempt > 0);
      requireClaim(value.claim, value.createdAt);
      requireTime(value.startedAt);
      requireValue(value.startedAt >= value.createdAt && value.startedAt < value.claim.expiresAt);
      break;
    case 'posted':
      requireKeys(value, [...COMMON_KEYS, 'postId']);
      requireValue(attempt > 0);
      requireNumericId(value.postId);
      break;
    case 'cancelled':
      requireKeys(value, [...COMMON_KEYS, 'reason']);
      requireValue(attempt < MAX_ATTEMPTS);
      requireReason(value.reason);
      break;
    case 'failed':
      requireKeys(value, COMMON_KEYS);
      break;
    case 'unknown':
      requireKeys(value, COMMON_KEYS);
      requireValue(attempt > 0);
      break;
    default:
      throw new Error(FAILURE);
  }
}

function requireOutcome(value: unknown): asserts value is Outcome {
  requireRecord(value);
  if (value.kind === 'posted') {
    requireKeys(value, ['kind', 'postId']);
    requireNumericId(value.postId);
  } else {
    requireKeys(value, ['kind']);
    requireValue(value.kind === 'retryable' || value.kind === 'permanent' || value.kind === 'unknown');
  }
}

function requireCommand(value: unknown, job: PostingJob): asserts value is Command {
  requireRecord(value);
  requireTime(value.now);
  requireValue(value.now >= job.createdAt);
  switch (value.kind) {
    case 'claim':
      requireKeys(value, ['kind', 'claimId', 'now', 'leaseMs']);
      requireClaimId(value.claimId);
      requirePositiveInteger(value.leaseMs);
      deadline(value.now, value.leaseMs);
      break;
    case 'begin_send':
    case 'abort_preparation':
      requireKeys(value, ['kind', 'claimId', 'now']);
      requireClaimId(value.claimId);
      break;
    case 'complete':
      requireKeys(value, ['kind', 'claimId', 'now', 'outcome']);
      requireClaimId(value.claimId);
      requireOutcome(value.outcome);
      if (job.status === 'sending') requireValue(value.now >= job.startedAt);
      break;
    case 'recover':
      requireKeys(value, ['kind', 'now']);
      break;
    case 'cancel':
      requireKeys(value, ['kind', 'now', 'reason']);
      requireReason(value.reason);
      break;
    default:
      throw new Error(FAILURE);
  }
}

/** Select only durable common fields; never carry a prior state's transient fields. */
function common(job: PostingJob): Common {
  return {
    goalId: job.goalId,
    date: job.date,
    linkRevision: job.linkRevision,
    createdAt: job.createdAt,
    post: job.post,
    attempt: job.attempt,
  };
}

export function createPostingJob(input: CreateInput): PostingJob {
  try {
    requireRecord(input);
    requireKeys(input, ['goalId', 'date', 'linkRevision', 'post', 'now']);
    requireIdentity(input);
    requireTime(input.now);
    requirePost(input.post);
    return {
      goalId: input.goalId,
      date: input.date,
      linkRevision: input.linkRevision,
      createdAt: input.now,
      post: {
        text: input.post.text,
        mediaIds: [...input.post.mediaIds],
        counts: {
          monthlyMissedDays: input.post.counts.monthlyMissedDays,
          totalMissedDays: input.post.counts.totalMissedDays,
        },
      },
      attempt: 0,
      status: 'ready',
      nextAt: input.now,
      lastClaimId: null,
    };
  } catch {
    throw new Error(FAILURE);
  }
}

export function transitionPostingJob(job: PostingJob, command: Command): TransitionResult {
  try {
    requireJob(job);
    requireCommand(command, job);
    const unchanged: TransitionResult = { job, authorizeHttp: false };
    if (job.status !== 'ready' && job.status !== 'preparing' && job.status !== 'sending') {
      return unchanged;
    }
    switch (command.kind) {
      case 'claim': {
        if (job.status === 'sending') return unchanged;
        if (job.status === 'ready') {
          if (command.now < job.nextAt || command.claimId === job.lastClaimId) return unchanged;
        } else if (command.now < job.claim.expiresAt || command.claimId === job.claim.id) {
          return unchanged;
        }
        return {
          job: {
            ...common(job),
            status: 'preparing',
            claim: {
              id: command.claimId,
              expiresAt: deadline(command.now, command.leaseMs),
            },
          },
          authorizeHttp: false,
        };
      }
      case 'begin_send':
        if (job.status !== 'preparing'
          || command.claimId !== job.claim.id
          || command.now >= job.claim.expiresAt) return unchanged;
        return {
          job: {
            ...common(job),
            status: 'sending',
            attempt: job.attempt + 1,
            claim: { ...job.claim },
            startedAt: command.now,
          },
          authorizeHttp: true,
        };
      case 'abort_preparation':
        if (job.status !== 'preparing'
          || command.claimId !== job.claim.id
          || command.now >= job.claim.expiresAt) return unchanged;
        return { job: { ...common(job), status: 'failed' }, authorizeHttp: false };
      case 'complete': {
        if (job.status !== 'sending' || command.claimId !== job.claim.id) return unchanged;
        const base = common(job);
        switch (command.outcome.kind) {
          case 'posted':
            return {
              job: { ...base, status: 'posted', postId: command.outcome.postId },
              authorizeHttp: false,
            };
          case 'retryable':
            return {
              job: job.attempt < MAX_ATTEMPTS
                ? {
                    ...base,
                    status: 'ready',
                    nextAt: deadline(command.now, RETRY_INTERVAL_MS),
                    lastClaimId: job.claim.id,
                  }
                : { ...base, status: 'failed' },
              authorizeHttp: false,
            };
          case 'permanent':
            return { job: { ...base, status: 'failed' }, authorizeHttp: false };
          case 'unknown':
            return { job: { ...base, status: 'unknown' }, authorizeHttp: false };
        }
        break;
      }
      case 'recover':
        // Unsent expired claims are replaced by claim, without consuming attempts.
        if (job.status !== 'sending' || command.now < job.claim.expiresAt) return unchanged;
        return { job: { ...common(job), status: 'unknown' }, authorizeHttp: false };
      case 'cancel':
        if (job.status === 'sending') return unchanged;
        return {
          job: { ...common(job), status: 'cancelled', reason: command.reason },
          authorizeHttp: false,
        };
    }
    throw new Error(FAILURE);
  } catch {
    // Validation and accessor failures must never expose supplied values or causes.
    throw new Error(FAILURE);
  }
}
