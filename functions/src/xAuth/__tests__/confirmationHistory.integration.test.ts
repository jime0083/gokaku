import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';

import type { XNotice } from '../../domain';
import { createCandidateStore } from '../candidateStore';
import { encrypt } from '../crypto';

const NOW = Date.UTC(2026, 9, 23);
const KEY = randomBytes(32).toString('base64');
const ID = 'confirmation-history';
const FAILURE = 'X auth candidate operation failed';

function makeNotice(patch: Partial<Omit<XNotice, 'schemaVersion' | 'id'>> = {}): XNotice {
  const fields: Omit<XNotice, 'schemaVersion' | 'id'> = {
    date: '2026-10-22', linkRevision: 1, kind: 'relink_required', readAt: null, ...patch,
  };
  return {
    schemaVersion: 1,
    id: createHash('sha256').update(JSON.stringify([
      fields.date, 'confirmation-goal', fields.linkRevision, fields.kind,
    ]), 'utf8').digest('hex'),
    ...fields,
  };
}

describe('confirmation history with real local Firestore', () => {
  let db: Firestore;
  let uid: string;

  beforeAll(() => {
    if (
      process.env.GCLOUD_PROJECT !== 'demo-gokaku' ||
      !/^(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(
        process.env.FIRESTORE_EMULATOR_HOST ?? '',
      )
    ) {
      throw new Error('Local demo-gokaku Firestore Emulator required');
    }
    db = new Firestore({ projectId: 'demo-gokaku' });
  });

  function userRef() { return db.doc(`users/${uid}`); }
  function tokenRef() { return db.doc(`xTokens/${uid}`); }
  function entryRef(stream: string, revision = 2) {
    return db.doc(
      `users/${uid}/judgementHistory/${stream}/entries/${revision}`,
    );
  }
  function store() {
    return createCandidateStore({
      firestore: db, now: () => NOW, encryptionKey: KEY,
    });
  }

  beforeEach(async () => {
    uid = `confirmation-history-${randomUUID()}`;
    await userRef().create({
      xLinked: false, xPostEnabled: true, xUsername: 'old_user',
      subscription: null, deletionInProgress: false, unrelated: 'keep',
      judgementHistoryStartedAt: Timestamp.fromMillis(NOW - 1000),
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    });
    await tokenRef().create({
      encryptedAccessToken: 'synthetic-old-access',
      encryptedRefreshToken: 'synthetic-old-refresh',
      xUserId: '100',
      confirmedLink: { candidateId: 'previous', postEnabled: true },
      oauthStates: { untouched: true },
      pendingLink: {
        candidateId: ID,
        encryptedAccessToken: encrypt('synthetic-new-access', KEY, {
          uid, purpose: 'accessToken',
        }),
        encryptedRefreshToken: encrypt('synthetic-new-refresh', KEY, {
          uid, purpose: 'refreshToken',
        }),
        expiresAt: Timestamp.fromMillis(NOW + 60000),
        scope: 'tweet.read tweet.write users.read offline.access',
        profile: { id: '200', username: 'new_user', profileImageUrl: null },
      },
    });
  });

  afterEach(async () => {
    if (!db || !uid) return;
    try {
      await tokenRef().delete();
    } finally {
      await db.recursiveDelete(userRef());
    }
  });

  afterAll(async () => {
    if (db) await db.terminate();
  });

  async function snapshot() {
    return db.runTransaction(async (tx) => {
      const docs = await tx.getAll(
        userRef(), tokenRef(), entryRef('settings'), entryRef('xLink'),
      );
      return docs.map((doc) => ({
        data: doc.data(), updateTime: doc.updateTime,
      }));
    }, { readOnly: true });
  }

  it.each([false, true])(
    'atomically saves minimal history and actual patch for postEnabled=%s',
    async (postEnabled) => {
      await userRef().update({ xNotice: makeNotice() });
      const old = await snapshot();
      const pending = old[1].data!.pendingLink;
      await store().confirm(uid, ID, postEnabled);
      const [user, token, settings, xLink] = await snapshot();
      expect(user.data).toEqual({
        ...old[0].data,
        xLinked: true, xUsername: 'new_user', xPostEnabled: postEnabled,
        xNotice: { ...makeNotice(), readAt: NOW },
        judgementRevisions: { goal: 1, settings: 2, xLink: 2, subscription: 1 },
      });
      expect(token.data).toEqual({
        encryptedAccessToken: pending.encryptedAccessToken,
        encryptedRefreshToken: pending.encryptedRefreshToken,
        expiresAt: pending.expiresAt,
        scope: pending.scope,
        xUserId: '200',
        confirmedLink: { candidateId: ID, postEnabled },
        oauthStates: { untouched: true },
      });
      const settingsCommittedAt = settings.data!.committedAt;
      const xLinkCommittedAt = xLink.data!.committedAt;
      expect(settingsCommittedAt).toBeInstanceOf(Timestamp);
      expect(xLinkCommittedAt).toBeInstanceOf(Timestamp);
      expect(settingsCommittedAt.isEqual(xLinkCommittedAt)).toBe(true);
      expect(settings.data).toEqual({
        schemaVersion: 1, revision: 2,
        committedAt: settingsCommittedAt,
        before: { xPostEnabled: true },
        after: { xPostEnabled: postEnabled },
      });
      expect(xLink.data).toEqual({
        schemaVersion: 1, revision: 2,
        committedAt: settingsCommittedAt,
        before: { xLinked: false }, after: { xLinked: true },
      });
      for (const row of [token, settings, xLink]) {
        expect(row.updateTime!.isEqual(user.updateTime!)).toBe(true);
      }
      expect((await entryRef('goal').get()).exists).toBe(false);
      expect((await entryRef('subscription').get()).exists).toBe(false);
    },
  );

  it('uses current stored values and counters after store creation', async () => {
    const candidateStore = store();
    await userRef().update({
      xLinked: true, xPostEnabled: false,
      'judgementRevisions.settings': 4,
      'judgementRevisions.xLink': 6,
      xNotice: makeNotice({ linkRevision: 6 }),
    });
    await candidateStore.confirm(uid, ID, true);
    expect((await userRef().get()).get('xNotice')).toEqual({
      ...makeNotice({ linkRevision: 6 }), readAt: NOW,
    });
    expect((await entryRef('settings', 5).get()).data()).toMatchObject({
      revision: 5, before: { xPostEnabled: false }, after: { xPostEnabled: true },
    });
    expect((await entryRef('xLink', 7).get()).data()).toMatchObject({
      revision: 7, before: { xLinked: true }, after: { xLinked: true },
    });
    expect((await entryRef('settings').get()).exists).toBe(false);
    expect((await entryRef('xLink').get()).exists).toBe(false);
  });

  it.each([
    { name: 'ordinary failure', notice: makeNotice({ kind: 'post_failed' }) },
    { name: 'unknown posting', notice: makeNotice({ kind: 'unknown_post' }) },
    { name: 'already acknowledged', notice: makeNotice({ readAt: NOW - 100 }) },
    { name: 'equal confirmed revision', notice: makeNotice({ linkRevision: 2 }) },
    { name: 'newer revision', notice: makeNotice({ linkRevision: 3 }) },
    { name: 'absent', notice: undefined },
  ])('preserves $name notice while confirming a new candidate', async ({ notice }) => {
    if (notice !== undefined) await userRef().update({ xNotice: notice });
    const before = await snapshot();
    await store().confirm(uid, ID, true);
    const [user, token, settings, xLink] = await snapshot();
    expect(user.data).toEqual({
      ...before[0].data,
      xLinked: true, xUsername: 'new_user', xPostEnabled: true,
      judgementRevisions: { goal: 1, settings: 2, xLink: 2, subscription: 1 },
    });
    expect(token.data!.confirmedLink).toEqual({ candidateId: ID, postEnabled: true });
    expect(token.data!.oauthStates).toEqual(before[1].data!.oauthStates);
    expect(token.data!.pendingLink).toBeUndefined();
    expect(settings.data!.revision).toBe(2);
    expect(xLink.data!.revision).toBe(2);
  });

  it.each([
    null,
    { ...makeNotice(), unexpected: 'synthetic-private-notice' },
    { ...makeNotice(), readAt: 'synthetic-private-notice' },
  ])('malformed prior notice fails closed and rolls back linkage, counters and history (%#)', async (xNotice) => {
    await userRef().update({ xNotice });
    const before = await snapshot();
    const error: unknown = await store().confirm(uid, ID, false).then(
      () => undefined, (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(FAILURE);
    expect((error as Error).cause).toBeUndefined();
    expect(Object.keys(error as Error)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('discarding a pending candidate preserves the unread notice, parent and history', async () => {
    await userRef().update({ xNotice: makeNotice() });
    const before = await snapshot();
    await store().discard(uid, ID);
    const after = await snapshot();
    expect(after[0]).toEqual(before[0]);
    expect(after.slice(2)).toEqual(before.slice(2));
    const expectedToken = { ...before[1].data! };
    delete expectedToken.pendingLink;
    expect(after[1].data).toEqual(expectedToken);
    await store().discard(uid, ID);
    expect(await snapshot()).toEqual(after);
  });

  it('a replayed callback rereads notice and revision and samples its own trusted time', async () => {
    await userRef().update({ xNotice: makeNotice() });
    const original = await snapshot();
    const rollback = new Error('controlled confirmation callback rollback');
    const replacement = makeNotice({ linkRevision: 5, date: '2026-10-23' });
    let callbacks = 0;
    const replayDb = {
      doc: (path: string) => db.doc(path),
      runTransaction: async <T>(callback: Parameters<Firestore['runTransaction']>[0]): Promise<T> => {
        try {
          await db.runTransaction(async (tx) => {
            callbacks += 1;
            await callback(tx);
            throw rollback;
          }, { maxAttempts: 1 });
          throw new Error('Expected controlled rollback');
        } catch (error) {
          if (error !== rollback) throw error;
        }
        expect(await snapshot()).toEqual(original);
        await userRef().update({
          xNotice: replacement, 'judgementRevisions.xLink': 5,
        });
        return db.runTransaction(async (tx) => {
          callbacks += 1;
          return await callback(tx) as T;
        }, { maxAttempts: 1 });
      },
    } as unknown as Firestore;
    const now = jest.fn(() => NOW + callbacks);
    await createCandidateStore({ firestore: replayDb, now, encryptionKey: KEY })
      .confirm(uid, ID, false);
    expect(callbacks).toBe(2);
    expect(now).toHaveBeenCalledTimes(2);
    expect((await userRef().get()).get('xNotice')).toEqual({
      ...replacement, readAt: NOW + 2,
    });
    expect((await userRef().get()).get('judgementRevisions.xLink')).toBe(6);
    expect((await entryRef('xLink', 6).get()).get('revision')).toBe(6);
    expect((await entryRef('xLink', 2).get()).exists).toBe(false);
    expect((await tokenRef().get()).get('confirmedLink')).toEqual({
      candidateId: ID, postEnabled: false,
    });
  });

  it('legacy confirmation does not invent a revision to acknowledge an existing notice', async () => {
    await userRef().set({
      xLinked: true, xPostEnabled: true, xUsername: 'old_user', xNotice: makeNotice(),
    });
    await store().confirm(uid, ID, false);
    expect((await userRef().get()).data()).toEqual({
      xLinked: true, xPostEnabled: false, xUsername: 'new_user', xNotice: makeNotice(),
    });
    expect((await entryRef('settings').get()).exists).toBe(false);
    expect((await entryRef('xLink').get()).exists).toBe(false);
  });

  it('keeps legacy saves without creating metadata or entries', async () => {
    await userRef().set({
      xLinked: false, xPostEnabled: true, xUsername: 'old_user',
    });
    await store().confirm(uid, ID, false);
    expect((await userRef().get()).data()).toEqual({
      xLinked: true, xPostEnabled: false, xUsername: 'new_user',
    });
    expect((await entryRef('settings').get()).exists).toBe(false);
    expect((await entryRef('xLink').get()).exists).toBe(false);
  });

  it('returns on identical receipt before history validation or newer pending checks', async () => {
    await store().confirm(uid, ID, false);
    const current = (await userRef().get()).data()!;
    // Later metadata damage must not turn a successful receipt into a new write.
    delete current.judgementHistoryStartedAt;
    await userRef().set({ ...current, xPostEnabled: true, xNotice: makeNotice() });
    await tokenRef().update({ pendingLink: { candidateId: 'newer' } });
    const later = await snapshot();
    await store().confirm(uid, ID, false);
    expect(await snapshot()).toEqual(later);
    await expect(store().confirm(uid, ID, true)).rejects.toThrow(FAILURE);
    expect(await snapshot()).toEqual(later);
  });

  it.each([
    'missing-start', 'missing-counters', 'missing-counter',
    'invalid-start', 'missing-setting', 'missing-link',
    'missing-subscription', 'deleting',
    'occupied-settings', 'occupied-xLink', 'missing-profile',
  ])('rejects %s without replacing old linkage or partial writes', async (state) => {
    const user = (await userRef().get()).data()!;
    user.xNotice = makeNotice();
    if (state === 'missing-start') delete user.judgementHistoryStartedAt;
    if (state === 'missing-counters') delete user.judgementRevisions;
    if (state === 'missing-counter') delete user.judgementRevisions.subscription;
    if (state === 'invalid-start') user.judgementHistoryStartedAt = NOW;
    if (state === 'missing-setting') delete user.xPostEnabled;
    if (state === 'missing-link') delete user.xLinked;
    if (state === 'missing-subscription') delete user.subscription;
    if (state === 'deleting') user.deletionInProgress = true;
    await userRef().set(user);
    if (state === 'occupied-settings') {
      await entryRef('settings').create({ occupied: true });
    }
    if (state === 'occupied-xLink') {
      await entryRef('xLink').create({ occupied: true });
    }
    if (state === 'missing-profile') {
      const token = (await tokenRef().get()).data()!;
      delete token.pendingLink.profile;
      await tokenRef().set(token);
    }
    const before = await snapshot();
    await expect(store().confirm(uid, ID, false)).rejects.toThrow(FAILURE);
    expect(await snapshot()).toEqual(before);
  });
});
