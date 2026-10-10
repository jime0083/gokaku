import jwt from 'jsonwebtoken';

import { AppStoreServerAPIClient, Environment, NotificationTypeV2, SignedDataVerifier } from '@apple/app-store-server-library';

import { deriveAppAccountToken, MONTHLY_PRODUCT_ID } from '../domain';
import {
  APPLE_SERVER_NOTIFICATION_MAX_BODY_BYTES,
  APPLE_SERVER_NOTIFICATION_MAX_INSTANCES,
  APPLE_SERVER_NOTIFICATION_OPTIONS,
  handleAppleServerNotification,
  type AppleServerNotificationDeps,
} from '../applePurchase/appleServerNotification';
import {
  verifyApplePurchaseCore,
  type AppleApiClientLike,
  type AppleEnvironmentName,
  type VerifyApplePurchaseDeps,
} from '../applePurchase/verifyApplePurchase';
import { functionUrl, getFirestoreDoc } from './emulator';
import {
  TEST_INTERMEDIATE_CA_DER_BASE64,
  TEST_LEAF_CERT_DER_BASE64,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_CA_DER_BASE64,
} from './testFixtures/appleTestCertChain';

/**
 * 4-2b: 契約の変化の通知(App Store Server Notifications V2)を受け取る appleServerNotification のテスト。
 * Apple API はモック(makeFetchRequest の差し替え)、署名はテスト専用の証明書チェーンで検証する
 * (本物の鍵との接続は 8-2)。verifyApplePurchaseCore(4-2a)で持ち主・初期状態を作ってから通知を送る
 */

const BUNDLE_ID = 'com.jime0083.gokakuwatch';
const APP_APPLE_ID = 1234;

function toDerBuffer(base64Der: string): Buffer {
  return Buffer.from(base64Der, 'base64');
}

function uniqueId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 数字だけの一意な transactionId(/^[0-9]+$/ を満たす) */
function uniqueTransactionId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

function signTestPayload(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_LEAF_PRIVATE_KEY_PEM, {
    algorithm: 'ES256',
    header: { alg: 'ES256', x5c: [TEST_LEAF_CERT_DER_BASE64, TEST_INTERMEDIATE_CA_DER_BASE64, TEST_ROOT_CA_DER_BASE64] },
  });
}

function signTestTransaction(payload: Record<string, unknown>): string {
  return signTestPayload(payload);
}

function signTestNotification(options: {
  notificationType: string;
  subtype?: string;
  environment: 'Production' | 'Sandbox';
  signedTransactionInfo?: string;
}): string {
  return signTestPayload({
    notificationType: options.notificationType,
    subtype: options.subtype,
    notificationUUID: uniqueId('notif'),
    data: {
      environment: options.environment,
      appAppleId: APP_APPLE_ID,
      bundleId: BUNDLE_ID,
      bundleVersion: '1',
      signedTransactionInfo: options.signedTransactionInfo,
    },
    version: '2.0',
    signedDate: Date.now(),
  });
}

function createTestVerifier(environment: AppleEnvironmentName): SignedDataVerifier {
  return new SignedDataVerifier(
    [toDerBuffer(TEST_ROOT_CA_DER_BASE64)],
    false,
    environment === 'PRODUCTION' ? Environment.PRODUCTION : Environment.SANDBOX,
    BUNDLE_ID,
    environment === 'PRODUCTION' ? APP_APPLE_ID : undefined,
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

function buildVerifyDeps(options: { production?: EnvResponses; sandbox?: EnvResponses; now?: number }): VerifyApplePurchaseDeps {
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

function buildNotificationDeps(options: { production?: EnvResponses; sandbox?: EnvResponses; now?: number }): AppleServerNotificationDeps {
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

/** verifyApplePurchaseCore(4-2a)で持ち主・初期の users.subscription を用意する */
async function seedOwnedSubscription(options: {
  uid: string;
  originalTransactionId: string;
  expiresDate: number;
}): Promise<void> {
  const transactionId = uniqueTransactionId();
  const signed = signTestTransaction({
    bundleId: BUNDLE_ID,
    environment: Environment.PRODUCTION,
    transactionId,
    originalTransactionId: options.originalTransactionId,
    productId: MONTHLY_PRODUCT_ID,
    appAccountToken: deriveAppAccountToken(options.uid),
    purchaseDate: Date.now(),
    signedDate: Date.now(),
    expiresDate: options.expiresDate,
  });

  const deps = buildVerifyDeps({
    production: {
      transactionInfo: { ok: true, body: { signedTransactionInfo: signed } },
      subscriptionStatuses: {
        ok: true,
        body: { data: [{ lastTransactions: [{ originalTransactionId: options.originalTransactionId, signedTransactionInfo: signed }] }] },
      },
    },
  });

  await verifyApplePurchaseCore(options.uid, transactionId, deps);
}

describe('handleAppleServerNotification', () => {
  it('更新(DID_RENEW)で expiresAt が延びる', async () => {
    const uid = uniqueId('uid-renew');
    const originalTransactionId = uniqueId('otxn-renew');
    const initialExpiresDate = Date.now() + 1000 * 60 * 60 * 24; // 1日後
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: initialExpiresDate });

    const renewedExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 31; // 更新で31日後に延びる
    const renewedTransaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: renewedExpiresDate,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_RENEW,
      environment: 'Production',
      signedTransactionInfo: renewedTransaction,
    });

    const deps = buildNotificationDeps({
      production: {
        subscriptionStatuses: {
          ok: true,
          body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: renewedTransaction }] }] },
        },
      },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'ok' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'active', expiresAt: renewedExpiresDate, originalTransactionId });
  });

  it('解約(DID_CHANGE_RENEWAL_STATUS)は期限までは active のまま', async () => {
    const uid = uniqueId('uid-cancel');
    const originalTransactionId = uniqueId('otxn-cancel');
    const expiresDate = Date.now() + 1000 * 60 * 60 * 24 * 10; // 10日後(まだ期限内)
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate });

    // 自動更新はオフになったが、今の期間の期限はまだ先(expiresDate は変わらない)
    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
      subtype: 'AUTO_RENEW_DISABLED',
      environment: 'Production',
      signedTransactionInfo: transaction,
    });

    const deps = buildNotificationDeps({
      production: {
        subscriptionStatuses: {
          ok: true,
          body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: transaction }] }] },
        },
      },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'ok' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'active', expiresAt: expiresDate });
  });

  it('期限切れ(EXPIRED)で expired になる', async () => {
    const uid = uniqueId('uid-expired');
    const originalTransactionId = uniqueId('otxn-expired');
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: Date.now() + 1000 });

    const pastExpiresDate = Date.now() - 1000 * 60 * 60 * 24;
    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: pastExpiresDate,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.EXPIRED,
      environment: 'Production',
      signedTransactionInfo: transaction,
    });

    const deps = buildNotificationDeps({
      production: {
        subscriptionStatuses: {
          ok: true,
          body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: transaction }] }] },
        },
      },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'ok' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'expired', expiresAt: pastExpiresDate });
  });

  it('取り消し(REVOKE)は revocationDate を expiresAt にして expired になる', async () => {
    const uid = uniqueId('uid-revoke');
    const originalTransactionId = uniqueId('otxn-revoke');
    const futureExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 30;
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: futureExpiresDate });

    const revocationDate = Date.now() - 1000 * 60 * 60; // 1時間前に取り消された
    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: futureExpiresDate,
      revocationDate,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.REVOKE,
      environment: 'Production',
      signedTransactionInfo: transaction,
    });

    const deps = buildNotificationDeps({
      production: {
        subscriptionStatuses: {
          ok: true,
          body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: transaction }] }] },
        },
      },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'ok' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'expired', expiresAt: revocationDate });
  });

  it('不正な署名(改ざん)は invalid で、何も保存しない', async () => {
    const uid = uniqueId('uid-tamper');
    const originalTransactionId = uniqueId('otxn-tamper');
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: Date.now() + 1000 * 60 * 60 });

    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_RENEW,
      environment: 'Production',
      signedTransactionInfo: transaction,
    });
    const [headerPart, , signaturePart] = notification.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ notificationType: 'DID_RENEW', data: { environment: 'Production', bundleId: BUNDLE_ID } })).toString(
      'base64url',
    );
    const tampered = `${headerPart}.${tamperedPayload}.${signaturePart}`;

    const beforeDoc = await getFirestoreDoc(`users/${uid}`);

    const result = await handleAppleServerNotification({ signedPayload: tampered }, buildNotificationDeps({}));
    expect(result).toEqual({ outcome: 'invalid' });

    const afterDoc = await getFirestoreDoc(`users/${uid}`);
    expect(afterDoc?.subscription).toEqual(beforeDoc?.subscription);
  });

  it('持ち主(appleSubscriptions)がいない購入の通知は no-owner で、何も保存しない', async () => {
    const originalTransactionId = uniqueId('otxn-no-owner');
    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: '11111111-2222-3333-4444-555555555555',
      expiresDate: Date.now() + 1000 * 60 * 60 * 24,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_RENEW,
      environment: 'Production',
      signedTransactionInfo: transaction,
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, buildNotificationDeps({}));
    expect(result).toEqual({ outcome: 'no-owner' });

    const ownerDoc = await getFirestoreDoc(`appleSubscriptions/${originalTransactionId}`);
    expect(ownerDoc).toBeNull();
  });

  it('TEST 通知は test を返し、何も取りに行かない', async () => {
    const notification = signTestNotification({ notificationType: NotificationTypeV2.TEST, environment: 'Production' });

    const result = await handleAppleServerNotification({ signedPayload: notification }, buildNotificationDeps({}));
    expect(result).toEqual({ outcome: 'test' });
  });

  it('最新の状態が取れない(通信エラー)ときは unavailable で、何も保存しない(元の状態のまま)', async () => {
    const uid = uniqueId('uid-unavailable');
    const originalTransactionId = uniqueId('otxn-unavailable');
    const initialExpiresDate = Date.now() + 1000 * 60 * 60 * 24;
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: initialExpiresDate });

    const transaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_RENEW,
      environment: 'Production',
      signedTransactionInfo: transaction,
    });

    const deps = buildNotificationDeps({
      production: { subscriptionStatuses: { throws: new Error('network down') } },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'unavailable' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ expiresAt: initialExpiresDate });
  });

  it('通知の中身が古くても、取り直した最新の状態(getAllSubscriptionStatuses)で保存される', async () => {
    const uid = uniqueId('uid-stale');
    const originalTransactionId = uniqueId('otxn-stale');
    const initialExpiresDate = Date.now() + 1000 * 60 * 60 * 24;
    await seedOwnedSubscription({ uid, originalTransactionId, expiresDate: initialExpiresDate });

    // 通知自体が運んできた取引は古い(期限切れの)内容
    const staleExpiresDate = Date.now() - 1000 * 60 * 60 * 24 * 5;
    const staleTransaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: staleExpiresDate,
    });
    const notification = signTestNotification({
      notificationType: NotificationTypeV2.DID_RENEW,
      environment: 'Production',
      signedTransactionInfo: staleTransaction,
    });

    // だが Apple から取り直した最新の状態は、さらに新しい期限
    const latestExpiresDate = Date.now() + 1000 * 60 * 60 * 24 * 60;
    const latestTransaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.PRODUCTION,
      transactionId: uniqueTransactionId(),
      originalTransactionId,
      productId: MONTHLY_PRODUCT_ID,
      appAccountToken: deriveAppAccountToken(uid),
      expiresDate: latestExpiresDate,
    });

    const deps = buildNotificationDeps({
      production: {
        subscriptionStatuses: {
          ok: true,
          body: { data: [{ lastTransactions: [{ originalTransactionId, signedTransactionInfo: latestTransaction }] }] },
        },
      },
    });

    const result = await handleAppleServerNotification({ signedPayload: notification }, deps);
    expect(result).toEqual({ outcome: 'ok' });

    const userDoc = await getFirestoreDoc(`users/${uid}`);
    expect(userDoc?.subscription).toMatchObject({ status: 'active', expiresAt: latestExpiresDate });
  });
});

describe('appleServerNotification (Functions Emulator・HTTP)', () => {
  it('POST 以外は 405 を返す(秘密情報の設定がなくても判定できる)', async () => {
    const res = await fetch(functionUrl('appleServerNotification'), { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  // 5-3b-2: 誰でも呼べる入口(requirements 3-2「大量の呼び出しへの対策」)の本文サイズの上限
  it('本文が上限(64KB)を超えると 413 を返す(秘密情報の設定がなくても判定できる)', async () => {
    const oversizedPayload = 'a'.repeat(APPLE_SERVER_NOTIFICATION_MAX_BODY_BYTES + 1024);
    const res = await fetch(functionUrl('appleServerNotification'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload: oversizedPayload }),
    });
    expect(res.status).toBe(413);
  });

  it('本文が上限(64KB)以内であれば 413 にはならない(不正な署名として 400 になる)', async () => {
    const res = await fetch(functionUrl('appleServerNotification'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'not-a-real-jwt' }),
    });
    expect(res.status).not.toBe(413);
  });
});

// 5-3b-2: 同時に動くインスタンス数の上限(maxInstances)が設定値どおりであることを確認する
// (Cloud Run のスケーリング自体は Emulator・Jest では再現できないため、onRequest に渡している
// options の値をコードから直接確認する)
describe('appleServerNotification の maxInstances(5-3b-2)', () => {
  it('maxInstances が設定されている', () => {
    expect(APPLE_SERVER_NOTIFICATION_OPTIONS.maxInstances).toBe(APPLE_SERVER_NOTIFICATION_MAX_INSTANCES);
  });
});
