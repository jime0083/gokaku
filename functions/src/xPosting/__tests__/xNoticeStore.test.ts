import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';

import * as accountGuard from '../../account/accountWriteGuard';
import { acknowledgeXNotice } from '../xNoticeStore';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(host)
  || Number(host.split(':')[1]) > 65535) {
  throw new Error('xNoticeStore tests require local demo-gokaku Firestore Emulator');
}
const app = initializeApp({ projectId: 'demo-gokaku' }, `x-notice-store-${randomUUID()}`);
const db = getFirestore(app);
const ID = 'a'.repeat(64);
const NOW = Date.UTC(2026, 9, 27, 3);
const notice = () => ({
  schemaVersion: 1, id: ID, date: '2026-10-26', linkRevision: 1,
  kind: 'post_failed', readAt: null,
});
const owned = new Set<string>();
async function user(extra: Record<string, unknown> = {}) {
  const uid = `notice-store-${randomUUID()}`;
  owned.add(uid);
  const ref = db.doc(`users/${uid}`);
  await ref.create({ xNotice: notice(), preserved: { count: 7 }, ...extra });
  return ref;
}
afterEach(async () => {
  jest.restoreAllMocks();
  try {
    await Promise.all([...owned].map((uid) => db.recursiveDelete(db.doc(`users/${uid}`))));
  } finally { owned.clear(); }
});
afterAll(async () => {
  try { await db.terminate(); } finally { await deleteApp(app); }
});

test.each(['post_failed', 'unknown_post', 'relink_required'] as const)('acknowledges %s once and preserves all other data', async (kind) => {
  const initial = { ...notice(), kind };
  const ref = await user({ xNotice: initial });
  const other = await user();
  const otherBefore = await other.get();
  const now = jest.fn(() => NOW);
  await expect(acknowledgeXNotice(db, ref.id, ID, now)).resolves.toEqual({ status: 'acknowledged' });
  expect((await ref.get()).data()).toEqual({ xNotice: { ...initial, readAt: NOW }, preserved: { count: 7 } });
  const saved = await ref.get();
  await expect(acknowledgeXNotice(db, ref.id, ID, () => NOW + 100)).resolves.toEqual({ status: 'unchanged' });
  expect((await ref.get()).updateTime).toEqual(saved.updateTime);
  expect((await other.get()).data()).toEqual(otherBefore.data());
  expect((await other.get()).updateTime).toEqual(otherBefore.updateTime);
});

test.each(['absent', 'different-id', 'already-read'] as const)('no writes for %s', async (state) => {
  const ref = await user();
  if (state === 'absent') await ref.set({ preserved: true });
  if (state === 'different-id') await ref.update({ xNotice: { ...notice(), id: 'b'.repeat(64) } });
  if (state === 'already-read') await ref.update({ 'xNotice.readAt': NOW - 1 });
  const before = await ref.get();
  await expect(acknowledgeXNotice(db, ref.id, ID, () => NOW)).resolves.toEqual({ status: 'unchanged' });
  const after = await ref.get();
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime).toEqual(before.updateTime);
});

test.each([
  null, {}, { ...notice(), schemaVersion: 2 }, { ...notice(), id: `${ID}\n` },
  { ...notice(), date: '2026-02-30' }, { ...notice(), linkRevision: 0 },
  { ...notice(), readAt: Number.MAX_SAFE_INTEGER + 1 },
  { ...notice(), kind: 'fixture-private' }, { ...notice(), extra: 'fixture-private' },
])('malformed existing notice rejects atomically even for a stale request: %#', async (xNotice) => {
  const ref = await user({ xNotice });
  const before = await ref.get();
  await expect(acknowledgeXNotice(db, ref.id, 'b'.repeat(64), () => NOW)).rejects.toThrow();
  expect((await ref.get()).data()).toEqual(before.data());
  expect((await ref.get()).updateTime).toEqual(before.updateTime);
});

test.each([NaN, Infinity, -62135596800001, 253402300800000, 1.5, Number.MAX_SAFE_INTEGER])(
  'invalid injected Firestore epoch time cannot be persisted: %s', async (now) => {
    const ref = await user();
    const before = await ref.get();
    await expect(acknowledgeXNotice(db, ref.id, ID, () => now)).rejects.toThrow();
    expect((await ref.get()).data()).toEqual(before.data());
    expect((await ref.get()).updateTime).toEqual(before.updateTime);
  },
);

test.each(['missing', 'deleting'] as const)('rejects %s parent even when there is no notice', async (state) => {
  const ref = await user();
  if (state === 'missing') await ref.delete();
  else await ref.set({ deletionInProgress: true });
  const before = await ref.get();
  await expect(acknowledgeXNotice(db, ref.id, ID, () => NOW))
    .rejects.toMatchObject({ reason: state });
  expect((await ref.get()).data()).toEqual(before.data());
  expect((await ref.get()).exists).toBe(state !== 'missing');
});

test.each(['delete', 'mark-deleting', 'newer-notice'] as const)('in-flight acknowledgement preserves %s', async (action) => {
  const ref = await user();
  let entered!: () => void;
  let release!: () => void;
  const atGuard = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const original = accountGuard.getWritableAccount;
  const spy = jest.spyOn(accountGuard, 'getWritableAccount').mockImplementationOnce(async (tx, target) => {
    entered();
    await paused;
    return original(tx, target);
  });
  const pending = acknowledgeXNotice(db, ref.id, ID, () => NOW);
  const settled = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([
      atGuard,
      settled.then(() => { throw new Error('acknowledgement did not reach transaction account guard'); }),
    ]);
    if (action === 'delete') await ref.delete();
    else if (action === 'mark-deleting') await ref.update({ deletionInProgress: true });
    else await ref.update({ xNotice: { ...notice(), id: 'b'.repeat(64), date: '2026-10-27' } });
    const before = await ref.get();
    release();
    const result = await settled;
    if (action === 'newer-notice') {
      expect(result).toEqual({ ok: true, value: { status: 'unchanged' } });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(accountGuard.AccountWriteBlockedError);
    }
    expect((await ref.get()).data()).toEqual(before.data());
    expect((await ref.get()).updateTime).toEqual(before.updateTime);
  } finally {
    release();
    await settled;
    spy.mockRestore();
  }
});

test('write/network failure preserves unread notice and subsequent acknowledgement is safe', async () => {
  const ref = await user();
  const before = await ref.get();
  const failure = new Error('fixture transport unavailable');
  const original = accountGuard.getWritableAccount;
  const guard = jest.spyOn(accountGuard, 'getWritableAccount').mockImplementationOnce(async (tx, target) => {
    const snapshot = await original(tx, target);
    jest.spyOn(tx, 'update').mockImplementationOnce(() => { throw failure; });
    return snapshot;
  });
  try {
    await expect(acknowledgeXNotice(db, ref.id, ID, () => NOW)).rejects.toBe(failure);
    expect((await ref.get()).data()).toEqual(before.data());
    expect((await ref.get()).updateTime).toEqual(before.updateTime);
  } finally { guard.mockRestore(); }
  await expect(acknowledgeXNotice(db, ref.id, ID, () => NOW + 1)).resolves.toEqual({ status: 'acknowledged' });
  expect((await ref.get()).get('xNotice.readAt')).toBe(NOW + 1);
});

test('transaction replay rereads parent and samples time after each read, using latest callback time', async () => {
  const events: string[] = [];
  const updates: unknown[][] = [];
  let attempt = 0;
  const ref = { path: 'users/replay-owner' };
  const fakeDb = {
    doc: jest.fn(() => ref),
    runTransaction: async (callback: (tx: Transaction) => Promise<unknown>) => {
      let result: unknown;
      for (attempt = 0; attempt < 2; attempt += 1) {
        const tx = {
          get: async (target: unknown) => {
            expect(target).toBe(ref);
            events.push(`read-${attempt}`);
            return {
              exists: true,
              get: (key: string) => key === 'xNotice' ? notice() : undefined,
              data: () => ({ xNotice: notice(), preserved: true }),
            };
          },
          update: (...args: unknown[]) => { events.push(`update-${attempt}`); updates.push(args); return tx; },
        };
        result = await callback(tx as unknown as Transaction);
      }
      return result;
    },
  } as unknown as Firestore;
  const now = jest.fn(() => { events.push(`now-${attempt}`); return NOW + attempt; });
  await expect(acknowledgeXNotice(fakeDb, 'replay-owner', ID, now)).resolves.toEqual({ status: 'acknowledged' });
  expect(events).toEqual(['read-0', 'now-0', 'update-0', 'read-1', 'now-1', 'update-1']);
  expect(now).toHaveBeenCalledTimes(2);
  expect(updates).toHaveLength(2);
  const finalPatch = updates[1][1];
  expect([
    { 'xNotice.readAt': NOW + 1 },
    { xNotice: { ...notice(), readAt: NOW + 1 } },
  ]).toContainEqual(finalPatch);
});
