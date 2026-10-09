import jwt from 'jsonwebtoken';

import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';

import {
  TEST_INTERMEDIATE_CA_DER_BASE64,
  TEST_LEAF_CERT_DER_BASE64,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_OTHER_ROOT_CA_DER_BASE64,
  TEST_ROOT_CA_DER_BASE64,
} from './testFixtures/appleTestCertChain';

/**
 * 4-2a-0 検証タスク: @apple/app-store-server-library が本物の Apple の鍵なしでテストできるかを確かめる。
 * 本物の鍵との接続(8-2)・実際の Function 実装(4-2a)はこのタスクでは行わない
 */

const BUNDLE_ID = 'com.jime0083.gokakuwatch';

function toDerBuffer(base64Der: string): Buffer {
  return Buffer.from(base64Der, 'base64');
}

/** テスト専用の証明書チェーンで、Apple が実際に署名した JWSTransaction を模した JWT を作る */
function signTestTransaction(
  payload: Record<string, unknown>,
  x5cChain: string[] = [TEST_LEAF_CERT_DER_BASE64, TEST_INTERMEDIATE_CA_DER_BASE64, TEST_ROOT_CA_DER_BASE64],
): string {
  return jwt.sign(payload, TEST_LEAF_PRIVATE_KEY_PEM, {
    algorithm: 'ES256',
    header: { alg: 'ES256', x5c: x5cChain },
  });
}

describe('(1) AppStoreServerAPIClient をテストでモックに差し替えられるか', () => {
  it('makeFetchRequest をモックに差し替えると、getTransactionInfo が実際の通信をせずに結果を返す', async () => {
    const client = new AppStoreServerAPIClient(
      TEST_LEAF_PRIVATE_KEY_PEM, // Bearer トークン生成に ES256 の鍵が要るだけで、値そのものは検証対象ではない
      'test-key-id',
      'test-issuer-id',
      BUNDLE_ID,
      Environment.SANDBOX,
    );

    // private メソッド(makeFetchRequest)をテストから差し替えるため any にキャストする
    const makeFetchRequestSpy = jest
      .spyOn(client as unknown as { makeFetchRequest: (...args: unknown[]) => Promise<unknown> }, 'makeFetchRequest')
      .mockImplementation(async (path: unknown) => {
        expect(path).toBe('/inApps/v1/transactions/1000000123456789');
        return {
          ok: true,
          json: async () => ({ signedTransactionInfo: 'fake-signed-transaction-info' }),
        };
      });

    const response = await client.getTransactionInfo('1000000123456789');
    expect(response.signedTransactionInfo).toBe('fake-signed-transaction-info');
    expect(makeFetchRequestSpy).toHaveBeenCalledTimes(1);

    makeFetchRequestSpy.mockRestore();
  });

  it('404 + errorCode(TRANSACTION_ID_NOT_FOUND=4040010)を返すようにモックすると、ライブラリは APIException を投げる', async () => {
    const client = new AppStoreServerAPIClient(
      TEST_LEAF_PRIVATE_KEY_PEM,
      'test-key-id',
      'test-issuer-id',
      BUNDLE_ID,
      Environment.PRODUCTION,
    );

    const makeFetchRequestSpy = jest
      .spyOn(client as unknown as { makeFetchRequest: (...args: unknown[]) => Promise<unknown> }, 'makeFetchRequest')
      .mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }),
      });

    await expect(client.getTransactionInfo('not-a-real-id')).rejects.toMatchObject({
      httpStatusCode: 404,
      apiError: 4040010,
    });

    makeFetchRequestSpy.mockRestore();
  });
});

describe('(2) SignedDataVerifier をテスト専用の証明書チェーンで検証できるか', () => {
  it('正しい署名は検証を通り、appAccountToken を含めて復号できる(JWSTransactionDecodedPayload)', async () => {
    const verifier = new SignedDataVerifier(
      [toDerBuffer(TEST_ROOT_CA_DER_BASE64)],
      false, // enableOnlineChecks: オンラインの失効確認(OCSP)はテストでは行わない
      Environment.SANDBOX,
      BUNDLE_ID,
    );

    const appAccountToken = '11111111-2222-3333-4444-555555555555';
    const signedTransaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.SANDBOX,
      transactionId: 'txn-1',
      originalTransactionId: 'otxn-1',
      productId: 'com.jime0083.gokakuwatch.premium.monthly',
      appAccountToken,
      purchaseDate: Date.now(),
      signedDate: Date.now(),
    });

    const decoded: JWSTransactionDecodedPayload = await verifier.verifyAndDecodeTransaction(signedTransaction);
    expect(decoded.appAccountToken).toBe(appAccountToken);
    expect(decoded.transactionId).toBe('txn-1');
  });

  it('署名後にペイロードを書き換えると VerificationException で拒否される', async () => {
    const verifier = new SignedDataVerifier([toDerBuffer(TEST_ROOT_CA_DER_BASE64)], false, Environment.SANDBOX, BUNDLE_ID);
    const signedTransaction = signTestTransaction({
      bundleId: BUNDLE_ID,
      environment: Environment.SANDBOX,
      transactionId: 'txn-1',
    });

    const [headerPart, , signaturePart] = signedTransaction.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ bundleId: BUNDLE_ID, environment: Environment.SANDBOX, transactionId: 'txn-EVIL' })).toString(
      'base64url',
    );
    const tamperedJwt = `${headerPart}.${tamperedPayload}.${signaturePart}`;

    await expect(verifier.verifyAndDecodeTransaction(tamperedJwt)).rejects.toBeInstanceOf(VerificationException);
  });

  it('検証側が信頼していないルート証明書だと VerificationException(署名は Apple 発行ではない)', async () => {
    const verifierWithUnrelatedRoot = new SignedDataVerifier(
      [toDerBuffer(TEST_OTHER_ROOT_CA_DER_BASE64)],
      false,
      Environment.SANDBOX,
      BUNDLE_ID,
    );
    const signedTransaction = signTestTransaction({ bundleId: BUNDLE_ID, environment: Environment.SANDBOX });

    const error = await verifierWithUnrelatedRoot.verifyAndDecodeTransaction(signedTransaction).catch((e) => e);
    expect(error).toBeInstanceOf(VerificationException);
    expect((error as VerificationException).status).toBe(VerificationStatus.VERIFICATION_FAILURE);
  });

  it('bundleId が一致しないと INVALID_APP_IDENTIFIER', async () => {
    const verifier = new SignedDataVerifier([toDerBuffer(TEST_ROOT_CA_DER_BASE64)], false, Environment.SANDBOX, 'com.other.app');
    const signedTransaction = signTestTransaction({ bundleId: BUNDLE_ID, environment: Environment.SANDBOX });

    const error = await verifier.verifyAndDecodeTransaction(signedTransaction).catch((e) => e);
    expect(error).toBeInstanceOf(VerificationException);
    expect((error as VerificationException).status).toBe(VerificationStatus.INVALID_APP_IDENTIFIER);
  });
});

describe('(3) Production/Sandbox の扱い', () => {
  it('Environment.PRODUCTION で SignedDataVerifier を作るには appAppleId が必須', () => {
    expect(() => new SignedDataVerifier([toDerBuffer(TEST_ROOT_CA_DER_BASE64)], false, Environment.PRODUCTION, BUNDLE_ID)).toThrow();
    expect(
      () => new SignedDataVerifier([toDerBuffer(TEST_ROOT_CA_DER_BASE64)], false, Environment.PRODUCTION, BUNDLE_ID, 1234),
    ).not.toThrow();
  });

  it('SignedDataVerifier は environment が一致しない取引を INVALID_ENVIRONMENT で拒否する(本番用の検証器に Sandbox の取引を渡した場合)', async () => {
    const productionVerifier = new SignedDataVerifier([toDerBuffer(TEST_ROOT_CA_DER_BASE64)], false, Environment.PRODUCTION, BUNDLE_ID, 1234);
    const sandboxTransaction = signTestTransaction({ bundleId: BUNDLE_ID, environment: Environment.SANDBOX });

    const error = await productionVerifier.verifyAndDecodeTransaction(sandboxTransaction).catch((e) => e);
    expect(error).toBeInstanceOf(VerificationException);
    expect((error as VerificationException).status).toBe(VerificationStatus.INVALID_ENVIRONMENT);
  });
});
