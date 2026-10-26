import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  DocumentReference, FieldPath, Timestamp, getFirestore,
  type Firestore, type Query, type Transaction,
} from 'firebase-admin/firestore';

import { jstStartOfNextDay } from '../../../../shared/date';
import { buildMissedStudyPost } from '../../../../shared/missedStudyPost';
import * as accountGuard from '../../account/accountWriteGuard';
import { ensurePostingJob } from '../createPostingJob';

/**
 * 正式7-3b内部「初回本文固定jobの作成」のtests-first artifact。
 * 未適用・未実行。mainのRED確認後にsourceを提示する。
 * pure postingJobStateの実装・設定・index・共有fixtureは変更しない。
 */
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const port = Number(emulatorHost.split(':')[1]);
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(emulatorHost)
  || port > 65535
) {
  throw new Error('createPostingJob tests require local demo-gokaku Firestore Emulator');
}

const app = initializeApp({ projectId: 'demo-gokaku' }, `create-post-job-${randomUUID()}`);
const db = getFirestore(app);
const date = '2026-10-25';
const goalId = 'posting-job-goal';
const cutoff = jstStartOfNextDay(date);
const startedAt = Timestamp.fromMillis(cutoff - 86400000 * 30);
const clock = () => cutoff;

afterAll(async () => {
  try {
    await db.terminate();
  } finally {
    await deleteApp(app);
  }
});

function root() {
  return {
    activeGoalId: goalId, xPostEnabled: true, xLinked: true, subscription: null,
    judgementHistoryStartedAt: startedAt,
    judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
  };
}

function pending(patch: Record<string, unknown> = {}) {
  return {
    goalId, studiedMinutes: 12, metMin: false, metGoal: false,
    postStatus: 'pending', postSkipReasons: [], ...patch,
  };
}

function entries(ref: DocumentReference, stream: 'settings' | 'xLink') {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}

function snapshot(stream: 'settings' | 'xLink', value: boolean) {
  return stream === 'settings' ? { xPostEnabled: value } : { xLinked: value };
}

async function history(
  ref: DocumentReference,
  stream: 'settings' | 'xLink',
  steps: { before: boolean; after: boolean; at?: number }[],
) {
  const batch = db.batch();
  steps.forEach((step, index) => {
    batch.set(entries(ref, stream).doc(String(index + 2)), {
      schemaVersion: 1, revision: index + 2,
      committedAt: Timestamp.fromMillis(step.at ?? cutoff + index),
      before: snapshot(stream, step.before), after: snapshot(stream, step.after),
    });
  });
  const last = steps[steps.length - 1];
  if (last !== undefined) {
    batch.update(ref, {
      [`judgementRevisions.${stream}`]: steps.length + 1,
      ...snapshot(stream, last.after),
    });
  }
  await batch.commit();
}

async function fixture(body: (ref: DocumentReference) => Promise<void>) {
  const ref = db.doc(`users/create-post-job-${randomUUID()}`);
  try {
    const batch = db.batch();
    batch.set(ref, root());
    for (const stream of ['settings', 'xLink'] as const) {
      batch.set(entries(ref, stream).doc('1'), {
        schemaVersion: 1, revision: 1, committedAt: startedAt,
        before: snapshot(stream, true), after: snapshot(stream, true),
      });
    }
    batch.set(ref.collection('dailyResults').doc(date), pending());
    await batch.commit();
    await body(ref);
  } finally {
    await db.recursiveDelete(ref);
  }
}

function job(ref: DocumentReference) {
  return ref.collection('postJobs').doc(date);
}

function run(ref: DocumentReference, source = db, now = clock) {
  return ensurePostingJob(ref.id, date, { db: source, now });
}

async function unchangedInputs(ref: DocumentReference) {
  const parent = await ref.get();
  const results = await ref.collection('dailyResults').get();
  const settings = await entries(ref, 'settings').get();
  const links = await entries(ref, 'xLink').get();
  return [parent, ...results.docs, ...settings.docs, ...links.docs].map((doc) => ({
    path: doc.ref.path, data: doc.data(),
    updateTime: doc.updateTime?.toMillis(),
  }));
}

async function invalid(operation: () => Promise<unknown>, raw?: string) {
  const failure: unknown = await operation().then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (raw !== undefined) {
    expect(String(failure)).not.toContain(raw);
    expect(JSON.stringify(failure)).not.toContain(raw);
  }
  return failure;
}

/** 同じ実Admin transactionを観測する。SDK read/commitはEmulatorへ委譲。 */
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
  replace?: (target: DocumentReference | Query) => unknown,
  afterCreate?: () => void,
): Transaction {
  return new Proxy(tx, {
    get(target, key) {
      if (key === 'get') {
        return async (ref: DocumentReference | Query) => {
          events.push(ref instanceof DocumentReference ? `read:${ref.path}` : 'query');
          const replacement = replace?.(ref);
          if (replacement !== undefined) return replacement;
          return ref instanceof DocumentReference ? target.get(ref) : target.get(ref);
        };
      }
      if (['create', 'set', 'update', 'delete'].includes(String(key))) {
        return (...args: unknown[]) => {
          events.push(String(key));
          const result: unknown = Reflect.apply(Reflect.get(target, key), target, args);
          if (key === 'create') afterCreate?.();
          return result;
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('ensurePostingJob local Firestore', () => {
  test('creates exactly the fixed ready shape and preserves parent/settings/results', async () => {
    await fixture(async (ref) => {
      const before = await unchangedInputs(ref);
      expect(await run(ref)).toEqual({ status: 'created' });
      expect((await job(ref).get()).data()).toEqual({
        goalId, date, linkRevision: 1, createdAt: cutoff,
        post: buildMissedStudyPost({ goalId, date, dailyResults: [{ goalId, date, metMin: false }] }),
        attempt: 0, status: 'ready', nextAt: cutoff, lastClaimId: null,
      });
      expect(await unchangedInputs(ref)).toEqual(before);
    });
  });

  test('concurrent requests produce one created and one existing', async () => {
    await fixture(async (ref) => {
      const results = await Promise.all([run(ref), run(ref)]);
      expect(results.map((result) => result.status).sort()).toEqual(['created', 'existing']);
      expect((await ref.collection('postJobs').get()).size).toBe(1);
    });
  });

  test('existing job is opaque, never rebuilt, returned, or overwritten', async () => {
    await fixture(async (ref) => {
      const stored = { status: 'future-state', post: { text: 'opaque-stored-payload' } };
      await job(ref).set(stored);
      await ref.collection('dailyResults').doc(date).set({ malformed: true });
      await entries(ref, 'settings').doc('1').delete();
      const before = await job(ref).get();
      const events: string[] = [];
      const source = instrument((tx) => observe(tx, events, (target) => {
        if (target instanceof DocumentReference && target.path === job(ref).path) {
          return {
            exists: true,
            data: () => { throw new Error('Existing payload must not be decoded'); },
          };
        }
        return undefined;
      }));
      expect(await run(ref, source)).toEqual({ status: 'existing' });
      const after = await job(ref).get();
      expect(after.data()).toEqual(stored);
      expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
      expect(events).not.toContain(`read:${ref.path}/dailyResults/${date}`);
      expect(events).not.toContain('query');
    });
  });

  test('N includes old goals this month; M includes this goal across months; overlap dedupes', async () => {
    await fixture(async (ref) => {
      const rows = [
        { date: '2026-09-30', goalId, metMin: false },
        { date: '2026-10-01', goalId: 'old-goal', metMin: false },
        { date: '2026-10-02', goalId, metMin: false },
        { date: '2026-10-03', goalId, metMin: true },
        { date: '2026-10-26', goalId, metMin: false },
      ];
      for (const row of rows) {
        await ref.collection('dailyResults').doc(row.date).set(pending({
          goalId: row.goalId, metMin: row.metMin,
          postStatus: row.metMin ? 'none' : 'skipped',
          postSkipReasons: row.metMin ? [] : ['x_post_disabled'],
        }));
      }
      expect(await run(ref)).toEqual({ status: 'created' });
      const post = (await job(ref).get()).get('post');
      expect(post.counts).toEqual({ monthlyMissedDays: 3, totalMissedDays: 3 });
      expect(post.text).toContain('#今月3回目\n#累計3回目');
    });
  });

  test('missing result and valid nonpending results return no_pending without writes', async () => {
    await fixture(async (ref) => {
      const result = ref.collection('dailyResults').doc(date);
      await result.delete();
      expect(await run(ref)).toEqual({ status: 'no_pending' });
      for (const postStatus of ['none', 'posted', 'failed', 'skipped']) {
        await result.set(pending({
          postStatus, metMin: postStatus === 'none',
          postSkipReasons: postStatus === 'skipped' ? ['start_date'] : [],
        }));
        const before = await unchangedInputs(ref);
        expect(await run(ref)).toEqual({ status: 'no_pending' });
        expect(await unchangedInputs(ref)).toEqual(before);
        expect((await job(ref).get()).exists).toBe(false);
      }
    });
  });

  test('malformed pending shape is rejected without raw values or writes', async () => {
    await fixture(async (ref) => {
      const patches: Record<string, unknown>[] = [
        { metMin: true }, { metMin: 'false' }, { metGoal: true }, { metGoal: null },
        { studiedMinutes: -1 }, { studiedMinutes: 0.5 }, { studiedMinutes: '12' },
        { goalId: '' }, { goalId: ' ' }, { goalId: '../unsafe' },
        { goalId: '__reserved__' }, { postSkipReasons: ['start_date'] },
        { postSkipReasons: null }, { postSkipReasons: {} },
      ];
      for (const patch of patches) {
        await ref.collection('dailyResults').doc(date).set(pending(patch));
        const before = await unchangedInputs(ref);
        await invalid(() => run(ref));
        expect((await job(ref).get()).exists).toBe(false);
        expect(await unchangedInputs(ref)).toEqual(before);
      }
      const raw = `invalid-status-${randomUUID()}`;
      await ref.collection('dailyResults').doc(date).set(pending({ postStatus: raw }));
      await invalid(() => run(ref), raw);
    });
  });

  test('missing required result fields are errors rather than no_pending', async () => {
    await fixture(async (ref) => {
      for (const field of ['goalId', 'studiedMinutes', 'metMin', 'metGoal', 'postStatus', 'postSkipReasons']) {
        const value: Record<string, unknown> = pending();
        delete value[field];
        await ref.collection('dailyResults').doc(date).set(value);
        await invalid(() => run(ref));
        expect((await job(ref).get()).exists).toBe(false);
      }
    });
  });

  test('malformed historical date/goal/metMin is not omitted from counts', async () => {
    await fixture(async (ref) => {
      const collection = ref.collection('dailyResults');
      for (const patch of [{ goalId: '' }, { goalId: '../bad' }, { metMin: 'false' }]) {
        await collection.doc('2026-10-02').set(pending(patch));
        await invalid(() => run(ref));
        expect((await job(ref).get()).exists).toBe(false);
      }
      await collection.doc('2026-10-02').delete();
      await collection.doc('2026-10-00').set(pending());
      await invalid(() => run(ref));
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('missing parent maps only to noAccount and does not recreate it', async () => {
    await fixture(async (ref) => {
      await ref.delete();
      expect(await run(ref)).toEqual({ status: 'noAccount' });
      expect((await ref.get()).exists).toBe(false);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('deleting parent blocks even when an existing child job remains', async () => {
    await fixture(async (ref) => {
      await job(ref).set({ status: 'ready' });
      await ref.update({ deletionInProgress: true });
      const before = await job(ref).get();
      expect(await run(ref)).toEqual({ status: 'deleting' });
      expect((await job(ref).get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
    });
  });

  test('beforeCoverage returns without a job or other writes', async () => {
    await fixture(async (ref) => {
      await ref.set({ xPostEnabled: true, xLinked: true, subscription: null });
      const before = await unchangedInputs(ref);
      expect(await run(ref)).toEqual({ status: 'beforeCoverage' });
      expect(await unchangedInputs(ref)).toEqual(before);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('unauthorized at cutoff remains cancelled even after enabling', async () => {
    await fixture(async (ref) => {
      await entries(ref, 'settings').doc('1').set({
        schemaVersion: 1, revision: 1, committedAt: startedAt,
        before: { xPostEnabled: false }, after: { xPostEnabled: false },
      });
      await history(ref, 'settings', [{ before: false, after: true }]);
      const before = await unchangedInputs(ref);
      expect(await run(ref)).toEqual({ status: 'cancelled', reason: 'not_authorized_at_cutoff' });
      expect(await unchangedInputs(ref)).toEqual(before);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('OFF then ON does not revive the pending date or persist cancellation here', async () => {
    await fixture(async (ref) => {
      await history(ref, 'settings', [
        { before: true, after: false }, { before: false, after: true },
      ]);
      const before = await unchangedInputs(ref);
      expect(await run(ref)).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
      expect(await run(ref)).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
      expect(await unchangedInputs(ref)).toEqual(before);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('true to true relink cancels without creating a job', async () => {
    await fixture(async (ref) => {
      await history(ref, 'xLink', [{ before: true, after: true }]);
      const before = await unchangedInputs(ref);
      expect(await run(ref)).toEqual({ status: 'cancelled', reason: 'link_changed' });
      expect(await unchangedInputs(ref)).toEqual(before);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('missing consent history is an error, not a normal cancellation', async () => {
    await fixture(async (ref) => {
      await entries(ref, 'settings').doc('1').delete();
      const before = await unchangedInputs(ref);
      await invalid(() => run(ref));
      expect(await unchangedInputs(ref)).toEqual(before);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });

  test('unsafe UID and invalid date are rejected before constructing SDK paths', async () => {
    const doc = jest.fn(() => { throw new Error('Unexpected path construction'); });
    const runTransaction = jest.fn();
    const source = { doc, runTransaction } as unknown as Firestore;
    for (const uid of ['', ' ', '../other', 'a/b', '.', '..', '__reserved__', '\ud800', 'a'.repeat(129)]) {
      await invalid(() => ensurePostingJob(uid, date, { db: source, now: clock }));
    }
    for (const day of ['', '../other', '2026-02-30', '2026-1-01', '2026-10-25/other']) {
      await invalid(() => ensurePostingJob('safe-uid', day, { db: source, now: clock }));
    }
    expect(doc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  test('trusted now must be a safe SDK millisecond at or after canonical JST cutoff', async () => {
    await fixture(async (ref) => {
      for (const now of [cutoff - 1, cutoff + 0.5, NaN, Infinity, -Infinity, 253402300800000, Number.MAX_SAFE_INTEGER]) {
        await invalid(() => run(ref, db, () => now));
        expect((await job(ref).get()).exists).toBe(false);
      }
      expect(await run(ref, db, () => cutoff)).toEqual({ status: 'created' });
    });
  });

  test('transaction callback replay does not extend createdAt or nextAt by rereading now', async () => {
    await fixture(async (ref) => {
      const retry = new Error('synthetic callback replay');
      const source = {
        doc: (path: string) => db.doc(path),
        runTransaction: async (callback: (tx: Transaction) => Promise<unknown>) => {
          try {
            await db.runTransaction(async (tx) => {
              await callback(tx);
              throw retry;
            });
          } catch (error) {
            if (error !== retry) throw error;
          }
          return db.runTransaction(callback);
        },
      } as unknown as Firestore;
      const now = jest.fn().mockReturnValueOnce(cutoff).mockReturnValue(cutoff + 300000);
      expect(await run(ref, source, now)).toEqual({ status: 'created' });
      expect(now).toHaveBeenCalledTimes(1);
      expect((await job(ref).get()).get('createdAt')).toBe(cutoff);
      expect((await job(ref).get()).get('nextAt')).toBe(cutoff);
    });
  });

  test('SDK failure after scheduling create propagates unchanged and rolls back all writes', async () => {
    await fixture(async (ref) => {
      const failure = Object.assign(new Error('synthetic SDK failure'), { code: 14 });
      const before = await unchangedInputs(ref);
      const source = instrument(
        (tx) => observe(tx, [], undefined, () => { throw failure; }),
        { maxAttempts: 1 },
      );
      await expect(run(ref, source)).rejects.toBe(failure);
      expect((await job(ref).get()).exists).toBe(false);
      expect(await unchangedInputs(ref)).toEqual(before);
    });
  });

  test('parent guard, all history/count reads and sole create use the same transaction', async () => {
    await fixture(async (ref) => {
      const events: string[] = [];
      const queries: Query[] = [];
      const transactions: Transaction[] = [];
      const guard = jest.spyOn(accountGuard, 'getWritableAccount');
      try {
        const source = instrument((tx) => {
          const observed = observe(tx, events, (target) => {
            if (!(target instanceof DocumentReference)) queries.push(target);
            return undefined;
          });
          transactions.push(observed);
          return observed;
        });
        expect(await run(ref, source)).toEqual({ status: 'created' });
        expect(guard).toHaveBeenCalledWith(transactions[transactions.length - 1], expect.any(DocumentReference));
        expect(events).toContain(`read:${ref.path}`);
        expect(events.filter((event) => ['create', 'set', 'update', 'delete'].includes(event))).toEqual(['create']);
        expect(events[events.length - 1]).toBe('create');
        const daily = ref.collection('dailyResults');
        const expected = [
          daily.where('goalId', '==', goalId),
          daily.where(FieldPath.documentId(), '>=', '2026-10-01')
            .where(FieldPath.documentId(), '<=', date),
        ];
        for (const query of expected) {
          expect(queries.some((actual) => actual.isEqual(query))).toBe(true);
        }
      } finally {
        guard.mockRestore();
      }
    });
  });

  test('foreign-owner or noncanonical history document paths are rejected', async () => {
    await fixture(async (ref) => {
      const daily = ref.collection('dailyResults');
      const query = daily.where('goalId', '==', goalId);
      const otherUid = `unwritten-owner-${randomUUID()}`;
      const invalidRefs = [
        db.doc(`users/${otherUid}/dailyResults/2026-10-02`),
        ref.collection('otherResults').doc('2026-10-02'),
      ];
      for (const invalidRef of invalidRefs) {
        const source = instrument((tx) => observe(tx, [], (target) => {
          if (!(target instanceof DocumentReference) && target.isEqual(query)) {
            return {
              docs: [{ id: '2026-10-02', ref: invalidRef, data: () => pending() }],
              empty: false, size: 1,
            };
          }
          return undefined;
        }));
        await invalid(() => run(ref, source), otherUid);
        expect((await job(ref).get()).exists).toBe(false);
      }
    });
  });

  test('unexpected parent-read SDK error is not mapped to missing/deleting', async () => {
    await fixture(async (ref) => {
      const failure = Object.assign(new Error('synthetic parent read failure'), { code: 14 });
      const source = instrument((tx) => observe(tx, [], (target) => {
        if (target instanceof DocumentReference && target.path === ref.path) throw failure;
        return undefined;
      }), { maxAttempts: 1 });
      await expect(run(ref, source)).rejects.toBe(failure);
      expect((await job(ref).get()).exists).toBe(false);
    });
  });
});
