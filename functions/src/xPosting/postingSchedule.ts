import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { info } from 'firebase-functions/logger';
import { onSchedule, type ScheduleOptions } from 'firebase-functions/v2/scheduler';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { runXRequest } from '../xUsage';
import { createActiveTokenStore } from '../xAuth/activeTokenStore';
import {
  X_OAUTH_CLIENT_ID,
  X_OAUTH_CLIENT_SECRET,
  X_TOKEN_ENCRYPTION_KEY,
} from '../xAuth/config';
import type { TokenFetch } from '../xAuth/tokenTransport';
import { ensurePostingJob } from './createPostingJob';
import { requestPost, type PostFetch } from './postTransport';
import { createPostingJobStore } from './postingJobStore';
import { createPostingTokenProvider } from './postingToken';
import { processPostingDate } from './postingWorker';
import { PendingPostingsError, runPendingPostings, type PendingPostingsSummary } from './runPendingPostings';

const POSTING_SCHEDULE_OPTIONS: ScheduleOptions = {
  schedule: '* * * * *',
  timeZone: 'Asia/Tokyo',
  region: FUNCTIONS_REGION,
  timeoutSeconds: 1800,
  maxInstances: 1,
  concurrency: 1,
  retryCount: 0,
  secrets: [X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, X_TOKEN_ENCRYPTION_KEY],
};

/** 固定項目の非負safe integerだけを記録し、観測の失敗は本処理に伝播させない。 */
function logPostingSummary(value: unknown, isFailure = false): void {
  try {
    const summary = isFailure
      ? value instanceof PendingPostingsError ? value.summary : undefined
      : value;
    if (typeof summary !== 'object' || summary === null) return;
    const { processed, errors, outcomes } = summary as PendingPostingsSummary;
    if (typeof outcomes !== 'object' || outcomes === null) return;
    const projected = {
      processed,
      errors,
      outcomes: {
        posted: outcomes.posted,
        retry_wait: outcomes.retry_wait,
        failed: outcomes.failed,
        unknown: outcomes.unknown,
        cancelled: outcomes.cancelled,
        waiting: outcomes.waiting,
        skipped: outcomes.skipped,
        unavailable: outcomes.unavailable,
      },
    };
    if (![processed, errors, ...Object.values(projected.outcomes)].every(
      (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    )) return;
    info({ event: 'x_posting_summary', ...projected });
  } catch {
    // logger・不正な集計値の参照に失敗しても、投稿結果と再試行の扱いは維持する。
  }
}

export const scheduledStudyPosting = onSchedule(
  POSTING_SCHEDULE_OPTIONS,
  async (): Promise<void> => {
    try {
      ensureAdminApp();
      const db = getFirestore();
      const clientId = X_OAUTH_CLIENT_ID.value();
      const clientSecret = X_OAUTH_CLIENT_SECRET.value();
      const encryptionKey = X_TOKEN_ENCRYPTION_KEY.value();
      const now = () => Date.now();
      const tokenFetch: TokenFetch = (url, init) => runXRequest(
        'token_refresh', () => globalThis.fetch(url, init),
      );
      const postFetch: PostFetch = (url, init) => runXRequest(
        'post_create', () => globalThis.fetch(url, init),
      );

      const active = createActiveTokenStore({ firestore: db, now, encryptionKey });
      const store = createPostingJobStore({ db, now });
      const tokens = createPostingTokenProvider({
        store: active,
        fetch: tokenFetch,
        credentials: { clientId, clientSecret },
        encryptionKey,
        now,
        newClaimId: randomUUID,
      });

      const summary = await runPendingPostings({
        db,
        processPostingDate: (uid, date) => processPostingDate(uid, date, {
          ensureJob: (targetUid, targetDate) => ensurePostingJob(targetUid, targetDate, {
            db, now,
          }),
          store,
          tokens,
          post: (accessToken, payload) => requestPost(postFetch, accessToken, payload),
          newClaimId: randomUUID,
        }),
      });
      logPostingSummary(summary);
    } catch (failure) {
      logPostingSummary(failure, true);
      throw new Error('X posting scheduled processing failed');
    }
  },
);
