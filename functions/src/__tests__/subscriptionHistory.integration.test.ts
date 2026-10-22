import { randomUUID } from 'node:crypto';

import { getApp } from 'firebase-admin/app';

import {
  getFirestore,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';

import { AccountWriteBlockedError } from '../account/accountWriteGuard';
import {
  fetchAndApplyLatestSubscriptionStatus,
  VerifyApplePurchaseError,
  type AppleStatusResponseLike,
} from '../applePurchase/verifyApplePurchase';
import { ServerHistoryError } from '../dailyJudgement/serverHistory';
import { MONTHLY_PRODUCT_ID } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';

// Real Firestore transactions; Apple API and JWS verification are entirely mocked.
const NOW = Date.UTC(2026, 9, 23, 3);
const EXPIRY = NOW + 86_400_000;
const STARTED_AT = new Timestamp(100, 123);
const counters = () => ({ goal: 2, settings: 3, xLink: 4, subscription: 5 });
const streams = ['goal', 'settings', 'xLink', 'subscription'] as const;
let db: Firestore;
const ownedUsers = new Set<DocumentReference>();

type State = {
  user: DocumentData | undefined;
  updateTime: Timestamp | undefined;
  history: Record<string, { data: DocumentData; updateTime: Timestamp | undefined }>;
};

beforeAll(() => {
  if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
    || !/^(?:localhost|127\.0\.0\.1):[1-9]\d{0,4}$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
    || Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1]) > 65535) {
    throw new Error('subscriptionHistory requires GCLOUD_PROJECT=demo-gokaku and localhost Firestore Emulator');
  }
  ensureAdminApp();
  db = getFirestore();
  if ((getApp().options.projectId ?? process.env.GCLOUD_PROJECT) !== 'demo-gokaku') {
    throw new Error('Unexpected Firestore project');
  }
});

afterEach(async () => {
  // Only this test's unique user trees, including entries created before failure.
  const results = await Promise.allSettled([...ownedUsers].map((ref) => db.recursiveDelete(ref)));
  ownedUsers.clear();
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'subscription history cleanup failed');
});

function currentUser(): DocumentData {
  return {
    judgementHistoryStartedAt: STARTED_AT,
    judgementRevisions: counters(),
    subscription: null,
    xPostEnabled: false,
    xLinked: true,
    checkEnabled: true,
    activeGoalId: null,
  };
}

async function seed(user: DocumentData = currentUser(), baseline = true) {
  const ref = db.doc(`users/subscription-history-${randomUUID()}`);
  ownedUsers.add(ref); // Register before the first write, so setup failure also cleans up.
  const batch = db.batch();
  batch.create(ref, user);
  if (baseline) {
    const snapshots = {
      goal: null,
      settings: { xPostEnabled: false },
      xLink: { xLinked: true },
      subscription: user.subscription === null ? null : { expiresAt: user.subscription?.expiresAt ?? null },
    };
    for (const stream of streams) {
      const revision = counters()[stream];
      batch.create(ref.collection(`judgementHistory/${stream}/entries`).doc(String(revision)), {
        schemaVersion: 1, revision, committedAt: STARTED_AT,
        before: snapshots[stream], after: snapshots[stream],
      });
    }
  }
  await batch.commit();
  return ref;
}

async function readState(ref: DocumentReference): Promise<State> {
  const user = await ref.get();
  const history: State['history'] = {};
  for (const stream of streams) {
    const entries = await ref.collection(`judgementHistory/${stream}/entries`).get();
    for (const entry of entries.docs) {
      history[entry.ref.path] = { data: entry.data(), updateTime: entry.updateTime };
    }
  }
  return { user: user.data(), updateTime: user.updateTime, history };
}

function apple(ref: DocumentReference, decoded = { expiresDate: EXPIRY } as {
  expiresDate?: number;
  revocationDate?: number;
  productId?: string;
}) {
  const originalTransactionId = `original-${ref.id}`;
  const client = {
    getTransactionInfo: jest.fn(async () => { throw new Error('Unexpected transaction lookup'); }),
    getAllSubscriptionStatuses: jest.fn<Promise<AppleStatusResponseLike>, [string]>(async () => ({
      data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: 'mock-jws-never-persist' }] }],
    })),
  };
  const verifier = {
    verifyAndDecodeTransaction: jest.fn(async () => ({ productId: MONTHLY_PRODUCT_ID, ...decoded })),
  };
  return {
    uid: ref.id, originalTransactionId, environment: 'SANDBOX' as const,
    client, verifier, fallbackProductId: MONTHLY_PRODUCT_ID, now: () => NOW,
  };
}

async function assertSaved(
  ref: DocumentReference,
  before: State,
  params: ReturnType<typeof apple>,
  expiresAt: number,
) {
  const after = await readState(ref);
  const revision = before.user!.judgementRevisions.subscription + 1;
  const entryPath = `${ref.path}/judgementHistory/subscription/entries/${revision}`;
  const entry = after.history[entryPath];
  expect(entry).toBeDefined();
  expect(entry.data).toEqual({
    schemaVersion: 1,
    revision,
    committedAt: expect.any(Timestamp),
    before: before.user!.subscription === null ? null : { expiresAt: before.user!.subscription.expiresAt },
    after: { expiresAt },
  });
  // Persisted server transform, independent of injected business time and baseline.
  expect(entry.data.committedAt.isEqual(STARTED_AT)).toBe(false);
  expect(entry.data.committedAt.isEqual(Timestamp.fromMillis(NOW))).toBe(false);
  expect(after.user).toEqual({
    ...before.user,
    subscription: {
      status: NOW < expiresAt ? 'active' : 'expired',
      productId: MONTHLY_PRODUCT_ID, expiresAt,
      originalTransactionId: params.originalTransactionId,
      environment: params.environment,
    },
    judgementRevisions: { ...before.user!.judgementRevisions, subscription: revision },
  });
  expect(after.history).toEqual({ ...before.history, [entryPath]: entry });
  // Atomic commit: compare document update times with each other (P-125).
  // Do not equate serverTimestamp fields with document updateTime.
  expect(after.updateTime).toBeInstanceOf(Timestamp);
  expect(entry.updateTime!.isEqual(after.updateTime!)).toBe(true);
  expect(params.client.getAllSubscriptionStatuses).toHaveBeenCalledWith(params.originalTransactionId);
  expect(params.verifier.verifyAndDecodeTransaction).toHaveBeenCalledWith('mock-jws-never-persist');
  expect(params.client.getTransactionInfo).not.toHaveBeenCalled();
  return after;
}

describe('7-2 subscription common save history', () => {
  test('未購入nullから正常契約を最小payloadと同一commitで保存する', async () => {
    const ref = await seed();
    const before = await readState(ref);
    const params = apple(ref);
    await expect(fetchAndApplyLatestSubscriptionStatus(params)).resolves.toEqual({ status: 'active', expiresAt: EXPIRY });
    await assertSaved(ref, before, params, EXPIRY);
  });

  test('更新は保存時currentをbeforeとし、同値の再確認でも次revisionを作る', async () => {
    const ref = await seed({ ...currentUser(), subscription: {
      expiresAt: NOW - 1, status: 'expired', productId: 'old-fixture-product',
      originalTransactionId: 'old-fixture-id', environment: 'PRODUCTION',
      signedTransaction: 'old-fixture-jws',
    } });
    const before = await readState(ref);
    const params = apple(ref);
    await fetchAndApplyLatestSubscriptionStatus(params);
    const first = await assertSaved(ref, before, params, EXPIRY);
    await fetchAndApplyLatestSubscriptionStatus(params);
    const second = await assertSaved(ref, first, params, EXPIRY);
    const latest = second.history[`${ref.path}/judgementHistory/subscription/entries/7`].data;
    expect(latest.before).toEqual(latest.after);
  });

  test.each([
    ['期限切れ', { expiresDate: NOW - 1 }, NOW - 1],
    ['返金を期限より優先', { expiresDate: EXPIRY, revocationDate: NOW - 10 }, NOW - 10],
  ] as const)('%s の既存expiresAt/status仕様を保つ', async (_label, decoded, expectedExpiry) => {
    const ref = await seed();
    const before = await readState(ref);
    const params = apple(ref, decoded);
    await expect(fetchAndApplyLatestSubscriptionStatus(params)).resolves.toEqual({ status: 'expired', expiresAt: expectedExpiry });
    await assertSaved(ref, before, params, expectedExpiry);
  });

  test('両metadata absentのlegacyは従来の保存だけを行いbaselineを作らない', async () => {
    const ref = await seed({ checkEnabled: true }, false);
    const params = apple(ref);
    await fetchAndApplyLatestSubscriptionStatus(params);
    expect(await readState(ref)).toEqual({
      user: { checkEnabled: true, subscription: {
        status: 'active', productId: MONTHLY_PRODUCT_ID, expiresAt: EXPIRY,
        originalTransactionId: params.originalTransactionId, environment: 'SANDBOX',
      } },
      updateTime: expect.any(Timestamp), history: {},
    });
  });

  test.each([
    'only-start', 'other-counter', 'missing-subscription', 'missing-flag',
  ])('%s はlegacyへ変換せずuserと履歴を全て維持する', async (kind) => {
    const user = currentUser();
    if (kind === 'only-start') delete user.judgementRevisions;
    if (kind === 'other-counter') user.judgementRevisions.goal = 0;
    if (kind === 'missing-subscription') delete user.subscription;
    if (kind === 'missing-flag') delete user.xLinked;
    const ref = await seed(user, false);
    const before = await readState(ref);
    await expect(fetchAndApplyLatestSubscriptionStatus(apple(ref))).rejects.toBeInstanceOf(ServerHistoryError);
    expect(await readState(ref)).toEqual(before);
  });

  test('次revisionがoccupiedなら既存entryを上書きせずuser/counterもrollbackする', async () => {
    const ref = await seed();
    await ref.collection('judgementHistory/subscription/entries').doc('6').create({ occupiedFixture: true });
    const before = await readState(ref);
    await expect(fetchAndApplyLatestSubscriptionStatus(apple(ref))).rejects.toMatchObject({ code: 6 });
    expect(await readState(ref)).toEqual(before);
  });

  test('Apple取得中に削除開始した親は保存時に拒否する', async () => {
    const ref = await seed();
    const params = apple(ref);
    let blockedState: State | undefined;
    const response = { data: [{ lastTransactions: [{
      originalTransactionId: params.originalTransactionId, signedTransactionInfo: 'mock-jws-never-persist',
    }] }] };
    params.client.getAllSubscriptionStatuses.mockImplementationOnce(async () => {
      await ref.update({ deletionInProgress: true });
      blockedState = await readState(ref);
      return response;
    });
    await expect(fetchAndApplyLatestSubscriptionStatus(params)).rejects.toBeInstanceOf(AccountWriteBlockedError);
    expect(blockedState).toBeDefined();
    expect(await readState(ref)).toEqual(blockedState);
  });

  test('最新Apple署名の検証失敗ではuser/historyを保存しない', async () => {
    const ref = await seed();
    const before = await readState(ref);
    const params = apple(ref);
    params.verifier.verifyAndDecodeTransaction.mockRejectedValueOnce(new Error('fixture invalid signature'));
    await expect(fetchAndApplyLatestSubscriptionStatus(params)).rejects.toMatchObject({
      name: VerifyApplePurchaseError.name, reason: 'verification-unavailable',
    });
    expect(await readState(ref)).toEqual(before);
  });
});
