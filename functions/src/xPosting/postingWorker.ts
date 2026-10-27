import { isValidDateKey } from '../../../shared/date';
import type { EnsurePostingJobResult } from './createPostingJob';
import type { PostResult } from './postTransport';
import type { createPostingJobStore } from './postingJobStore';
import type { createPostingTokenProvider } from './postingToken';

const FAILURE = 'X posting worker operation failed';
const JOB_LEASE_MS = 120000;
const MAX_UID_LENGTH = 128;
const MAX_CLAIM_ID_LENGTH = 1500;

type Store = ReturnType<typeof createPostingJobStore>;
type ApplyResult = Awaited<ReturnType<Store['apply']>>;
type Action = Parameters<Store['apply']>[2];
type Feedback = NonNullable<Parameters<Store['apply']>[3]>;
type Completion = Extract<Action, { kind: 'complete' }>['outcome'];

type PostingDateResult = {
  readonly status: 'posted' | 'retry_wait' | 'failed' | 'unknown'
    | 'cancelled' | 'waiting' | 'skipped' | 'unavailable';
};

type PostingWorkerDeps = {
  readonly ensureJob: (uid: string, date: string) => Promise<EnsurePostingJobResult>;
  readonly store: Store;
  readonly tokens: ReturnType<typeof createPostingTokenProvider>;
  readonly post: (
    accessToken: string,
    payload: { readonly text: string; readonly mediaIds: readonly string[] },
  ) => Promise<PostResult>;
  readonly newClaimId: () => string;
};

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireIdentity(uid: string, date: string): void {
  requireValue(
    typeof uid === 'string' && uid.trim().length > 0
      && uid.length <= MAX_UID_LENGTH && !uid.includes('/')
      && uid !== '.' && uid !== '..' && !/^__.*__$/.test(uid)
      && Buffer.from(uid, 'utf8').toString('utf8') === uid,
  );
  requireValue(typeof date === 'string' && isValidDateKey(date));
}

function requireClaimId(value: string): void {
  requireValue(
    typeof value === 'string' && value.length > 0
      && value.length <= MAX_CLAIM_ID_LENGTH
      && !/[^A-Za-z0-9_-]/.test(value) && !/^__.*__$/.test(value),
  );
}

/** Return the committed disposition, including a competing owner's result. */
function disposition(result: ApplyResult): PostingDateResult {
  if (result.status !== 'available') return { status: 'unavailable' };
  switch (result.job.status) {
    case 'posted':
    case 'failed':
    case 'unknown':
    case 'cancelled':
      return { status: result.job.status };
    case 'ready':
      return { status: 'retry_wait' };
    case 'preparing':
    case 'sending':
      return { status: 'waiting' };
  }
}

function receipt(result: PostResult): { outcome: Completion; feedback: Feedback } {
  switch (result.kind) {
    case 'posted':
      return {
        outcome: { kind: 'posted', postId: result.postId },
        feedback: { lastHttpStatus: 201 },
      };
    case 'http_error': {
      const status = result.status;
      if (status === 401 || status === 429) {
        return {
          outcome: { kind: 'retryable' },
          feedback: {
            lastHttpStatus: status,
            failureReason: status === 401 ? 'relink_required' : 'post_failed',
          },
        };
      }
      const permanent = status >= 400 && status < 500 && status !== 408;
      return {
        outcome: { kind: permanent ? 'permanent' : 'unknown' },
        feedback: {
          lastHttpStatus: status,
          failureReason: permanent ? 'post_failed' : 'unknown_post',
        },
      };
    }
    case 'unknown':
      return { outcome: { kind: 'unknown' }, feedback: { failureReason: 'unknown_post' } };
  }
}

/** One invocation may consume one committed HTTP authorization, without retrying. */
export async function processPostingDate(
  uid: string, date: string, deps: PostingWorkerDeps,
): Promise<PostingDateResult> {
  try {
    requireIdentity(uid, date);
    const ensured = await deps.ensureJob(uid, date);
    switch (ensured.status) {
      case 'created':
      case 'existing':
        break;
      case 'no_pending':
      case 'beforeCoverage':
        return { status: 'skipped' };
      case 'noAccount':
      case 'deleting':
        return { status: 'unavailable' };
      case 'cancelled': {
        const result = await deps.store.cancelUncreated(uid, date);
        switch (result.status) {
          case 'cancelled':
            return { status: 'cancelled' };
          case 'unchanged':
            return { status: 'skipped' };
          case 'missing':
          case 'noAccount':
          case 'deleting':
            return { status: 'unavailable' };
          default:
            throw new Error(FAILURE);
        }
      }
      default:
        throw new Error(FAILURE);
    }

    const claimId = deps.newClaimId();
    requireClaimId(claimId);
    const claimed = await deps.store.apply(uid, date, {
      kind: 'claim', claimId, leaseMs: JOB_LEASE_MS,
    });
    if (claimed.status !== 'available' || !claimed.changed
      || claimed.job.status !== 'preparing' || claimed.job.claim.id !== claimId) {
      return disposition(claimed);
    }

    const token = await deps.tokens.acquire(uid, claimed.job.linkRevision, claimed.forceRefresh);
    switch (token.kind) {
      case 'busy':
        return { status: 'waiting' };
      case 'relink_required':
        return disposition(await deps.store.apply(uid, date, {
          kind: 'abort_preparation', claimId,
        }, { failureReason: 'relink_required' }));
      case 'link_changed':
        return disposition(await deps.store.apply(uid, date, {
          kind: 'cancel', reason: 'link_changed',
        }));
      case 'rejected':
        if (token.status === 429 || token.oauthError === 'server_error'
          || token.oauthError === 'temporarily_unavailable') {
          // Preserve the unsent claim; a later invocation handles lease recovery.
          return { status: 'waiting' };
        }
        return disposition(await deps.store.apply(uid, date, {
          kind: 'abort_preparation', claimId,
        }, { failureReason: 'post_failed' }));
      case 'ready':
        if (token.linkRevision !== claimed.job.linkRevision) {
          return disposition(await deps.store.apply(uid, date, {
            kind: 'cancel', reason: 'link_changed',
          }));
        }
        break;
      default:
        throw new Error(FAILURE);
    }

    const begun = await deps.store.apply(uid, date, { kind: 'begin_send', claimId });
    if (begun.status !== 'available' || !begun.changed || !begun.authorizeHttp
      || begun.job.status !== 'sending' || begun.job.claim.id !== claimId) {
      return disposition(begun);
    }

    let result: PostResult;
    try {
      result = await deps.post(token.accessToken, {
        text: begun.job.post.text, mediaIds: [...begun.job.post.mediaIds],
      });
    } catch {
      result = { kind: 'unknown', reason: 'network' };
    }

    const completed = receipt(result);
    return disposition(await deps.store.apply(uid, date, {
      kind: 'complete', claimId, outcome: completed.outcome,
    }, completed.feedback));
  } catch {
    // Keep durable claims/receipts intact after uncertain SDK responses.
    // Never retry HTTP, release a claim, or expose an original error or cause.
    throw new Error(FAILURE);
  }
}
