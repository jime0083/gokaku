import jwt from 'jsonwebtoken';

import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from '@apple/app-store-server-library';

import { markAccountDeletionStarted } from '../account/accountWriteGuard';
import { deriveAppAccountToken, MONTHLY_PRODUCT_ID } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';
import { RATE_LIMITS, rateLimitDocPath } from '../rateLimit';
import {
  handleVerifyApplePurchaseRequest,
  verifyApplePurchaseCore,
  VerifyApplePurchaseError,
  type AppleApiClientLike,
  type AppleEnvironmentName,
  type VerifyApplePurchaseDeps,
} from '../applePurchase/verifyApplePurchase';
import { getFirestoreDoc } from './emulator';
import {
  TEST_INTERMEDIATE_CA_DER_BASE64,
  TEST_LEAF_CERT_DER_BASE64,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_CA_DER_BASE64,
} from './testFixtures/appleTestCertChain';

/**
 * 4-2a: 購入の取引を Apple に確認する verifyApplePurchase のテスト。
 * Apple API はモック(makeFetchRequest の差し替え)、署名はテスト専用の証明書チェーンで検証する
 * (本物の鍵との接続は 8-2)
 */

const BUNDLE_ID = 'com.jime0083.gokakuwatch';


const appleTestPaths = new Set<string>();
const appleTestUids = new Set<string>();

beforeAll(() => {
  if (!process.env.GCLOUD_PROJECT?.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Apple購入テストはdemoプロジェクトのFirestore Emulatorで実行してください');
  }
});

afterEach(async () => {
  ensureAdminApp();
  const db = getFirestore();
  try {
    const failures: unknown[] = [];
    await Promise.all([...appleTestUids].map(async (uid) => {
      try {
        const counters = await db.collection('rateLimits')
          .where(FieldPath.documentId(), '>=', `${uid}_purchase-verify_`)
          .where(FieldPath.documentId(), '<', `${uid}_purchase-verify_\uf8ff`)
          .get();
        for (const counter of counters.docs) {
          appleTestPaths.add(counter.ref.path);
        }
      } catch (error) {
        failures.push(error);
      }
    }));
    const results = await Promise.allSettled([...appleTestPaths].map((path) => db.doc(path).delete()));
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Appleテストデータの後片付けに失敗しました');
  } finally {
    appleTestPaths.clear();
    appleTestUids.clear();
  }
});

async function seedUser(uid: string): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`users/${uid}`).set({ checkEnabled: true });
}

function toDerBuffer(base64Der: string): Buffer {
  return Buffer.from(base64Der, 'base64');
}

function uniqueId(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (label.startsWith('uid-')) {
    appleTestUids.add(id);
    appleTestPaths.add(`users/${id}`);
  } else if (label.startsWith('otxn-')) {
    appleTestPaths.add(`appleSubscriptions/${id}`);
  }
  return id;
}

/** 数字だけの一意な transactionId(/^[0-9]+$/ を満たす) */
function uniqueTransactionId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

function signTestTransaction(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_LEAF_PRIVATE_KEY_PEM, {
    algorithm: 'ES256',
    header: { alg: 'ES256', x5c: [TEST_LEAF_CERT_DER_BASE64, TEST_INTERMEDIATE_CA_DER_BASE64, TEST_ROOT_CA_DER_BASE64] },
  });
}

function createTestVerifier(environment: AppleEnvironmentName) {
  return new SignedDataVerifier(
    [toDerBuffer(TEST_ROOT_CA_DER_BASE64)],
    false,
    environment === 'PRODUCTION' ? Environment.PRODUCTION : Environment.SANDBOX,
    BUNDLE_ID,
    environment === 'PRODUCTION' ? 1234 : undefined,
  );
}

function createTestApiClient(environment: AppleEnvironmentName): AppStoreServerAPIClient {
  return new AppStoreServerAPIClient(
    TEST_LEAF_PRIVATE_KEY_PEM,
    'test-key-id',
    'test-issuer-id',
    BUNDLE_ID,
    environment === 'PRODUCTION' ? Environment.PRODUCTION : Environment.SANDBOX,
  );
}

type FetchResult = { ok: true; body: unknown } | { ok: false; status: number; errorCode?: number } | { throws: Error };

type EnvResponses = {
  transactionInfo?: FetchResult;
  subscriptionStatuses?: FetchResult;
};

/** AppStoreServerAPIClient.makeFetchRequest をパスで振り分けてモックする */
function mockClient(client: AppStoreServerAPIClient, responses: EnvResponses): void {
  jest
    .spyOn(client as unknown as { makeFetchRequest: (...args: unknown[]) => Promise<unknown> }, 'makeFetchRequest')
    .mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const pick = (result: FetchResult | undefined, label: string): Promise<unknown> => {
        if (!result) {
          throw new Error(`テストのモック未設定: ${label} (${path})`);
        }
        if ('throws' in result) {
          throw result.throws;
        }
        if (result.ok) {
          return Promise.resolve({ ok: true, json: async () => result.body });
        }
        return Promise.resolve({
          ok: false,
          status: result.status,
          json: async () => ({ errorCode: result.errorCode, errorMessage: 'mock-error' }),
        });
      };
      if (path.includes('/inApps/v1/transactions/')) {
        return pick(responses.transactionInfo, 'transactionInfo');
      }
      if (path.includes('/inApps/v1/subscriptions/')) {
        return pick(responses.subscriptionStatuses, 'subscriptionStatuses');
      }
      throw new Error(`テストで未対応のパス: ${path}`);
    });
}

function buildDeps(options: {
  production?: EnvResponses;
  sandbox?: EnvResponses;
  now?: number;
}): VerifyApplePurchaseDeps {
  return {
    createApiClient: (environment): AppleApiClientLike => {
      const client = createTestApiClient(environment);
      const responses = environment === 'PRODUCTION' ? options.production : options.sandbox;
      if (responses) {
        mockClient(client, responses);
      }
      return client;
    },
    createVerifier: (environment) => createTestVerifier(environment),
    now: () => options.now ?? Date.now(),
  };
}

describe('verifyApplePurchaseCore', () => {
  it('正常な取引(Production)は active を返し、users.subscription と appleSubscriptions を保存する', async () => {
    const uid = uniqueId('uid-ok');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-ok');
    const transactionId = uniqueTransactionId();
    const futureExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 30;
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      purchaseDate: Date.now(),
      signedDate: Date.now(),
      expiresDate: futureExpiresDate,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { ok: true, body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: signed }] }] } },
      },
    });

    const result = await verifyApplePurchaseCore(uid, transactionId, deps);
    expect(result).toEqual({ status: 'active', expiresAt: futureExpiresDate });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({
      status: 'active',
      productId: MONTHLY_PRODUCT_ID,
      expiresAt: futureExpiresDate,
      originalTransactionId,
      environment: 'PRODUCTION',
    });

    const ownerDoc = await getFirestoreDoc(`appleSubscriptions/${originalTransactionId}`);
    expect(ownerDoc).toMatchObject({ uid, productId: MONTHLY_PRODUCT_ID, environment: 'PRODUCTION' });
    expect(userDoc?.checkEnabled).toBe(true);
    // 同じ持ち主による再確認でも所有情報(createdAtを含む)は変えない。
    await expect(verifyApplePurchaseCore(uid, transactionId, deps)).resolves.toEqual(result);
    expect(await getFirestoreDoc(`appleSubscriptions/${originalTransactionId}`)).toEqual(ownerDoc);
  });

  it('Production では見つからず(404 + TRANSACTION_ID_NOT_FOUND)、Sandbox で見つかる', async () => {
    const uid = uniqueId('uid-sandbox');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-sandbox');
    const transactionId = uniqueTransactionId();
    const futureExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 30;
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.SANDBOX,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      purchaseDate: Date.now(),
      signedDate: Date.now(),
      expiresDate: futureExpiresDate,
    });

    const deps = buildDeps({
      production: { transactionInfo: { ok: false, status: 404, errorCode: 4040010 } },
      sandbox: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { ok: true, body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: signed }] }] } },
      },
    });

    const result = await verifyApplePurchaseCore(uid, transactionId, deps);
    expect(result.status).toBe('active');

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ environment: 'SANDBOX', originalTransactionId });
  });

  it('署名が不正(改ざん)だと invalid-transaction', async () => {
    const uid = uniqueId('uid-tamper');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId: uniqueId('otxn-tamper'),
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
    });
    const [headerPart, , signaturePart] = signed.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ bundleId: BUNDLE_ID, environment: Environment.PRODUCTION, transactionId: 'evil' })).toString(
      'base64url',
    );
    const tampered = `${headerPart}.${tamperedPayload}.${signaturePart}`;

    const deps = buildDeps({ production: { transactionInfo: { ok: true, body: { signedTransactionInfo: tampered } } } });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('invalid-transaction');
  });

  it('appAccountToken が違うと invalid-transaction', async () => {
    const uid = uniqueId('uid-token-mismatch');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId: uniqueId('otxn-token-mismatch'),
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: '11111111-2222-3333-4444-555555555555', // uid の appAccountToken とは無関係
    });

    const deps = buildDeps({ production: { transactionInfo: { ok: true, body: { signedTransactionInfo: signed } } } });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('invalid-transaction');
  });

  it('製品IDが違うと invalid-transaction', async () => {
    const uid = uniqueId('uid-bad-product');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId: uniqueId('otxn-bad-product'),
      productId: 'com.jime0083.gokakuwatch.not-a-real-product',
      appAccountToken: deriveAppAccountToken(uid),
    });

    const deps = buildDeps({ production: { transactionInfo: { ok: true, body: { signedTransactionInfo: signed } } } });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('invalid-transaction');
  });

  it('別のアカウントが持ち主の購入は owned-by-other-account', async () => {
    const ownerUid = uniqueId('uid-owner');
    await seedUser(ownerUid);
    const otherUid = uniqueId('uid-other');
    await seedUser(otherUid);
    const originalTransactionId = uniqueId('otxn-owned');
    const futureExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 30;

    const ownerTransactionId = uniqueTransactionId();
    const signedForOwner = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: ownerTransactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(ownerUid),
      expiresDate: futureExpiresDate,
    });
    await verifyApplePurchaseCore(
      ownerUid,
      ownerTransactionId,
      buildDeps({
        production: {
          transactionInfo: { ok: true, body: { signedTransactionInfo: signedForOwner } },
          subscriptionStatuses: {
            ok: true,
            body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: signedForOwner }] }] },
          },
        },
      }),
    );

    // 別のアカウントが同じ originalTransactionId を(復元などで)確認しようとする
    const otherTransactionId = uniqueTransactionId();
    const signedForOther = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: otherTransactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(otherUid),
      expiresDate: futureExpiresDate,
    });
    const error = await verifyApplePurchaseCore(
      otherUid,
      otherTransactionId,
      buildDeps({ production: { transactionInfo: { ok: true, body: { signedTransactionInfo: signedForOther } } } }),
    ).catch((e) => e);

    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('owned-by-other-account');

    // 持ち主は書き換えられていない
    const ownerDoc = await getFirestoreDoc(`appleSubscriptions/${originalTransactionId}`);
    expect(ownerDoc?.uid).toBe(ownerUid);
  });

  it('期限切れの取引は expired を返す(エラーではない)', async () => {
    const uid = uniqueId('uid-expired');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-expired');
    const transactionId = uniqueTransactionId();
    const pastExpiresDate = Date.now() - 1000 * 60 * 60 * 24;
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: pastExpiresDate,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { ok: true, body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: signed }] }] } },
      },
    });

    const result = await verifyApplePurchaseCore(uid, transactionId, deps);
    expect(result).toEqual({ status: 'expired', expiresAt: pastExpiresDate });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'expired', expiresAt: pastExpiresDate });
  });

  it('取り消された(revocationDate あり)取引は、取り消された時点を expiresAt にして expired を返す', async () => {
    const uid = uniqueId('uid-revoked');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-revoked');
    const transactionId = uniqueTransactionId();
    const futureExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 30; // 元の期限はまだ先
    const revocationDate = Date.now() - 1000 * 60 * 60; // 1時間前に取り消された
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: futureExpiresDate,
      revocationDate,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { ok: true, body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: signed }] }] } },
      },
    });

    const result = await verifyApplePurchaseCore(uid, transactionId, deps);
    expect(result).toEqual({ status: 'expired', expiresAt: revocationDate });
  });

  it('通信エラー(Apple API への到達不可)は verification-unavailable', async () => {
    const uid = uniqueId('uid-network-error');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();

    const deps = buildDeps({ production: { transactionInfo: { throws: new Error('network down') } } });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('verification-unavailable');
  });

  it('getAllSubscriptionStatuses の応答に該当 originalTransactionId の取引がないと verification-unavailable(users.subscription は保存されない)', async () => {
    const uid = uniqueId('uid-status-no-match');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-status-no-match');
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 1000,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        // 該当する originalTransactionId を含まない応答(別の取引だけが載っている想定)
        subscriptionStatuses: { ok: true, body: { data: [{ lastTransactions: [{ originalTransactionId: uniqueId('otxn-other'), signedTransactionInfo: signed }] }] } },
      },
    });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('verification-unavailable');

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toBeUndefined();
  });

  it('getAllSubscriptionStatuses の応答の取引一覧が空だと verification-unavailable(users.subscription は保存されない)', async () => {
    const uid = uniqueId('uid-status-empty');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-status-empty');
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 1000,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { ok: true, body: { data: [] } },
      },
    });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('verification-unavailable');

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toBeUndefined();
  });

  it('getAllSubscriptionStatuses が失敗しても verification-unavailable', async () => {
    const uid = uniqueId('uid-status-error');
    await seedUser(uid);
    const originalTransactionId = uniqueId('otxn-status-error');
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 1000,
    });

    const deps = buildDeps({
      production: {
        transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
        subscriptionStatuses: { throws: new Error('network down') },
      },
    });

    const error = await verifyApplePurchaseCore(uid, transactionId, deps).catch((e) => e);
    expect(error).toBeInstanceOf(VerifyApplePurchaseError);
    expect((error as VerifyApplePurchaseError).reason).toBe('verification-unavailable');
  });
});

describe('handleVerifyApplePurchaseRequest', () => {
  it('未認証(auth なし)は HttpsError(unauthenticated)', async () => {
    const deps = buildDeps({});

    const error = await handleVerifyApplePurchaseRequest({ auth: undefined, data: { transactionId: '123' } }, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'unauthenticated' });
  });

  it('transactionId が数字の文字列でないと HttpsError(invalid-argument)', async () => {
    const deps = buildDeps({});
    const uid = uniqueId('uid-handler-input');
    await seedUser(uid);
    await seedUser(uid);
    const authData = { uid, token: {} as never, rawToken: '' };

    const error = await handleVerifyApplePurchaseRequest({ auth: authData, data: { transactionId: 'not-a-number' } }, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid-argument' });
  });

  it('不正な取引(invalid-transaction)は HttpsError(failed-precondition, details.reason)', async () => {
    const uid = uniqueId('uid-handler-invalid');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId: uniqueId('otxn-handler-invalid'),
      productId: 'wrong-product',
      appAccountToken: deriveAppAccountToken(uid),
    });
    const deps = buildDeps({ production: { transactionInfo: { ok: true, body: { signedTransactionInfo: signed } } } });
    const authData = { uid, token: {} as never, rawToken: '' };

    const error = await handleVerifyApplePurchaseRequest({ auth: authData, data: { transactionId } }, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'failed-precondition', details: { reason: 'invalid-transaction' } });
  });

  it('通信エラーは HttpsError(unavailable, details.reason)', async () => {
    const uid = uniqueId('uid-handler-unavailable');
    await seedUser(uid);
    const transactionId = uniqueTransactionId();
    const deps = buildDeps({ production: { transactionInfo: { throws: new Error('network down') } } });
    const authData = { uid, token: {} as never, rawToken: '' };

    const error = await handleVerifyApplePurchaseRequest({ auth: authData, data: { transactionId } }, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'unavailable', details: { reason: 'verification-unavailable' } });
  });

  describe('呼び出し回数の制限(5-3b-2。requirements 3-2「大量の呼び出しへの対策」)', () => {
    async function seedRateLimitCount(uid: string, nowMs: number, count: number): Promise<void> {
      ensureAdminApp();
      await seedUser(uid);
      await getFirestore().doc(rateLimitDocPath(uid, 'purchase-verify', nowMs)).set({ count });
    }

    it('上限の1回手前まで数えてあっても、もう1回は通る(境界。通信エラーで確認できなくても回数は数えられている)', async () => {
      const uid = uniqueId('uid-rate-ok');
      const transactionId = uniqueTransactionId();
      const nowMs = Date.now();
      await seedRateLimitCount(uid, nowMs, RATE_LIMITS['purchase-verify'] - 1);
      const deps = buildDeps({ production: { transactionInfo: { throws: new Error('network down') } }, now: nowMs });
      const authData = { uid, token: {} as never, rawToken: '' };

      const error = await handleVerifyApplePurchaseRequest({ auth: authData, data: { transactionId } }, deps).catch((e) => e);
      expect(error).toMatchObject({ code: 'unavailable', details: { reason: 'verification-unavailable' } });
    });

    it('上限に達していると HttpsError(resource-exhausted, reason: rate-limited)', async () => {
      const uid = uniqueId('uid-rate-exceeded');
      const transactionId = uniqueTransactionId();
      const nowMs = Date.now();
      await seedRateLimitCount(uid, nowMs, RATE_LIMITS['purchase-verify']);
      const deps = buildDeps({ now: nowMs });
      const authData = { uid, token: {} as never, rawToken: '' };

      const error = await handleVerifyApplePurchaseRequest({ auth: authData, data: { transactionId } }, deps).catch((e) => e);
      expect(error).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    });

    it('次の1分になると、上限に達していても再び通る', async () => {
      const uid = uniqueId('uid-rate-next-minute');
      const nowMs = Date.now();
      await seedRateLimitCount(uid, nowMs, RATE_LIMITS['purchase-verify']);
      const authData = { uid, token: {} as never, rawToken: '' };

      const stillLimited = await handleVerifyApplePurchaseRequest(
        { auth: authData, data: { transactionId: uniqueTransactionId() } },
        buildDeps({ now: nowMs }),
      ).catch((e) => e);
      expect(stillLimited).toMatchObject({ code: 'resource-exhausted' });

      const error = await handleVerifyApplePurchaseRequest(
        { auth: authData, data: { transactionId: uniqueTransactionId() } },
        buildDeps({ production: { transactionInfo: { throws: new Error('network down') } }, now: nowMs + 60_000 }),
      ).catch((e) => e);
      // 上限はもう引っかからない(別のエラー=verification-unavailable になる)
      expect(error).toMatchObject({ code: 'unavailable', details: { reason: 'verification-unavailable' } });
    });
  });
});

describe('P-055 Apple購入の所有claim', () => {
  it.each(['deleting', 'missing'] as const)('%sの親には所有情報を再作成しない', async (reason) => {
    const uid = uniqueId('uid-claim-blocked');
    const otherUid = uniqueId('uid-claim-unrelated');
    const originalTransactionId = uniqueId('otxn-claim-blocked');
    const otherOriginalTransactionId = uniqueId('otxn-claim-unrelated');
    const transactionId = uniqueTransactionId();
    await seedUser(uid);
    await seedUser(otherUid);
    const db = getFirestore();
    const userRef = db.doc(`users/${uid}`);
    const ownerRef = db.doc(`appleSubscriptions/${originalTransactionId}`);
    const otherOwnerRef = db.doc(`appleSubscriptions/${otherOriginalTransactionId}`);
    await otherOwnerRef.set({ uid: otherUid, productId: MONTHLY_PRODUCT_ID, environment: 'PRODUCTION' });
    const beforeOtherUser = (await db.doc(`users/${otherUid}`).get()).data();
    const beforeOtherOwner = (await otherOwnerRef.get()).data();
    const signed = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId,
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 60_000,
    });
    const client: AppleApiClientLike = {
      getTransactionInfo: jest.fn(async () => {
        await markAccountDeletionStarted(uid);
        await ownerRef.delete();
        if (reason === 'missing') {
          await userRef.delete();
        }
        return { signedTransactionInfo: signed };
      }),
      getAllSubscriptionStatuses: jest.fn(async () => ({ data: [] })),
    };
    await expect(verifyApplePurchaseCore(uid, transactionId, {
      createApiClient: () => client,
      createVerifier: createTestVerifier,
      now: () => Date.now(),
    })).rejects.toMatchObject({ name: 'AccountWriteBlockedError', reason });
    expect(client.getAllSubscriptionStatuses).not.toHaveBeenCalled();
    expect((await ownerRef.get()).exists).toBe(false);
    expect((await userRef.get()).data()).toEqual(reason === 'missing' ? undefined : {
      checkEnabled: true, deletionInProgress: true,
    });
    expect((await db.doc(`users/${otherUid}`).get()).data()).toEqual(beforeOtherUser);
    expect((await otherOwnerRef.get()).data()).toEqual(beforeOtherOwner);
  });
});
