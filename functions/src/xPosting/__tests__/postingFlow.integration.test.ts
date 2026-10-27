import { randomBytes, randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp, type DocumentReference,
} from 'firebase-admin/firestore';

import { jstStartOfDay, jstStartOfNextDay } from '../../../../shared/date';
import type { JudgementSnapshots } from '../../../../shared/judgementHistory';
import { MONTHLY_PRODUCT_ID } from '../../domain';
import { createActiveTokenStore } from '../../xAuth/activeTokenStore';
import { decrypt, encrypt } from '../../xAuth/crypto';
import { TOKEN_RESPONSE_MAX_BYTES, type TokenFetch } from '../../xAuth/tokenTransport';
import { ensurePostingJob } from '../createPostingJob';
import {
  POST_RESPONSE_MAX_BYTES, requestPost, type PostFetch,
} from '../postTransport';
import { createPostingJobStore } from '../postingJobStore';
import { createPostingTokenProvider } from '../postingToken';
import { processPostingDate } from '../postingWorker';

/**
 * formal7-3b: real Firestore -> job -> active credentials -> worker -> transports.
 * Artifact only: not applied, typechecked, linted or executed by its author.
 * Main runs the Emulator tests and independent review/security before completion.
 * No batch/Scheduler, OAuth linking, Apple verification or 7-3c notice UI here.
 * HTTP alone is mocked, except the explicitly documented receipt-loss hook.
 * No global fetch, SDK timer mocking, sleeps, shared fixtures or database flush.
 */
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const hostMatch = /^(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(host);
if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || hostMatch === null || Number(hostMatch[1]) > 65535) {
  throw new Error('postingFlow requires local demo-gokaku Firestore Emulator');
}
const app = initializeApp({ projectId: 'demo-gokaku' }, `posting-flow-${randomUUID()}`);
// No collection-group batch scan: a fresh owned UID isolates every default-DB case.
const db = getFirestore(app);
const DATE = '2026-10-25';
const CUTOFF = jstStartOfNextDay(DATE);
const RETRY_MS = 300_000;
const LEASE_MS = 120_000;
const SCOPE = 'tweet.read tweet.write users.read offline.access';
const POST_ID = '1234567890123456789';
const TEXT = [
  '本日の最低目標学習時間を達成できませんでした',
  'また明日から頑張ります',
  '勉強時間をフォロワーがチェックし勉強をサボれなくするアプリ',
  '#合格ウォッチ', '#今月2回目', '#累計2回目',
].join('\n');
const FIXED_POST = {
  text: TEXT, mediaIds: [],
  counts: { monthlyMissedDays: 2, totalMissedDays: 2 },
};
type Store = ReturnType<typeof createPostingJobStore>;
type ReceiptLoss = 'before_commit' | 'after_commit';

function response(status: number, value: unknown): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, 'utf8')
    > Math.min(POST_RESPONSE_MAX_BYTES, TOKEN_RESPONSE_MAX_BYTES)) {
    throw new Error('Oversized test response');
  }
  return new Response(body, {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function entries(ref: DocumentReference, stream: keyof JudgementSnapshots) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}

function studyFields(value: Record<string, unknown>) {
  const copy = { ...value };
  delete copy.postStatus;
  delete copy.postSkipReasons;
  return copy;
}

async function fixture(
  body: (f: ReturnType<typeof setup>) => Promise<void>,
  expired = false,
): Promise<void> {
  const f = setup(expired);
  try {
    await f.seed();
    await body(f);
    await f.assertPreserved();
    await f.assertNoPlaintext();
  } finally {
    // Both cleanups run even if seeding, assertions or either cleanup fails.
    const results = await Promise.allSettled([
      db.recursiveDelete(f.user), f.token.delete(),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Owned postingFlow fixture cleanup failed');
    }
  }
}

function setup(expired: boolean) {
  const uid = `posting-flow-${randomUUID()}`;
  const user = db.doc(`users/${uid}`);
  const token = db.doc(`xTokens/${uid}`);
  const goalId = `goal-${randomUUID()}`;
  const key = randomBytes(32).toString('base64');
  const access = randomBytes(32).toString('base64url');
  const refresh = randomBytes(32).toString('base64url');
  const nextAccess = randomBytes(32).toString('base64url');
  const nextRefresh = randomBytes(32).toString('base64url');
  const credentials = { clientId: randomUUID(), clientSecret: randomUUID() };
  const candidateId = randomUUID();
  let time = CUTOFF;
  const now = () => time;
  const startedAt = Timestamp.fromMillis(jstStartOfDay('2026-10-20'));
  const goal = {
    goalId, startDate: '2026-10-20', examDate: '2026-12-01',
    minDailyMinutes: 60, goalDailyMinutes: 120,
  };
  const subscription = {
    status: 'active', productId: MONTHLY_PRODUCT_ID,
    expiresAt: CUTOFF + 30 * 86_400_000,
    originalTransactionId: `fixture-${randomUUID()}`, environment: 'SANDBOX',
  };
  let expectedRoot = {
    activeGoalId: goalId, xLinked: true, xPostEnabled: true,
    xUsername: 'fixture_user', checkEnabled: true, deletionInProgress: false,
    subscription, judgementHistoryStartedAt: startedAt,
    judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    unrelated: { nested: ['keep'], number: 17 },
  };
  const initialResult = {
    goalId, studiedMinutes: 12, minDailyMinutes: 60, goalDailyMinutes: 120,
    metMin: false, metGoal: false, postStatus: 'pending', postSkipReasons: [],
    unrelated: { keep: true },
  };
  const priorResult = { ...initialResult, postStatus: 'posted' };
  const result = (date = DATE) => user.collection('dailyResults').doc(date);
  const job = (date = DATE) => user.collection('postJobs').doc(date);
  const tokenData = (id: string, expiry: number) => ({
    encryptedAccessToken: encrypt(access, key, { uid, purpose: 'accessToken' }),
    encryptedRefreshToken: encrypt(refresh, key, { uid, purpose: 'refreshToken' }),
    expiresAt: Timestamp.fromMillis(expiry), scope: SCOPE, xUserId: '100000001',
    confirmedLink: { candidateId: id, postEnabled: true },
  });
  const replies: (number | 'network')[] = [];
  const postTimes: number[] = [];
  const postFetch = jest.fn<ReturnType<PostFetch>, Parameters<PostFetch>>(
    async (url, init) => {
      expect(url).toBe('https://api.x.com/2/tweets');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      postTimes.push(time);
      const reply = replies.shift() ?? 201;
      if (reply === 'network') throw new Error(`private-network-${access}`);
      return response(reply, reply === 201 ? { data: { id: POST_ID } } : {});
    },
  );
  const tokenFetch = jest.fn<ReturnType<TokenFetch>, Parameters<TokenFetch>>(
    async (url, init) => {
      expect(url).toBe('https://api.x.com/2/oauth2/token');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.body.get('grant_type')).toBe('refresh_token');
      // Boolean comparisons keep synthetic plaintext out of assertion diffs.
      expect(init.body.get('refresh_token') === refresh).toBe(true);
      return response(200, {
        access_token: nextAccess, refresh_token: nextRefresh,
        token_type: 'bearer', expires_in: 3600, scope: SCOPE,
      });
    },
  );
  const store = createPostingJobStore({ db, now });
  const active = createActiveTokenStore({ firestore: db, now, encryptionKey: key });
  const tokens = createPostingTokenProvider({
    store: active, fetch: tokenFetch, credentials, encryptionKey: key, now,
    // Distinct UUID generators for token ownership and job ownership.
    newClaimId: () => randomUUID(),
  });
  const deps = {
    ensureJob: (owner: string, date: string) => ensurePostingJob(owner, date, { db, now }),
    store, tokens, newClaimId: () => randomUUID(),
    post: (bearer: string, payload: { text: string; mediaIds: readonly string[] }) =>
      requestPost(postFetch, bearer, payload),
  };

  return {
    user, token, access, nextAccess, replies, postFetch, tokenFetch, postTimes,
    result, job, store,
    advance: (milliseconds: number) => { time += milliseconds; },
    run: (date = DATE, source: Store = store) =>
      processPostingDate(uid, date, { ...deps, store: source }),
    seed: async () => {
      const batch = db.batch();
      batch.create(user, expectedRoot);
      batch.create(user.collection('goals').doc(goalId), goal);
      const snapshots: JudgementSnapshots = {
        goal, settings: { xPostEnabled: true }, xLink: { xLinked: true },
        subscription: { expiresAt: subscription.expiresAt },
      };
      for (const stream of ['goal', 'settings', 'xLink', 'subscription'] as const) {
        batch.create(entries(user, stream).doc('1'), {
          schemaVersion: 1, revision: 1, committedAt: startedAt,
          before: snapshots[stream], after: snapshots[stream],
        });
      }
      // Confirmed judgement inputs, not a re-test of daily calculation or Apple.
      batch.create(result(), initialResult);
      batch.create(result('2026-10-24'), priorResult);
      batch.create(token, {
        ...tokenData(candidateId, expired ? CUTOFF - 1 : CUTOFF + 3_600_000),
        unrelated: { preserved: true }, oauthStates: {},
      });
      await batch.commit();
    },
    seedNextDate: async () => {
      await result('2026-10-26').create(initialResult);
    },
    changeConsent: async (kind: 'off_on' | 'relink') => {
      // Owned atomic Admin mutation mirrors the verified history writer and
      // candidate confirmation shape. No OAuth/candidate staging is exercised.
      time += 1;
      const batch = db.batch();
      const entry = (
        stream: 'settings' | 'xLink', revision: number,
        before: Record<string, boolean>, after: Record<string, boolean>,
      ) => batch.create(entries(user, stream).doc(String(revision)), {
        schemaVersion: 1, revision, committedAt: Timestamp.fromMillis(time), before, after,
      });
      if (kind === 'off_on') {
        entry('settings', 2, { xPostEnabled: true }, { xPostEnabled: false });
        entry('settings', 3, { xPostEnabled: false }, { xPostEnabled: true });
        batch.update(user, { xPostEnabled: true, 'judgementRevisions.settings': 3 });
        expectedRoot = {
          ...expectedRoot,
          judgementRevisions: { ...expectedRoot.judgementRevisions, settings: 3 },
        };
      } else {
        // Confirming a new candidate also records settings true -> true.
        entry('settings', 2, { xPostEnabled: true }, { xPostEnabled: true });
        entry('xLink', 2, { xLinked: true }, { xLinked: true });
        batch.update(user, {
          xPostEnabled: true, xLinked: true, xUsername: 'relinked_fixture',
          'judgementRevisions.settings': 2, 'judgementRevisions.xLink': 2,
        });
        batch.update(token, tokenData(randomUUID(), time + 3_600_000));
        expectedRoot = {
          ...expectedRoot, xUsername: 'relinked_fixture',
          judgementRevisions: { ...expectedRoot.judgementRevisions, settings: 2, xLink: 2 },
        };
      }
      await batch.commit();
    },
    assertPreserved: async () => {
      expect((await user.get()).data()).toEqual(expectedRoot);
      expect((await user.collection('goals').doc(goalId).get()).data()).toEqual(goal);
      expect((await result('2026-10-24').get()).data()).toEqual(priorResult);
      const rows = await user.collection('dailyResults').get();
      for (const row of rows.docs) {
        expect(studyFields(row.data())).toEqual(studyFields(initialResult));
      }
      expect((await token.get()).get('unrelated')).toEqual({ preserved: true });
      for (const stream of ['goal', 'settings', 'xLink', 'subscription'] as const) {
        const baseline = await entries(user, stream).doc('1').get();
        expect(baseline.get('committedAt')).toEqual(startedAt);
        expect(baseline.get('before')).toEqual(baseline.get('after'));
      }
    },
    assertNoPlaintext: async () => {
      const rows = await user.collection('postJobs').get();
      const results = await user.collection('dailyResults').get();
      const encoded = JSON.stringify([
        (await user.get()).data(), (await token.get()).data(),
        ...rows.docs.map((row) => row.data()), ...results.docs.map((row) => row.data()),
      ]);
      for (const secret of [access, refresh, nextAccess, nextRefresh, key, credentials.clientSecret]) {
        expect(encoded.includes(secret)).toBe(false);
      }
    },
    assertRefreshed: async () => {
      const data = (await token.get()).data()!;
      expect(decrypt(data.encryptedAccessToken, key, { uid, purpose: 'accessToken' })
        === nextAccess).toBe(true);
      expect(decrypt(data.encryptedRefreshToken, key, { uid, purpose: 'refreshToken' })
        === nextRefresh).toBe(true);
      expect(data.expiresAt).toEqual(Timestamp.fromMillis(time + 3_600_000));
      expect(data.refreshControl.state).toBe('saved');
      expect(data.confirmedLink).toEqual({ candidateId, postEnabled: true });
      expect(data.scope).toBe(SCOPE);
    },
  };
}

/**
 * Only the complete operation loses its response. All other methods delegate to
 * the real store. before_commit never applies complete; after_commit awaits its
 * real Firestore commit then loses that response. No SDK code14/backoff injection.
 */
function loseReceipt(real: Store, phase: ReceiptLoss): Store {
  let armed = true;
  return {
    cancelUncreated: (...args) => real.cancelUncreated(...args),
    apply: async (...args) => {
      if (armed && args[2].kind === 'complete') {
        armed = false;
        if (phase === 'after_commit') await real.apply(...args);
        throw new Error('synthetic-private-receipt-response');
      }
      return real.apply(...args);
    },
  };
}

afterAll(async () => {
  try {
    await db.terminate();
  } finally {
    await deleteApp(app);
  }
});

describe('formal7-3b real posting pipeline', () => {
  test('stores posted receipt and fixed N2/M2 once; replay never sends', async () => {
    await fixture(async (f) => {
      expect(await f.run()).toEqual({ status: 'posted' });
      expect((await f.job().get()).data()).toMatchObject({
        status: 'posted', postId: POST_ID, attempt: 1, post: FIXED_POST,
      });
      expect((await f.result().get()).get('postStatus')).toBe('posted');
      expect(f.postFetch.mock.calls[0][1].body).toBe(JSON.stringify({ text: TEXT }));
      expect(f.postFetch.mock.calls[0][1].headers.Authorization === `Bearer ${f.access}`).toBe(true);
      const receipt = await f.job().get();
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: 'posted' });
      expect((await f.job().get()).updateTime).toEqual(receipt.updateTime);
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
    });
  });

  test('401 waits exactly five minutes, refreshes once, and retries identical payload', async () => {
    await fixture(async (f) => {
      f.replies.push(401, 201);
      expect(await f.run()).toEqual({ status: 'retry_wait' });
      expect((await f.job().get()).data()).toMatchObject({
        status: 'ready', attempt: 1, nextAt: CUTOFF + RETRY_MS, post: FIXED_POST,
        delivery: { lastHttpStatus: 401, failureReason: 'relink_required' },
      });
      const before = await f.token.get();
      f.advance(RETRY_MS - 1);
      expect(await f.run()).toEqual({ status: 'retry_wait' });
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
      expect((await f.token.get()).updateTime).toEqual(before.updateTime);
      f.advance(1);
      expect(await f.run()).toEqual({ status: 'posted' });
      expect(f.tokenFetch).toHaveBeenCalledTimes(1);
      expect(f.postFetch).toHaveBeenCalledTimes(2);
      expect(f.postTimes).toEqual([CUTOFF, CUTOFF + RETRY_MS]);
      expect(f.postFetch.mock.calls.map((call) => call[1].body))
        .toEqual([JSON.stringify({ text: TEXT }), JSON.stringify({ text: TEXT })]);
      expect(f.postFetch.mock.calls[1][1].headers.Authorization === `Bearer ${f.nextAccess}`).toBe(true);
      const after = await f.token.get();
      expect(after.get('encryptedAccessToken') === before.get('encryptedAccessToken')).toBe(false);
      expect(after.get('encryptedRefreshToken') === before.get('encryptedRefreshToken')).toBe(false);
      await f.assertRefreshed();
      expect((await f.job().get()).data()).toMatchObject({ status: 'posted', attempt: 2, post: FIXED_POST });
      expect((await f.result().get()).get('postStatus')).toBe('posted');
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: 'posted' });
      expect(f.postFetch).toHaveBeenCalledTimes(2);
      expect(f.tokenFetch).toHaveBeenCalledTimes(1);
    });
  });

  test('three 429 responses consume exactly three attempts five minutes apart', async () => {
    await fixture(async (f) => {
      f.replies.push(429, 429, 429);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(await f.run()).toEqual({ status: attempt === 3 ? 'failed' : 'retry_wait' });
        expect((await f.job().get()).data()).toMatchObject({ attempt, post: FIXED_POST });
        if (attempt < 3) {
          expect((await f.job().get()).get('nextAt')).toBe(CUTOFF + attempt * RETRY_MS);
          f.advance(RETRY_MS - 1);
          expect(await f.run()).toEqual({ status: 'retry_wait' });
          expect(f.postFetch).toHaveBeenCalledTimes(attempt);
          f.advance(1);
        }
      }
      expect(f.postTimes).toEqual([CUTOFF, CUTOFF + RETRY_MS, CUTOFF + 2 * RETRY_MS]);
      expect((await f.result().get()).get('postStatus')).toBe('failed');
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: 'failed' });
      expect(f.postFetch).toHaveBeenCalledTimes(3);
      expect(f.tokenFetch).not.toHaveBeenCalled();
      expect(new Set(f.postFetch.mock.calls.map((call) => call[1].body)).size).toBe(1);
    });
  });

  test('unknown POST network outcome is terminal without another HTTP attempt', async () => {
    await fixture(async (f) => {
      f.replies.push('network');
      expect(await f.run()).toEqual({ status: 'unknown' });
      expect((await f.job().get()).data()).toMatchObject({
        status: 'unknown', attempt: 1, post: FIXED_POST,
        delivery: { failureReason: 'unknown_post' },
      });
      expect((await f.result().get()).get('postStatus')).toBe('failed');
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: 'unknown' });
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
    });
  });

  test('unknown expired-token refresh blocks the generation, including a later date', async () => {
    await fixture(async (f) => {
      f.tokenFetch.mockRejectedValueOnce(new Error('synthetic-private-refresh-network'));
      expect(await f.run()).toEqual({ status: 'failed' });
      expect((await f.token.get()).get('refreshControl.state')).toBe('blocked');
      expect((await f.job().get()).data()).toMatchObject({
        status: 'failed', attempt: 0, post: FIXED_POST,
        delivery: { failureReason: 'relink_required' },
      });
      expect((await f.result().get()).get('postStatus')).toBe('failed');
      f.advance(86_400_000);
      await f.seedNextDate();
      expect(await f.run('2026-10-26')).toEqual({ status: 'failed' });
      expect((await f.job('2026-10-26').get()).data()).toMatchObject({ status: 'failed', attempt: 0 });
      expect((await f.result('2026-10-26').get()).get('postStatus')).toBe('failed');
      expect((await f.token.get()).get('refreshControl.state')).toBe('blocked');
      expect(f.tokenFetch).toHaveBeenCalledTimes(1);
      expect(f.postFetch).not.toHaveBeenCalled();
    }, true);
  });

  test.each(['off_on', 'relink'] as const)('%s cancels old retry while preserving study and counts', async (kind) => {
    await fixture(async (f) => {
      f.replies.push(429);
      expect(await f.run()).toEqual({ status: 'retry_wait' });
      await f.changeConsent(kind);
      f.advance(RETRY_MS - 1);
      expect(await f.run()).toEqual({ status: 'cancelled' });
      expect((await f.job().get()).data()).toMatchObject({
        status: 'cancelled', attempt: 1, linkRevision: 1, post: FIXED_POST,
        reason: kind === 'off_on' ? 'posting_disabled' : 'link_changed',
      });
      expect((await f.result().get()).data()).toMatchObject({
        postStatus: 'skipped', postSkipReasons: ['x_post_cancelled'],
      });
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: 'cancelled' });
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
    });
  });

  // Two real competing Firestore transactions can incur SDK conflict backoff.
  // Only this case gets an initial 10s bound; no timeout changes after failures.
  test('two concurrent workers share the actual Firestore fence and send once', async () => {
    await fixture(async (f) => {
      const outcomes = await Promise.allSettled([f.run(), f.run()]);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      expect(outcomes.some((outcome) => outcome.status === 'fulfilled'
        && outcome.value.status === 'posted')).toBe(true);
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
      expect((await f.job().get()).data()).toMatchObject({ status: 'posted', attempt: 1, post: FIXED_POST });
      expect((await f.result().get()).get('postStatus')).toBe('posted');
      expect(await f.run()).toEqual({ status: 'posted' });
      expect(f.postFetch).toHaveBeenCalledTimes(1);
    });
  }, 10_000);

  test.each(['before_commit', 'after_commit'] as const)('receipt response loss %s never repeats POST', async (phase) => {
    await fixture(async (f) => {
      const wrapped = loseReceipt(f.store, phase);
      const failure: unknown = await f.run(DATE, wrapped).then(
        () => undefined, (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected sanitized worker error');
      expect(failure.message).toBe('X posting worker operation failed');
      expect(failure.cause).toBeUndefined();
      expect(Object.keys(failure)).toEqual([]);
      expect(failure.stack?.includes('synthetic-private-receipt-response')).toBe(false);
      expect((await f.job().get()).data()).toMatchObject({
        status: phase === 'before_commit' ? 'sending' : 'posted',
        attempt: 1, post: FIXED_POST,
      });
      expect((await f.result().get()).get('postStatus'))
        .toBe(phase === 'before_commit' ? 'pending' : 'posted');
      f.advance(LEASE_MS);
      // Reinvoke with the unwrapped real store after the exact send lease.
      const expected = phase === 'before_commit' ? 'unknown' : 'posted';
      expect(await f.run()).toEqual({ status: expected });
      expect((await f.job().get()).data()).toMatchObject({ status: expected, attempt: 1, post: FIXED_POST });
      expect((await f.result().get()).get('postStatus'))
        .toBe(phase === 'before_commit' ? 'failed' : 'posted');
      f.advance(RETRY_MS);
      expect(await f.run()).toEqual({ status: expected });
      expect(f.postFetch).toHaveBeenCalledTimes(1);
      expect(f.tokenFetch).not.toHaveBeenCalled();
    });
  });
});
