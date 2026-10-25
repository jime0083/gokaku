import { randomUUID } from 'node:crypto';

import { NotificationTypeV2, type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import { getApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp,
  type DocumentData, type DocumentReference, type Firestore,
} from 'firebase-admin/firestore';

import { AccountWriteBlockedError } from '../account/accountWriteGuard';
import {
  handleAppleServerNotification, type AppleServerNotificationDeps,
} from '../applePurchase/appleServerNotification';
import { type AppleStatusResponseLike } from '../applePurchase/verifyApplePurchase';
import { ServerHistoryError } from '../dailyJudgement/serverHistory';
import { MONTHLY_PRODUCT_ID } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';

const NOW = Date.UTC(2026, 9, 25, 3);
const DAY = 86_400_000;
const EXPIRY = NOW + 10 * DAY;
const START = new Timestamp(100, 123);
const streams = ['goal', 'settings', 'xLink', 'subscription'] as const;
const counters = () => ({ goal: 2, settings: 3, xLink: 4, subscription: 5 });
const ownedRefs = new Set<DocumentReference>();
let db: Firestore;

type State = {
  user: DocumentData | undefined;
  updateTime: Timestamp | undefined;
  history: Record<string, { data: DocumentData; updateTime: Timestamp | undefined }>;
  owner: DocumentData | undefined;
  ownerUpdateTime: Timestamp | undefined;
};

beforeAll(() => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
    || !/^(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(host)
    || Number(host.split(':')[1]) > 65535) {
    throw new Error('notificationHistory requires demo-gokaku and a loopback Firestore Emulator with a valid port');
  }
  ensureAdminApp();
  if ((getApp().options.projectId ?? process.env.GCLOUD_PROJECT) !== 'demo-gokaku') {
    throw new Error('Unexpected Firestore project');
  }
  db = getFirestore();
});

afterEach(async () => {
  const results = await Promise.allSettled([...ownedRefs].map((ref) => db.recursiveDelete(ref)));
  ownedRefs.clear();
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures, 'notification history cleanup failed');
});

async function seed() {
  const user = db.doc(`users/notification-history-${randomUUID()}`);
  const originalTransactionId = `original-${randomUUID()}`;
  const owner = db.doc(`appleSubscriptions/${originalTransactionId}`);
  // Register before setup so partial setup and failed assertions are cleaned up.
  ownedRefs.add(user);
  ownedRefs.add(owner);
  const batch = db.batch();
  batch.create(user, {
    judgementHistoryStartedAt: START, judgementRevisions: counters(),
    subscription: null, xPostEnabled: false, xLinked: true,
    checkEnabled: true, activeGoalId: null,
  });
  batch.create(owner, { uid: user.id, productId: MONTHLY_PRODUCT_ID, environment: 'SANDBOX' });
  const snapshots = {
    goal: null, settings: { xPostEnabled: false }, xLink: { xLinked: true }, subscription: null,
  };
  for (const stream of streams) {
    const revision = counters()[stream];
    batch.create(user.collection(`judgementHistory/${stream}/entries`).doc(String(revision)), {
      schemaVersion: 1, revision, committedAt: START,
      before: snapshots[stream], after: snapshots[stream],
    });
  }
  await batch.commit();
  return { user, owner, originalTransactionId };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function readState(fixture: Fixture): Promise<State> {
  const user = await fixture.user.get();
  const owner = await fixture.owner.get();
  const history: State['history'] = {};
  for (const stream of streams) {
    const entries = await fixture.user.collection(`judgementHistory/${stream}/entries`).get();
    for (const entry of entries.docs) {
      history[entry.ref.path] = { data: entry.data(), updateTime: entry.updateTime };
    }
  }
  return {
    user: user.data(), updateTime: user.updateTime, history,
    owner: owner.data(), ownerUpdateTime: owner.updateTime,
  };
}

function apple(fixture: Fixture, latest: JWSTransactionDecodedPayload = { expiresDate: EXPIRY }) {
  // Synthetic strings only: no Apple client, signing key, certificate or real JWS.
  const notificationTransaction = 'fixture-notification-transaction';
  const latestTransaction = 'fixture-latest-transaction';
  const notification = {
    notificationType: NotificationTypeV2.DID_RENEW,
    notificationUUID: randomUUID(),
    data: { environment: 'Sandbox', signedTransactionInfo: notificationTransaction },
  };
  const body = { signedPayload: [
    'fixture', Buffer.from(JSON.stringify(notification)).toString('base64url'), 'fixture',
  ].join('.') };
  const response: AppleStatusResponseLike = { data: [{ lastTransactions: [{
    originalTransactionId: fixture.originalTransactionId, signedTransactionInfo: latestTransaction,
  }] }] };
  const client = {
    getTransactionInfo: jest.fn(async () => { throw new Error('Unexpected transaction lookup'); }),
    getAllSubscriptionStatuses: jest.fn(async (_id: string) => response),
  };
  const verifier = {
    verifyAndDecodeNotification: jest.fn(async (_payload: string) => notification),
    verifyAndDecodeTransaction: jest.fn(async (signed: string): Promise<JWSTransactionDecodedPayload> => {
      if (signed === notificationTransaction) {
        // Deliberately stale: only the mocked API's latest transaction may set expiry.
        return { originalTransactionId: fixture.originalTransactionId,
          productId: MONTHLY_PRODUCT_ID, expiresDate: EXPIRY + DAY };
      }
      if (signed === latestTransaction) return { productId: MONTHLY_PRODUCT_ID, ...latest };
      throw new Error('Unexpected synthetic JWS');
    }),
  };
  const deps = {
    createApiClient: jest.fn((environment) => {
      if (environment !== 'SANDBOX') throw new Error('Unexpected environment');
      return client;
    }),
    createVerifier: jest.fn((environment) => {
      if (environment !== 'SANDBOX') throw new Error('Unexpected environment');
      return verifier;
    }),
    now: jest.fn(() => NOW),
  } satisfies AppleServerNotificationDeps;
  return { body, deps, client, verifier, response };
}

async function assertSaved(fixture: Fixture, before: State, expiresAt: number, now = NOW) {
  const after = await readState(fixture);
  const revision = before.user!.judgementRevisions.subscription + 1;
  const path = `${fixture.user.path}/judgementHistory/subscription/entries/${revision}`;
  const entry = after.history[path];
  expect(entry).toBeDefined();
  expect(entry.data).toEqual({
    schemaVersion: 1, revision, committedAt: expect.any(Timestamp),
    before: before.user!.subscription === null ? null : { expiresAt: before.user!.subscription.expiresAt },
    after: { expiresAt },
  });
  expect(entry.data.committedAt.isEqual(START)).toBe(false);
  expect(entry.data.committedAt.isEqual(Timestamp.fromMillis(now))).toBe(false);
  expect(after.user).toEqual({
    ...before.user,
    subscription: {
      status: now < expiresAt ? 'active' : 'expired', productId: MONTHLY_PRODUCT_ID,
      expiresAt, originalTransactionId: fixture.originalTransactionId, environment: 'SANDBOX',
    },
    judgementRevisions: { ...before.user!.judgementRevisions, subscription: revision },
  });
  expect(after.history).toEqual({ ...before.history, [path]: entry });
  expect(after.owner).toEqual(before.owner);
  expect(after.ownerUpdateTime).toEqual(before.ownerUpdateTime);
  // P-125: document updateTime is compared only with document updateTime.
  expect(after.updateTime).toBeInstanceOf(Timestamp);
  expect(entry.updateTime).toBeInstanceOf(Timestamp);
  expect(entry.updateTime!.isEqual(after.updateTime!)).toBe(true);
  return after;
}

describe('7-2 Apple notification to real subscription history', () => {
  test('通知coreから最小snapshot・counter・契約を同一commitで保存する', async () => {
    const fixture = await seed();
    const before = await readState(fixture);
    const mock = apple(fixture);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({ outcome: 'ok' });
    await assertSaved(fixture, before, EXPIRY);
    expect(mock.client.getAllSubscriptionStatuses).toHaveBeenCalledTimes(1);
    expect(mock.client.getAllSubscriptionStatuses).toHaveBeenCalledWith(fixture.originalTransactionId);
    expect(mock.client.getTransactionInfo).not.toHaveBeenCalled();
    expect(mock.verifier.verifyAndDecodeTransaction.mock.calls).toEqual([
      ['fixture-notification-transaction'], ['fixture-latest-transaction'],
    ]);
  });

  test('同一通知を翌日再送しても最新取得2回・連続revisionを保存し後日のX設定を保持する', async () => {
    const fixture = await seed();
    const mock = apple(fixture);
    const initial = await readState(fixture);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({ outcome: 'ok' });
    const first = await assertSaved(fixture, initial, EXPIRY);
    // Model a later committed settings/xLink change without invoking other save paths.
    const batch = db.batch();
    batch.update(fixture.user, {
      xPostEnabled: true, xLinked: false, checkEnabled: false,
      'judgementRevisions.settings': 4, 'judgementRevisions.xLink': 5,
    });
    for (const [stream, revision, before, after] of [
      ['settings', 4, { xPostEnabled: false }, { xPostEnabled: true }],
      ['xLink', 5, { xLinked: true }, { xLinked: false }],
    ] as const) {
      batch.create(fixture.user.collection(`judgementHistory/${stream}/entries`).doc(String(revision)), {
        schemaVersion: 1, revision, committedAt: Timestamp.fromMillis(NOW + DAY),
        before, after,
      });
    }
    await batch.commit();
    const later = await readState(fixture);
    mock.deps.now.mockReturnValue(NOW + DAY);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({ outcome: 'ok' });
    const replay = await assertSaved(fixture, later, EXPIRY, NOW + DAY);
    expect(first.user!.judgementRevisions.subscription).toBe(6);
    expect(replay.user!.judgementRevisions.subscription).toBe(7);
    const entry = replay.history[`${fixture.user.path}/judgementHistory/subscription/entries/7`].data;
    expect(entry.before).toEqual(entry.after);
    expect(mock.client.getAllSubscriptionStatuses.mock.calls).toEqual([
      [fixture.originalTransactionId], [fixture.originalTransactionId],
    ]);
    expect(mock.verifier.verifyAndDecodeNotification.mock.calls).toEqual([
      [mock.body.signedPayload], [mock.body.signedPayload],
    ]);
    expect(mock.verifier.verifyAndDecodeTransaction).toHaveBeenCalledTimes(4);
  });

  test.each([
    ['期限切れ', { expiresDate: NOW - 1 }, NOW - 1],
    ['返金', { expiresDate: EXPIRY, revocationDate: NOW - 10 }, NOW - 10],
  ] as const)('古い更新通知でも最新APIの%sを保存する', async (_label, latest, expiry) => {
    const fixture = await seed();
    const before = await readState(fixture);
    const mock = apple(fixture, latest);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({ outcome: 'ok' });
    await assertSaved(fixture, before, expiry);
  });

  test('取得中に削除開始したuserと履歴を保存時に保護する', async () => {
    const fixture = await seed();
    const mock = apple(fixture);
    let blocked: State | undefined;
    mock.client.getAllSubscriptionStatuses.mockImplementationOnce(async () => {
      await fixture.user.update({ deletionInProgress: true });
      blocked = await readState(fixture);
      return mock.response;
    });
    await expect(handleAppleServerNotification(mock.body, mock.deps)).rejects.toBeInstanceOf(AccountWriteBlockedError);
    expect(blocked).toBeDefined();
    expect(await readState(fixture)).toEqual(blocked);
  });

  test('partial metadataをlegacyとせずuser・全stream・ownerを維持する', async () => {
    const fixture = await seed();
    await fixture.user.update({ judgementRevisions: { subscription: 5 } });
    const before = await readState(fixture);
    const mock = apple(fixture);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).rejects.toBeInstanceOf(ServerHistoryError);
    expect(mock.client.getAllSubscriptionStatuses).toHaveBeenCalledTimes(1);
    expect(await readState(fixture)).toEqual(before);
  });

  test('次revisionのcreate競合なら契約・counterもrollbackする', async () => {
    const fixture = await seed();
    await fixture.user.collection('judgementHistory/subscription/entries').doc('6').create({ occupiedFixture: true });
    const before = await readState(fixture);
    const mock = apple(fixture);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).rejects.toMatchObject({ code: 6 });
    expect(await readState(fixture)).toEqual(before);
  });

  test.each(['notification', 'latest'] as const)('%s署名拒否時にuserと履歴を維持する', async (stage) => {
    const fixture = await seed();
    const before = await readState(fixture);
    const mock = apple(fixture);
    if (stage === 'notification') {
      mock.verifier.verifyAndDecodeNotification.mockRejectedValueOnce(new Error('Synthetic invalid signature'));
    } else {
      const decode = mock.verifier.verifyAndDecodeTransaction.getMockImplementation()!;
      mock.verifier.verifyAndDecodeTransaction.mockImplementation(async (signed) => {
        if (signed === 'fixture-latest-transaction') throw new Error('Synthetic invalid signature');
        return decode(signed);
      });
    }
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({
      outcome: stage === 'notification' ? 'invalid' : 'unavailable',
    });
    expect(mock.client.getAllSubscriptionStatuses).toHaveBeenCalledTimes(stage === 'notification' ? 0 : 1);
    expect(await readState(fixture)).toEqual(before);
  });

  test('owner未登録なら最新APIへ進まずuserと全履歴を保持する', async () => {
    const fixture = await seed();
    await fixture.owner.delete();
    const before = await readState(fixture);
    const mock = apple(fixture);
    await expect(handleAppleServerNotification(mock.body, mock.deps)).resolves.toEqual({ outcome: 'no-owner' });
    expect(mock.deps.createApiClient).not.toHaveBeenCalled();
    expect(mock.client.getAllSubscriptionStatuses).not.toHaveBeenCalled();
    expect(await readState(fixture)).toEqual(before);
  });
});
