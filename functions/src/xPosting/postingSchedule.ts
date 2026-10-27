import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule, type ScheduleOptions } from 'firebase-functions/v2/scheduler';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
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
import { runPendingPostings } from './runPendingPostings';

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
      const tokenFetch: TokenFetch = (url, init) => globalThis.fetch(url, init);
      const postFetch: PostFetch = (url, init) => globalThis.fetch(url, init);

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

      await runPendingPostings({
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
    } catch {
      throw new Error('X posting scheduled processing failed');
    }
  },
);
