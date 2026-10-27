import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  DocumentReference, Timestamp, getFirestore,
  type Firestore, type Query, type Transaction,
} from 'firebase-admin/firestore';

import { jstStartOfNextDay } from '../../../../shared/date';
import * as accountGuard from '../../account/accountWriteGuard';
import { createPostingJobStore } from '../postingJobStore';
import {
  createPostingJob, transitionPostingJob, type PostingJob,
} from '../postingJobState';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const port = Number(emulatorHost.split(':')[1]);
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(emulatorHost)
  || port > 65535
) {
  throw new Error('postingJobStore tests require local demo-gokaku Firestore Emulator');
}

const app = initializeApp({ projectId: 'demo-gokaku' }, `posting-job-store-${randomUUID()}`);
const db = getFirestore(app);
const date = '2026-10-25';
const goalId = 'posting-store-goal';
const cutoff = jstStartOfNextDay(date);
const startedAt = Timestamp.fromMillis(cutoff - 30 * 86400000);
const leaseMs = 60000;
const retryMs = 300000;
const none = { lastHttpStatus: null, failureReason: null };

type Store = ReturnType<typeof createPostingJobStore>;
type Action = Parameters<Store['apply']>[2];
type Feedback = NonNullable<Parameters<Store['apply']>[3]>;
type CoreCommand = Parameters<typeof transitionPostingJob>[1];
type WithoutNow<T> = T extends unknown ? Omit<T, 'now'> : never;
type ExpectedAction = WithoutNow<CoreCommand>;

afterAll(async () => {
  try {
    await db.terminate();
  } finally {
    await deleteApp(app);
  }
});

function initial(): PostingJob {
  return createPostingJob({
    goalId, date, linkRevision: 1, now: cutoff,
    post: {
      text: 'fixed approved test snapshot', mediaIds: ['123'],
      counts: { monthlyMissedDays: 4, totalMissedDays: 9 },
    },
  });
}

function prepared(id = 'owner', at = cutoff): PostingJob {
  return transitionPostingJob(initial(), {
    kind: 'claim', claimId: id, now: at, leaseMs,
  }).job;
}

function sending(id = 'owner', at = cutoff): PostingJob {
  return transitionPostingJob(prepared(id, at), {
    kind: 'begin_send', claimId: id, now: at,
  }).job;
}

function pending(patch: Record<string, unknown> = {}) {
  return {
    goalId, studiedMinutes: 12, metMin: false, metGoal: false,
    postStatus: 'pending', postSkipReasons: [],
    preserved: { marker: 'keep', counts: [4, 9] }, ...patch,
  };
}

function job(ref: DocumentReference) {
  return ref.collection('postJobs').doc(date);
}

function daily(ref: DocumentReference) {
  return ref.collection('dailyResults').doc(date);
}

function entries(ref: DocumentReference, stream: 'settings' | 'xLink') {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}

function value(stream: 'settings' | 'xLink', enabled: boolean) {
  return stream === 'settings' ? { xPostEnabled: enabled } : { xLinked: enabled };
}

async function history(
  ref: DocumentReference,
  stream: 'settings' | 'xLink',
  steps: { before: boolean; after: boolean }[],
) {
  const batch = db.batch();
  steps.forEach((step, index) => {
    batch.set(entries(ref, stream).doc(String(index + 2)), {
      schemaVersion: 1, revision: index + 2,
      committedAt: Timestamp.fromMillis(cutoff + index),
      before: value(stream, step.before), after: value(stream, step.after),
    });
  });
  const last = steps[steps.length - 1];
  if (last !== undefined) {
    batch.update(ref, {
      [`judgementRevisions.${stream}`]: steps.length + 1,
      ...value(stream, last.after),
    });
  }
  await batch.commit();
}

async function fixture(body: (ref: DocumentReference) => Promise<void>) {
  const ref = db.doc(`users/posting-store-${randomUUID()}`);
  try {
    const batch = db.batch();
    batch.set(ref, {
      activeGoalId: goalId, xPostEnabled: true, xLinked: true,
      subscription: null, xNotice: { preserved: 'prior notice' },
      judgementHistoryStartedAt: startedAt,
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    });
    for (const stream of ['settings', 'xLink'] as const) {
      batch.set(entries(ref, stream).doc('1'), {
        schemaVersion: 1, revision: 1, committedAt: startedAt,
        before: value(stream, true), after: value(stream, true),
      });
    }
    batch.set(daily(ref), pending());
    batch.set(ref.collection('dailyResults').doc('2026-10-24'), pending({
      postStatus: 'skipped', postSkipReasons: ['start_date'],
    }));
    batch.set(ref.collection('goals').doc(goalId), { marker: 'unchanged goal' });
    batch.set(job(ref), initial());
    await batch.commit();
    await body(ref);
  } finally {
    await db.recursiveDelete(ref);
  }
}

function store(source = db, now: () => number = () => cutoff) {
  return createPostingJobStore({ db: source, now });
}

async function ledger(ref: DocumentReference) {
  const snapshots = [
    await ref.get(),
    ...(await ref.collection('postJobs').get()).docs,
    ...(await ref.collection('dailyResults').get()).docs,
    ...(await ref.collection('goals').get()).docs,
    ...(await entries(ref, 'settings').get()).docs,
    ...(await entries(ref, 'xLink').get()).docs,
  ];
  return snapshots.map((doc) => ({
    path: doc.ref.path, data: doc.data(),
    updated: doc.updateTime
      ? [doc.updateTime.seconds, doc.updateTime.nanoseconds] : null,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

async function rejected(operation: () => Promise<unknown>, raw?: string) {
  const error: unknown = await operation().then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toBeUndefined();
  if (raw !== undefined) {
    expect(String(error)).not.toContain(raw);
    expect(JSON.stringify(error)).not.toContain(raw);
  }
  return error as Error;
}

function instrument(
  transform: (tx: Transaction) => Transaction,
  options?: { maxAttempts: 1 },
): Firestore {
  return {
    doc: (path: string) => db.doc(path),
    runTransaction: (callback: (tx: Transaction) => Promise<unknown>) =>
      db.runTransaction((tx) => callback(transform(tx)), options),
  } as unknown as Firestore;
}

function observe(
  tx: Transaction,
  events: string[],
  hooks: {
    read?: (ref: DocumentReference | Query) => unknown;
    wrote?: (ref: DocumentReference) => void;
  } = {},
): Transaction {
  return new Proxy(tx, {
    get(target, key) {
      if (key === 'get') {
        return async (ref: DocumentReference | Query) => {
          const replacement = hooks.read?.(ref);
          const result: unknown = replacement !== undefined
            ? await replacement
            : ref instanceof DocumentReference ? await target.get(ref) : await target.get(ref);
          events.push(ref instanceof DocumentReference ? `read:${ref.path}` : 'query');
          return result;
        };
      }
      if (['create', 'set', 'update', 'delete'].includes(String(key))) {
        return (...args: unknown[]) => {
          const ref = args[0] as DocumentReference;
          events.push(`write:${String(key)}:${ref.path}`);
          const result: unknown = Reflect.apply(Reflect.get(target, key), target, args);
          hooks.wrote?.(ref);
          return result;
        };
      }
      const member: unknown = Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** First callback is rolled back; the second is the only committed result. */
function replay(afterRollback: () => Promise<void>, events: string[][] = []): Firestore {
  const rollback = new Error('controlled callback rollback');
  return {
    doc: (path: string) => db.doc(path),
    runTransaction: async (callback: (tx: Transaction) => Promise<unknown>) => {
      const first: string[] = [];
      events.push(first);
      try {
        await db.runTransaction(async (tx) => {
          await callback(observe(tx, first));
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      await afterRollback();
      const second: string[] = [];
      events.push(second);
      return db.runTransaction((tx) => callback(observe(tx, second)));
    },
  } as unknown as Firestore;
}

describe('postingJobStore local Firestore', () => {
  test('initial legacy job is claimed with explicit delivery; fixed material and counts stay unchanged', async () => {
    await fixture(async (ref) => {
      const before = await ledger(ref);
      const result = await store().apply(ref.id, date, { kind: 'claim', claimId: 'owner', leaseMs });
      expect(result).toEqual({
        status: 'available', job: prepared(), changed: true, authorizeHttp: false, forceRefresh: false,
      });
      expect((await job(ref).get()).data()).toEqual({ ...prepared(), delivery: none });
      expect((await ledger(ref)).filter((doc) => doc.path !== job(ref).path))
        .toEqual(before.filter((doc) => doc.path !== job(ref).path));
    });
  });

  test('concurrent claim transactions acquire exactly one owner', async () => {
    await fixture(async (ref) => {
      const api = store();
      const results = await Promise.all(['first', 'second'].map((claimId) =>
        api.apply(ref.id, date, { kind: 'claim', claimId, leaseMs })));
      const acquired = results.filter((result) => result.status === 'available' && result.changed);
      expect(acquired).toHaveLength(1);
      expect(results.every((result) => result.status === 'available' && !result.authorizeHttp)).toBe(true);
      const saved = (await job(ref).get()).data();
      expect(saved?.status).toBe('preparing');
      expect(acquired[0]).toMatchObject({ job: { claim: { id: saved?.claim.id } } });
      expect((await ref.collection('postJobs').get()).size).toBe(1);
    });
  });

  test('repeated begin authorizes once, only after the sending state is committed', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      const api = store();
      const first = await api.apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' });
      expect((await job(ref).get()).data()).toEqual({ ...sending(), delivery: none });
      expect(first).toEqual({
        status: 'available', job: sending(), changed: true, authorizeHttp: true, forceRefresh: false,
      });
      const before = await ledger(ref);
      expect(await api.apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' }))
        .toMatchObject({ changed: false, authorizeHttp: false });
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('code14 after scheduling begin rejects unchanged and rolls back without returning authorization', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      const before = await ledger(ref);
      const failure = Object.assign(new Error('synthetic commit failure'), { code: 14 });
      const source = instrument((tx) => observe(tx, [], { wrote: () => { throw failure; } }),
        { maxAttempts: 1 });
      const returned = jest.fn();
      await expect(store(source).apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' })
        .then((result) => { returned(result); return result; })).rejects.toBe(failure);
      expect(returned).not.toHaveBeenCalled();
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('each callback samples trusted time after reads; expired replay cannot leak first begin authorization', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      const events: string[][] = [];
      const source = replay(async () => {}, events);
      const now = jest.fn(() => {
        const current = events[events.length - 1];
        expect(current.some((event) => event.startsWith('read:'))).toBe(true);
        expect(current.some((event) => event.startsWith('write:'))).toBe(false);
        current.push('clock');
        return events.length === 1 ? cutoff : cutoff + leaseMs;
      });
      expect(await store(source, now).apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' }))
        .toMatchObject({ status: 'available', changed: false, authorizeHttp: false });
      expect(now).toHaveBeenCalledTimes(2);
      for (const attempt of events) {
        expect(attempt.slice(attempt.indexOf('clock') + 1).some((event) =>
          event.startsWith('read:') || event === 'query')).toBe(false);
      }
      expect((await job(ref).get()).data()).toEqual({ ...prepared(), delivery: none });
    });
  });

  test('claim takeover at expiry fences old begin, abort and receipts without consuming an attempt', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      const api = store(db, () => cutoff + leaseMs);
      expect(await api.apply(ref.id, date, { kind: 'claim', claimId: 'new_owner', leaseMs }))
        .toMatchObject({ changed: true, job: { status: 'preparing', attempt: 0, claim: { id: 'new_owner' } } });
      const before = await ledger(ref);
      const stale: Action[] = [
        { kind: 'begin_send', claimId: 'owner' },
        { kind: 'abort_preparation', claimId: 'owner' },
        { kind: 'complete', claimId: 'owner', outcome: { kind: 'posted', postId: '789' } },
      ];
      for (const action of stale) {
        expect(await api.apply(ref.id, date, action)).toMatchObject({ changed: false, authorizeHttp: false });
      }
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('OFF then ON after prepare cancels even a stale begin and atomically preserves learning values', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      await history(ref, 'settings', [{ before: true, after: false }, { before: false, after: true }]);
      const parent = (await ref.get()).data();
      const result = await store(db, () => cutoff + 2).apply(ref.id, date,
        { kind: 'begin_send', claimId: 'stale_owner' });
      expect(result).toMatchObject({
        changed: true, authorizeHttp: false,
        job: { status: 'cancelled', reason: 'posting_disabled', attempt: 0 },
      });
      expect((await daily(ref).get()).data()).toEqual(pending({
        postStatus: 'skipped', postSkipReasons: ['x_post_cancelled'],
      }));
      expect((await ref.get()).data()).toEqual(parent);
      const before = await ledger(ref);
      expect(await store(db, () => cutoff + 3).apply(ref.id, date,
        { kind: 'claim', claimId: 'later', leaseMs })).toMatchObject({ changed: false, authorizeHttp: false });
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('true-to-true relink after prepare cancels begin and cannot retarget the fixed job', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      await history(ref, 'xLink', [{ before: true, after: true }]);
      expect(await store(db, () => cutoff + 1).apply(ref.id, date,
        { kind: 'begin_send', claimId: 'owner' })).toMatchObject({
        changed: true, authorizeHttp: false,
        job: { status: 'cancelled', reason: 'link_changed', linkRevision: 1 },
      });
      expect((await daily(ref).get()).get('postSkipReasons')).toEqual(['x_post_cancelled']);
      expect((await job(ref).get()).get('post')).toEqual(initial().post);
    });
  });

  test('allowed consent revision must match job revision; no silent adoption of another generation', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...initial(), linkRevision: 2 });
      const before = await ledger(ref);
      await rejected(() => store().apply(ref.id, date, { kind: 'claim', claimId: 'owner', leaseMs }));
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('parent deletion and deletion marker on callback replay fence begin and never recreate roots', async () => {
    await fixture(async (ref) => {
      for (const remove of [false, true]) {
        if (!(await ref.get()).exists) throw new Error('Fixture root unexpectedly absent');
        await job(ref).set({ ...prepared(), delivery: none });
        const source = replay(async () => {
          if (remove) await ref.delete();
          else await ref.update({ deletionInProgress: true });
        });
        const result = await store(source).apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' });
        expect(result).toEqual({ status: remove ? 'noAccount' : 'deleting' });
        expect((await job(ref).get()).data()).toEqual({ ...prepared(), delivery: none });
        expect((await daily(ref).get()).data()).toEqual(pending());
        if (!remove) await ref.update({ deletionInProgress: false });
        else expect((await ref.get()).exists).toBe(false);
      }
    });
  });

  test('expired sending becomes unknown for recover and claim before any reclaim or replay HTTP', async () => {
    await fixture(async (ref) => {
      for (const action of [
        { kind: 'recover' }, { kind: 'claim', claimId: 'new_owner', leaseMs },
      ] satisfies Action[]) {
        await job(ref).set({ ...sending(), delivery: { lastHttpStatus: 503, failureReason: 'post_failed' } });
        await daily(ref).set(pending());
        const api = store(db, () => cutoff + leaseMs);
        expect(await api.apply(ref.id, date, action)).toMatchObject({
          changed: true, authorizeHttp: false, job: { status: 'unknown', attempt: 1 },
        });
        expect((await job(ref).get()).get('delivery')).toEqual({
          lastHttpStatus: 503, failureReason: 'unknown_post',
        });
        expect((await daily(ref).get()).data()).toEqual(pending({ postStatus: 'failed' }));
        const before = await ledger(ref);
        expect(await api.apply(ref.id, date, { kind: 'claim', claimId: 'another', leaseMs }))
          .toMatchObject({ changed: false, authorizeHttp: false });
        expect(await ledger(ref)).toEqual(before);
      }
    });
  });

  test('owned known completion after sending expiry succeeds without prior recovery or consent cancellation', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...sending(), delivery: none });
      await history(ref, 'settings', [{ before: true, after: false }]);
      expect(await store(db, () => cutoff + leaseMs).apply(ref.id, date, {
        kind: 'complete', claimId: 'owner', outcome: { kind: 'posted', postId: '987' },
      }, { lastHttpStatus: 201 })).toMatchObject({
        changed: true, authorizeHttp: false, job: { status: 'posted', postId: '987' },
      });
      expect((await daily(ref).get()).data()).toEqual(pending({ postStatus: 'posted' }));
      expect((await job(ref).get()).get('delivery')).toEqual({ lastHttpStatus: 201, failureReason: null });
    });
  });

  test('three total attempts enforce five minute retry boundaries and then fail atomically', async () => {
    await fixture(async (ref) => {
      let now = cutoff;
      const api = store(db, () => now);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimId = `attempt_${attempt}`;
        expect(await api.apply(ref.id, date, { kind: 'claim', claimId, leaseMs }))
          .toMatchObject({ changed: true, job: { status: 'preparing', attempt: attempt - 1 } });
        expect(await api.apply(ref.id, date, { kind: 'begin_send', claimId }))
          .toMatchObject({ changed: true, authorizeHttp: true, job: { attempt } });
        expect(await api.apply(ref.id, date, {
          kind: 'complete', claimId, outcome: { kind: 'retryable' },
        }, { lastHttpStatus: 503 })).toMatchObject({
          changed: true, authorizeHttp: false, job: { status: attempt < 3 ? 'ready' : 'failed' },
        });
        if (attempt < 3) {
          expect((await job(ref).get()).get('nextAt')).toBe(now + retryMs);
          const before = await ledger(ref);
          now += retryMs - 1;
          expect(await api.apply(ref.id, date, { kind: 'claim', claimId: `next_${attempt}`, leaseMs }))
            .toMatchObject({ changed: false, authorizeHttp: false });
          expect(await ledger(ref)).toEqual(before);
          expect((await daily(ref).get()).get('postStatus')).toBe('pending');
          now += 1;
        }
      }
      expect((await daily(ref).get()).data()).toEqual(pending({ postStatus: 'failed' }));
      expect((await job(ref).get()).get('delivery')).toEqual({ lastHttpStatus: 503, failureReason: 'post_failed' });
      expect((await job(ref).get()).get('post')).toEqual(initial().post);
    });
  });

  test('401 metadata survives claim and begin for worker refresh; posted clears failure classification', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...sending(), delivery: none });
      let now = cutoff;
      const api = store(db, () => now);
      expect(await api.apply(ref.id, date, {
        kind: 'complete', claimId: 'owner', outcome: { kind: 'retryable' },
      }, { lastHttpStatus: 401, failureReason: 'relink_required' }))
        .toMatchObject({ changed: true, forceRefresh: true });
      now += retryMs;
      expect(await api.apply(ref.id, date, { kind: 'claim', claimId: 'second', leaseMs }))
        .toMatchObject({ forceRefresh: true });
      expect(await api.apply(ref.id, date, { kind: 'begin_send', claimId: 'second' }))
        .toMatchObject({ authorizeHttp: true, forceRefresh: true });
      expect((await job(ref).get()).get('delivery')).toEqual({
        lastHttpStatus: 401, failureReason: 'relink_required',
      });
      expect(await api.apply(ref.id, date, {
        kind: 'complete', claimId: 'second', outcome: { kind: 'posted', postId: '1234' },
      }, { lastHttpStatus: 201, failureReason: 'post_failed' }))
        .toMatchObject({ forceRefresh: false, job: { status: 'posted' } });
      expect((await job(ref).get()).get('delivery')).toEqual({ lastHttpStatus: 201, failureReason: null });
    });
  });

  test('abort and terminal outcomes persist fixed failure classifications while preserving absent HTTP feedback', async () => {
    await fixture(async (ref) => {
      const cases: { state: PostingJob; action: Action; feedback?: Feedback; reason: string }[] = [
        { state: prepared(), action: { kind: 'abort_preparation', claimId: 'owner' },
          feedback: { failureReason: 'relink_required' }, reason: 'relink_required' },
        { state: sending(), action: { kind: 'complete', claimId: 'owner', outcome: { kind: 'permanent' } },
          reason: 'post_failed' },
        { state: sending(), action: { kind: 'complete', claimId: 'owner', outcome: { kind: 'unknown' } },
          feedback: { failureReason: 'post_failed' }, reason: 'unknown_post' },
      ];
      for (const item of cases) {
        await job(ref).set({ ...item.state, delivery: { lastHttpStatus: 429, failureReason: null } });
        await daily(ref).set(pending());
        expect(await store().apply(ref.id, date, item.action, item.feedback))
          .toMatchObject({ changed: true, authorizeHttp: false, forceRefresh: false });
        expect((await job(ref).get()).get('delivery')).toEqual({ lastHttpStatus: 429, failureReason: item.reason });
        expect((await daily(ref).get()).data()).toEqual(pending({ postStatus: 'failed' }));
      }
    });
  });

  test('stale receipt feedback and repeated terminal receipts never overwrite current delivery or updateTime', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...sending('new_owner'), delivery: { lastHttpStatus: 401, failureReason: 'relink_required' } });
      const api = store();
      let before = await ledger(ref);
      expect(await api.apply(ref.id, date, {
        kind: 'complete', claimId: 'old_owner', outcome: { kind: 'posted', postId: '1' },
      }, { lastHttpStatus: 201 })).toMatchObject({ changed: false, authorizeHttp: false, forceRefresh: true });
      expect(await ledger(ref)).toEqual(before);
      await api.apply(ref.id, date, {
        kind: 'complete', claimId: 'new_owner', outcome: { kind: 'posted', postId: '2' },
      }, { lastHttpStatus: 201 });
      before = await ledger(ref);
      expect(await api.apply(ref.id, date, {
        kind: 'complete', claimId: 'new_owner', outcome: { kind: 'unknown' },
      }, { lastHttpStatus: 401, failureReason: 'unknown_post' }))
        .toMatchObject({ changed: false, forceRefresh: false });
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('sending cannot be cancelled; terminal noops require matching daily status and exact reasons', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...sending(), delivery: none });
      let before = await ledger(ref);
      expect(await store().apply(ref.id, date, { kind: 'cancel', reason: 'posting_disabled' }))
        .toMatchObject({ changed: false, authorizeHttp: false });
      expect(await ledger(ref)).toEqual(before);
      const states = [
        { job: transitionPostingJob(sending(), { kind: 'complete', claimId: 'owner', now: cutoff,
          outcome: { kind: 'posted', postId: '1' } }).job, status: 'posted', reasons: [] },
        { job: transitionPostingJob(sending(), { kind: 'complete', claimId: 'owner', now: cutoff,
          outcome: { kind: 'permanent' } }).job, status: 'failed', reasons: [] },
        { job: transitionPostingJob(sending(), { kind: 'complete', claimId: 'owner', now: cutoff,
          outcome: { kind: 'unknown' } }).job, status: 'failed', reasons: [] },
        { job: transitionPostingJob(initial(), { kind: 'cancel', now: cutoff,
          reason: 'posting_disabled' }).job, status: 'skipped', reasons: ['x_post_cancelled'] },
      ];
      for (const item of states) {
        await job(ref).set({ ...item.job, delivery: {
          lastHttpStatus: null, failureReason: item.job.status === 'unknown' ? 'unknown_post'
            : item.job.status === 'failed' ? 'post_failed' : null,
        } });
        await daily(ref).set(pending({ postStatus: item.status, postSkipReasons: item.reasons }));
        before = await ledger(ref);
        expect(await store().apply(ref.id, date, { kind: 'recover' }))
          .toMatchObject({ changed: false, authorizeHttp: false });
        expect(await ledger(ref)).toEqual(before);
        for (const patch of [
          { postStatus: 'pending', postSkipReasons: [] },
          { postStatus: item.status, postSkipReasons: ['start_date'] },
        ]) {
          await daily(ref).set(pending(patch));
          const corrupt = await ledger(ref);
          await rejected(() => store().apply(ref.id, date, { kind: 'recover' }));
          expect(await ledger(ref)).toEqual(corrupt);
        }
      }
    });
  });

  test('guard, result, job and consent reads share one transaction and precede writes to owned paths only', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ ...prepared(), delivery: none });
      await history(ref, 'settings', [{ before: true, after: false }]);
      const events: string[] = [];
      const queries: Query[] = [];
      const transactions: Transaction[] = [];
      const guard = jest.spyOn(accountGuard, 'getWritableAccount');
      try {
        const source = instrument((tx) => {
          const observed = observe(tx, events, {
            read: (target) => {
              if (!(target instanceof DocumentReference)) queries.push(target);
              return undefined;
            },
          });
          transactions.push(observed);
          return observed;
        });
        const now = () => { events.push('clock'); return cutoff + 1; };
        expect(await store(source, now).apply(ref.id, date, { kind: 'begin_send', claimId: 'owner' }))
          .toMatchObject({ changed: true, authorizeHttp: false });
        expect(guard).toHaveBeenCalledWith(transactions[transactions.length - 1], expect.any(DocumentReference));
        for (const path of [ref.path, job(ref).path, daily(ref).path]) {
          expect(events).toContain(`read:${path}`);
        }
        const cutoffTimestamp = Timestamp.fromMillis(cutoff);
        const expectedQueries: Query[] = [];
        for (const stream of ['settings', 'xLink'] as const) {
          const collection = entries(ref, stream);
          expectedQueries.push(
            collection.where('committedAt', '<', cutoffTimestamp)
              .orderBy('committedAt', 'desc').orderBy('revision', 'desc').limit(1),
            collection.where('committedAt', '>=', cutoffTimestamp)
              .orderBy('committedAt', 'asc').orderBy('revision', 'asc').limit(1),
          );
        }
        expectedQueries.push(entries(ref, 'settings')
          .where('revision', '>', 1).where('revision', '<=', 2).orderBy('revision', 'asc'));
        for (const expected of expectedQueries) {
          expect(queries.some((actual) => actual.isEqual(expected))).toBe(true);
        }
        expect(queries.every((actual) =>
          expectedQueries.some((expected) => actual.isEqual(expected)))).toBe(true);
        const firstWrite = events.findIndex((event) => event.startsWith('write:'));
        expect(firstWrite).toBeGreaterThan(events.indexOf('clock'));
        expect(events.slice(firstWrite).every((event) => event.startsWith('write:'))).toBe(true);
        const writes = events.filter((event) => event.startsWith('write:'));
        expect(writes).toHaveLength(2);
        expect(writes.every((event) => event === `write:set:${job(ref).path}`
          || event === `write:update:${job(ref).path}`
          || event === `write:update:${daily(ref).path}`)).toBe(true);
      } finally {
        guard.mockRestore();
      }
    });
  });

  test('cancelUncreated persists consent cancellation once without creating a job or changing counts', async () => {
    await fixture(async (ref) => {
      await job(ref).delete();
      await history(ref, 'settings', [{ before: true, after: false }, { before: false, after: true }]);
      const before = await ledger(ref);
      const events: string[] = [];
      const source = instrument((tx) => observe(tx, events));
      expect(await store(source, () => cutoff + 2).cancelUncreated(ref.id, date)).toEqual({ status: 'cancelled' });
      expect((await job(ref).get()).exists).toBe(false);
      expect((await daily(ref).get()).data()).toEqual(pending({
        postStatus: 'skipped', postSkipReasons: ['x_post_cancelled'],
      }));
      expect((await ledger(ref)).filter((doc) => doc.path !== daily(ref).path))
        .toEqual(before.filter((doc) => doc.path !== daily(ref).path));
      expect(events.filter((event) => event.startsWith('write:'))).toEqual([`write:update:${daily(ref).path}`]);
      const firstWrite = events.findIndex((event) => event.startsWith('write:'));
      expect(events.slice(firstWrite).every((event) => event.startsWith('write:'))).toBe(true);
      const cancelled = await ledger(ref);
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'unchanged' });
      expect(await ledger(ref)).toEqual(cancelled);
    });
  });

  test('cancelUncreated leaves allowed, beforeCoverage and valid nonpending results unchanged; existing job rejects', async () => {
    await fixture(async (ref) => {
      const withJob = await ledger(ref);
      await rejected(() => store().cancelUncreated(ref.id, date));
      expect(await ledger(ref)).toEqual(withJob);
      await job(ref).delete();
      let before = await ledger(ref);
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'unchanged' });
      expect(await ledger(ref)).toEqual(before);
      for (const patch of [
        { postStatus: 'posted', postSkipReasons: [] },
        { postStatus: 'failed', postSkipReasons: [] },
        { postStatus: 'skipped', postSkipReasons: ['start_date'] },
        { postStatus: 'none', metMin: true, postSkipReasons: [] },
      ]) {
        await daily(ref).set(pending(patch));
        before = await ledger(ref);
        expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'unchanged' });
        expect(await ledger(ref)).toEqual(before);
      }
      await daily(ref).set(pending());
      await ref.set({ xPostEnabled: true, xLinked: true, subscription: null });
      before = await ledger(ref);
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'unchanged' });
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('missing job/result and unavailable parents are typed and never create documents', async () => {
    await fixture(async (ref) => {
      await job(ref).delete();
      expect(await store().apply(ref.id, date, { kind: 'recover' })).toEqual({ status: 'missing' });
      await daily(ref).delete();
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'missing' });
      await job(ref).set(initial());
      expect(await store().apply(ref.id, date, { kind: 'recover' })).toEqual({ status: 'missing' });
      await ref.update({ deletionInProgress: true });
      const before = await ledger(ref);
      expect(await store().apply(ref.id, date, { kind: 'recover' })).toEqual({ status: 'deleting' });
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'deleting' });
      expect(await ledger(ref)).toEqual(before);
      await ref.delete();
      const absent = await ledger(ref);
      expect(await store().apply(ref.id, date, { kind: 'recover' })).toEqual({ status: 'noAccount' });
      expect(await store().cancelUncreated(ref.id, date)).toEqual({ status: 'noAccount' });
      expect(await ledger(ref)).toEqual(absent);
    });
  });

  test('typed actions omit now distributively; unsafe identity, clock, action and feedback fail safely', async () => {
    const actionContract: [Action] extends [ExpectedAction]
      ? [ExpectedAction] extends [Action] ? true : false : false = true;
    expect(actionContract).toBe(true);
    const doc = jest.fn(() => { throw new Error('Unexpected SDK path'); });
    const runTransaction = jest.fn();
    const source = { doc, runTransaction } as unknown as Firestore;
    for (const uid of ['', ' ', '.', '..', 'a/b', '__reserved__', '\ud800', 'a'.repeat(129)]) {
      await rejected(() => store(source).apply(uid, date, { kind: 'recover' }));
      await rejected(() => store(source).cancelUncreated(uid, date));
    }
    for (const day of ['', '../bad', '2026-02-30', '2026-1-01', `${date}/bad`]) {
      await rejected(() => store(source).apply('safe', day, { kind: 'recover' }));
      await rejected(() => store(source).cancelUncreated('safe', day));
    }
    expect(doc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
    await fixture(async (ref) => {
      for (const now of [NaN, Infinity, cutoff + 0.5, cutoff - 1, 253402300800000]) {
        const before = await ledger(ref);
        await rejected(() => store(db, () => now).apply(ref.id, date, { kind: 'recover' }));
        expect(await ledger(ref)).toEqual(before);
      }
      const badActions: unknown[] = [
        { kind: 'recover', now: cutoff }, { kind: 'recover', extra: true },
        { kind: 'claim', claimId: 'bad/id', leaseMs },
        { kind: 'claim', claimId: 'owner', leaseMs: 0 },
        { kind: 'begin_send' }, { kind: 'cancel', reason: 'invented' },
        { kind: 'complete', claimId: 'owner', outcome: { kind: 'posted', postId: 'invalid' } },
      ];
      for (const action of badActions) {
        const before = await ledger(ref);
        await rejected(() => store().apply(ref.id, date, action as Action));
        expect(await ledger(ref)).toEqual(before);
      }
      await job(ref).set({ ...sending(), delivery: none });
      const badFeedback: unknown[] = [
        null, [], { lastHttpStatus: 99 }, { lastHttpStatus: 600 },
        { lastHttpStatus: 201.5 }, { lastHttpStatus: '401' },
        { failureReason: null }, { failureReason: 'raw-provider-message' },
        { lastHttpStatus: 401, provider: 'raw-provider-message' },
      ];
      for (const feedback of badFeedback) {
        const before = await ledger(ref);
        await rejected(() => store().apply(ref.id, date, {
          kind: 'complete', claimId: 'owner', outcome: { kind: 'permanent' },
        }, feedback as Feedback));
        expect(await ledger(ref)).toEqual(before);
      }
      await rejected(() => store().apply(ref.id, date, { kind: 'recover' }, { lastHttpStatus: 401 }));
      for (const status of [100, 599]) {
        await job(ref).set({ ...sending(), delivery: none });
        await daily(ref).set(pending());
        await store().apply(ref.id, date, {
          kind: 'complete', claimId: 'owner', outcome: { kind: 'permanent' },
        }, { lastHttpStatus: status });
        expect((await job(ref).get()).get('delivery.lastHttpStatus')).toBe(status);
      }
    });
  });

  test('strict core fields and delivery are validated without stripping unrelated keys or accepting legacy noninitial jobs', async () => {
    await fixture(async (ref) => {
      const raw = `untrusted-${randomUUID()}`;
      const malformed = [
        { ...initial(), extra: raw },
        { ...initial(), date: '2026-10-24' },
        { ...initial(), post: { ...initial().post, extra: raw } },
        { ...initial(), delivery: null },
        { ...initial(), delivery: {} },
        { ...initial(), delivery: { ...none, extra: raw } },
        { ...initial(), delivery: { ...none, lastHttpStatus: 600 } },
        { ...initial(), delivery: { ...none, lastHttpStatus: 401.1 } },
        { ...initial(), delivery: { ...none, failureReason: raw } },
        prepared(), sending(),
        { ...initial(), lastClaimId: 'previous_owner' },
        { ...initial(), attempt: 1, lastClaimId: 'previous_owner' },
      ];
      for (const value of malformed) {
        await job(ref).set(value);
        const before = await ledger(ref);
        await rejected(() => store().apply(ref.id, date, { kind: 'recover' }), raw);
        expect(await ledger(ref)).toEqual(before);
      }
      await job(ref).set(initial());
      const before = await ledger(ref);
      expect(await store().apply(ref.id, date, { kind: 'recover' }))
        .toMatchObject({ changed: false, authorizeHttp: false, forceRefresh: false });
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('malformed daily results, consent history and existing-job beforeCoverage reject without mutation', async () => {
    await fixture(async (ref) => {
      const badResults = [
        { goalId: 'other-goal' }, { studiedMinutes: -1 }, { studiedMinutes: 0.1 },
        { metMin: true }, { metGoal: true }, { postStatus: 'posted' },
        { postStatus: 'pending', postSkipReasons: ['start_date'] },
        { postSkipReasons: null }, { postSkipReasons: ['x_post_cancelled', 'x_post_cancelled'] },
      ];
      for (const patch of badResults) {
        await daily(ref).set(pending(patch));
        const before = await ledger(ref);
        await rejected(() => store().apply(ref.id, date, { kind: 'claim', claimId: 'owner', leaseMs }));
        expect(await ledger(ref)).toEqual(before);
      }
      for (const field of ['goalId', 'studiedMinutes', 'metMin', 'metGoal', 'postStatus', 'postSkipReasons']) {
        const incomplete: Record<string, unknown> = pending();
        delete incomplete[field];
        await daily(ref).set(incomplete);
        const before = await ledger(ref);
        await rejected(() => store().apply(ref.id, date, { kind: 'recover' }));
        expect(await ledger(ref)).toEqual(before);
      }
      await daily(ref).set(pending());
      await entries(ref, 'settings').doc('1').delete();
      let before = await ledger(ref);
      await rejected(() => store().apply(ref.id, date, { kind: 'claim', claimId: 'owner', leaseMs }));
      expect(await ledger(ref)).toEqual(before);
      await ref.set({ xPostEnabled: true, xLinked: true, subscription: null });
      before = await ledger(ref);
      await rejected(() => store().apply(ref.id, date, { kind: 'claim', claimId: 'owner', leaseMs }));
      expect(await ledger(ref)).toEqual(before);
      await job(ref).delete();
      await daily(ref).set(pending({ postStatus: 'skipped', postSkipReasons: [] }));
      before = await ledger(ref);
      await rejected(() => store().cancelUncreated(ref.id, date));
      expect(await ledger(ref)).toEqual(before);
    });
  });

  test('SDK read errors retain identity; local accessor errors are generic; terminal-write faults roll back both documents', async () => {
    await fixture(async (ref) => {
      const failure = Object.assign(new Error('synthetic SDK unavailable'), { code: 14 });
      const source = instrument((tx) => observe(tx, [], {
        read: (target) => {
          if (target instanceof DocumentReference && target.path === ref.path) throw failure;
          return undefined;
        },
      }), { maxAttempts: 1 });
      let before = await ledger(ref);
      await expect(store(source).apply(ref.id, date, { kind: 'recover' })).rejects.toBe(failure);
      expect(await ledger(ref)).toEqual(before);
      const raw = `accessor-${randomUUID()}`;
      const local = instrument((tx) => observe(tx, [], {
        read: (target) => {
          if (!(target instanceof DocumentReference) || target.path !== job(ref).path) return undefined;
          const corrupt: Record<string, unknown> = { ...initial(), delivery: none };
          Object.defineProperty(corrupt, 'post', { enumerable: true, get: () => { throw new Error(raw); } });
          return { exists: true, id: date, ref: target, data: () => corrupt };
        },
      }));
      await rejected(() => store(local).apply(ref.id, date, { kind: 'recover' }), raw);
      expect(await ledger(ref)).toEqual(before);
      await job(ref).set({ ...sending(), delivery: none });
      before = await ledger(ref);
      let writes = 0;
      const rollback = instrument((tx) => observe(tx, [], {
        wrote: () => {
          writes += 1;
          if (writes === 2) throw failure;
        },
      }), { maxAttempts: 1 });
      await expect(store(rollback).apply(ref.id, date, {
        kind: 'complete', claimId: 'owner', outcome: { kind: 'posted', postId: '99' },
      }, { lastHttpStatus: 201 })).rejects.toBe(failure);
      expect(writes).toBe(2);
      expect(await ledger(ref)).toEqual(before);
    });
  });
});
