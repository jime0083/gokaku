import {
  recoverPendingPurchases,
  type PendingPurchaseRecoveryDependencies,
} from '@/features/billing/recoverPendingPurchases';
import {
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
  type BillingPurchaseResult,
} from '@/features/billing/types';
import type { VerifyPurchaseResult } from '@/features/billing/verifyPurchase';

const UID = 'recovery-user';

function purchase(
  transactionId: string,
  productId = MONTHLY_PRODUCT_ID,
): BillingPurchaseResult {
  return {
    productId,
    transactionId,
    originalTransactionIdentifierIOS: null,
    purchaseToken: null,
    rawPurchase: { id: transactionId, productId },
  };
}

function setup(purchases: BillingPurchaseResult[] = []) {
  let uid: string | null = UID;
  const getUid = jest.fn(() => uid);
  const loadPending = jest
    .fn<Promise<BillingPurchaseResult[]>, []>()
    .mockResolvedValue(purchases);
  const verify = jest
    .fn<Promise<VerifyPurchaseResult>, [string]>()
    .mockResolvedValue({ status: 'active', expiresAt: 1000 });
  const finish = jest
    .fn<Promise<void>, [BillingPurchaseResult]>()
    .mockResolvedValue(undefined);
  const deps: PendingPurchaseRecoveryDependencies = {
    getUid,
    loadPending,
    verify,
    finish,
  };
  return {
    deps,
    getUid,
    loadPending,
    verify,
    finish,
    setUid: (value: string | null) => {
      uid = value;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('recoverPendingPurchases(4-3。注入した依存のみ)', () => {
  it('未完了取引がなければ確認も完了処理もしない', async () => {
    const context = setup();

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toEqual({
      finished: 0,
      failed: 0,
      skipped: 0,
      aborted: false,
      loadFailed: false,
    });
    expect(context.verify).not.toHaveBeenCalled();
    expect(context.finish).not.toHaveBeenCalled();
  });

  it('サーバー確認と完了処理を待ち、取引を順番に処理する', async () => {
    const first = purchase('first');
    const second = purchase('second', YEARLY_PRODUCT_ID);
    const context = setup([first, second]);
    const verification = deferred<VerifyPurchaseResult>();
    const verificationStarted = deferred<void>();
    const finishing = deferred<void>();
    const finishStarted = deferred<void>();
    const events: string[] = [];
    let settled = false;

    context.verify.mockImplementation(async (transactionId) => {
      events.push(`verify:${transactionId}`);
      if (transactionId === first.transactionId) {
        verificationStarted.resolve(undefined);
        return verification.promise;
      }
      return { status: 'active', expiresAt: 1000 };
    });
    context.finish.mockImplementation(async (result) => {
      events.push(`finish:${result.transactionId}`);
      if (result.transactionId === first.transactionId) {
        finishStarted.resolve(undefined);
        await finishing.promise;
      }
    });

    const recovery = recoverPendingPurchases(UID, context.deps).then((result) => {
      settled = true;
      return result;
    });

    await verificationStarted.promise;
    expect(context.finish).not.toHaveBeenCalled();
    expect(context.verify).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    verification.resolve({ status: 'active', expiresAt: 1000 });
    await finishStarted.promise;
    expect(context.finish).toHaveBeenCalledWith(first);
    expect(context.verify).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishing.resolve(undefined);
    await expect(recovery).resolves.toMatchObject({
      finished: 2,
      failed: 0,
      aborted: false,
    });
    expect(context.verify.mock.calls).toEqual([['first'], ['second']]);
    expect(context.finish.mock.calls).toEqual([[first], [second]]);
    expect(events).toEqual([
      'verify:first',
      'finish:first',
      'verify:second',
      'finish:second',
    ]);
  });

  it('未知の商品と空の取引IDはサーバー確認・完了処理の対象にしない', async () => {
    const context = setup([
      purchase('foreign', 'com.example.other.product'),
      purchase(''),
      purchase('   '),
    ]);

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
      finished: 0,
      failed: 0,
      skipped: 3,
    });
    expect(context.verify).not.toHaveBeenCalled();
    expect(context.finish).not.toHaveBeenCalled();
  });

  it('期限切れ・確認不能・不正取引・別アカウントでは完了しない', async () => {
    const outcomes: VerifyPurchaseResult[] = [
      { status: 'expired', expiresAt: 1000 },
      { status: 'verification-unavailable' },
      { status: 'invalid-transaction' },
      { status: 'owned-by-other-account' },
    ];
    for (const outcome of outcomes) {
      const context = setup([purchase('pending')]);
      context.verify.mockResolvedValueOnce(outcome);

      await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
        finished: 0,
        failed: outcome.status === 'expired' ? 0 : 1,
        skipped: outcome.status === 'expired' ? 1 : 0,
      });
      expect(context.verify).toHaveBeenCalledWith('pending');
      expect(context.finish).not.toHaveBeenCalled();
    }
  });

  it('確認例外を秘匿し、重複は実行内1回だけ処理し、次回は再確認する', async () => {
    const first = purchase('retry-verification');
    const second = purchase('next');
    const context = setup([first, first, second]);
    context.verify.mockRejectedValueOnce(new Error('private-verification-token'));

    const initial = await recoverPendingPurchases(UID, context.deps);

    expect(initial).toEqual({
      finished: 1,
      failed: 1,
      skipped: 1,
      aborted: false,
      loadFailed: false,
    });
    expect(JSON.stringify(initial)).not.toContain('private');
    expect(context.verify.mock.calls).toEqual([['retry-verification'], ['next']]);
    expect(context.finish.mock.calls).toEqual([[second]]);

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
      finished: 2,
      failed: 0,
      skipped: 1,
    });
    expect(context.verify.mock.calls).toEqual([
      ['retry-verification'],
      ['next'],
      ['retry-verification'],
      ['next'],
    ]);
    expect(context.finish.mock.calls).toEqual([[second], [first], [second]]);
  });

  it('完了処理の例外を秘匿し、同一実行の重複は飛ばして次回再試行する', async () => {
    const pending = purchase('retry-finish');
    const context = setup([pending, pending]);
    context.finish.mockRejectedValueOnce({ receipt: 'private-finish-receipt' });

    const initial = await recoverPendingPurchases(UID, context.deps);

    expect(initial).toMatchObject({ finished: 0, failed: 1, skipped: 1 });
    expect(JSON.stringify(initial)).not.toContain('private');
    expect(context.finish).toHaveBeenCalledTimes(1);

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
      finished: 1,
      failed: 0,
      skipped: 1,
    });
    expect(context.verify).toHaveBeenCalledTimes(2);
    expect(context.finish).toHaveBeenCalledTimes(2);
  });

  it('空UID・別UID・UID取得例外では一覧を取得せず中断する', async () => {
    for (const expectedUid of ['', '   ', 'another-user']) {
      const context = setup([purchase('pending')]);

      await expect(
        recoverPendingPurchases(expectedUid, context.deps),
      ).resolves.toMatchObject({ aborted: true, finished: 0 });
      expect(context.loadPending).not.toHaveBeenCalled();
      expect(context.verify).not.toHaveBeenCalled();
      expect(context.finish).not.toHaveBeenCalled();
    }

    const context = setup([purchase('pending')]);
    context.getUid.mockImplementation(() => {
      throw new Error('private-auth-detail');
    });

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
      aborted: true,
      finished: 0,
    });
    expect(context.loadPending).not.toHaveBeenCalled();
  });

  it('一覧取得中にログアウト・アカウント変更したら確認も完了もしない', async () => {
    for (const changedUid of [null, 'another-user']) {
      const context = setup();
      const loading = deferred<BillingPurchaseResult[]>();
      const started = deferred<void>();
      context.loadPending.mockImplementationOnce(() => {
        started.resolve(undefined);
        return loading.promise;
      });

      const recovery = recoverPendingPurchases(UID, context.deps);
      await started.promise;
      context.setUid(changedUid);
      loading.resolve([purchase('pending')]);

      await expect(recovery).resolves.toMatchObject({ aborted: true, finished: 0 });
      expect(context.verify).not.toHaveBeenCalled();
      expect(context.finish).not.toHaveBeenCalled();
    }
  });

  it('サーバー確認中にログアウト・アカウント変更したらactiveでも完了しない', async () => {
    for (const changedUid of [null, 'another-user']) {
      const context = setup([purchase('pending'), purchase('next')]);
      const verification = deferred<VerifyPurchaseResult>();
      const started = deferred<void>();
      context.verify.mockImplementationOnce(() => {
        started.resolve(undefined);
        return verification.promise;
      });

      const recovery = recoverPendingPurchases(UID, context.deps);
      await started.promise;
      context.setUid(changedUid);
      verification.resolve({ status: 'active', expiresAt: 1000 });

      await expect(recovery).resolves.toMatchObject({ aborted: true, finished: 0 });
      expect(context.verify).toHaveBeenCalledTimes(1);
      expect(context.finish).not.toHaveBeenCalled();
    }
  });

  it('完了処理中のUID変更後は次の取引に進まない', async () => {
    const context = setup([purchase('first'), purchase('second')]);
    const finishing = deferred<void>();
    const started = deferred<void>();
    context.finish.mockImplementationOnce(() => {
      started.resolve(undefined);
      return finishing.promise;
    });

    const recovery = recoverPendingPurchases(UID, context.deps);
    await started.promise;
    context.setUid('another-user');
    finishing.resolve(undefined);

    await expect(recovery).resolves.toMatchObject({ finished: 1, aborted: true });
    expect(context.verify.mock.calls).toEqual([['first']]);
    expect(context.finish).toHaveBeenCalledTimes(1);
  });

  it('一覧取得失敗は集計だけを返し、次回の取得を妨げない', async () => {
    const context = setup();
    context.loadPending.mockRejectedValueOnce({ token: 'private-load-token' });

    const initial = await recoverPendingPurchases(UID, context.deps);

    expect(initial).toEqual({
      finished: 0,
      failed: 0,
      skipped: 0,
      aborted: false,
      loadFailed: true,
    });
    expect(JSON.stringify(initial)).not.toContain('private');
    expect(context.verify).not.toHaveBeenCalled();
    expect(context.finish).not.toHaveBeenCalled();

    await expect(recoverPendingPurchases(UID, context.deps)).resolves.toMatchObject({
      loadFailed: false,
      aborted: false,
    });
    expect(context.loadPending).toHaveBeenCalledTimes(2);
  });
});

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/account/accountOperationRuntime', () => ({
  accountOperationGate: { runNormal: jest.fn() },
}));
jest.mock('@/features/billing/billingClient', () => ({
  loadPendingBillingPurchases: jest.fn(),
  finishPurchaseTransaction: jest.fn(),
}));
jest.mock('@/features/billing/verifyPurchase', () => ({
  verifyApplePurchase: jest.fn(),
}));

it('recoverStartupPurchasesは実gate配下で待機し、UID変更と失敗を安全に終了する', async () => {
  const { recoverStartupPurchases } = jest.requireActual<
    typeof import('@/features/billing/recoverPendingPurchases')
  >('@/features/billing/recoverPendingPurchases');
  const { createAccountOperationGate } = jest.requireActual<
    typeof import('@/features/account/accountOperationGate')
  >('@/features/account/accountOperationGate');
  const firebase = jest.requireMock('@/config/firebase') as jest.Mocked<
    Pick<typeof import('@/config/firebase'), 'getCurrentUid'>
  >;
  const billing = jest.requireMock('@/features/billing/billingClient') as jest.Mocked<
    Pick<typeof import('@/features/billing/billingClient'),
      'loadPendingBillingPurchases' | 'finishPurchaseTransaction'>
  >;
  const verification = jest.requireMock('@/features/billing/verifyPurchase') as jest.Mocked<
    Pick<typeof import('@/features/billing/verifyPurchase'), 'verifyApplePurchase'>
  >;
  const runtime = jest.requireMock('@/features/account/accountOperationRuntime') as {
    accountOperationGate: { runNormal: jest.Mock };
  };

  for (const scenario of [
    'success', 'blocked', 'load-error', 'verify-error', 'finish-error',
    'uid-before', 'uid-load', 'uid-verify', 'uid-finish',
  ]) {
    let uid = scenario === 'uid-before' ? 'another-user' : UID;
    firebase.getCurrentUid.mockReset().mockImplementation(() => uid);
    const gate = createAccountOperationGate({
      getCurrentUid: () => uid,
      getAccountCompletionConfirmed: () => false,
      readDurableBlocked: async () => scenario === 'blocked',
    });
    runtime.accountOperationGate.runNormal.mockReset().mockImplementation(gate.runNormal);
    billing.loadPendingBillingPurchases.mockReset().mockImplementation(async () => {
      if (scenario === 'load-error') throw new Error('private-load');
      if (scenario === 'uid-load') uid = 'another-user';
      return [purchase('first'), purchase('second')];
    });
    verification.verifyApplePurchase.mockReset().mockImplementation(async () => {
      if (scenario === 'verify-error') throw new Error('private-verify');
      if (scenario === 'uid-verify') uid = 'another-user';
      return { status: 'active', expiresAt: 1000 };
    });
    billing.finishPurchaseTransaction.mockReset().mockImplementation(async () => {
      if (scenario === 'finish-error') throw new Error('private-finish');
      if (scenario === 'uid-finish') uid = 'another-user';
    });

    if (scenario === 'success') {
      const started = deferred<void>();
      const finishing = deferred<void>();
      let settled = false;
      billing.finishPurchaseTransaction.mockImplementationOnce(() => {
        started.resolve(undefined);
        return finishing.promise;
      });
      const recovery = recoverStartupPurchases(UID).then(() => {
        settled = true;
      });
      await started.promise;

      expect(settled).toBe(false);
      expect(verification.verifyApplePurchase).toHaveBeenCalledTimes(1);
      let acquired = false;
      const account = gate.acquireAccount(UID).then((lease) => {
        acquired = true;
        return lease;
      });
      expect(acquired).toBe(false);

      finishing.resolve(undefined);
      await expect(recovery).resolves.toBeUndefined();
      (await account).assertCurrentUid();
      await gate.releaseAccount(UID);
      expect(verification.verifyApplePurchase.mock.calls).toEqual([['first'], ['second']]);
      expect(billing.finishPurchaseTransaction).toHaveBeenCalledTimes(2);
      continue;
    }

    await expect(recoverStartupPurchases(UID)).resolves.toBeUndefined();

    if (scenario === 'uid-before' || scenario === 'blocked') {
      expect(billing.loadPendingBillingPurchases).not.toHaveBeenCalled();
    }
    if (['uid-before', 'blocked', 'load-error', 'uid-load'].includes(scenario)) {
      expect(verification.verifyApplePurchase).not.toHaveBeenCalled();
    }
    if (scenario === 'uid-finish') {
      expect(verification.verifyApplePurchase).toHaveBeenCalledTimes(1);
      expect(billing.finishPurchaseTransaction).toHaveBeenCalledTimes(1);
    } else if (scenario === 'finish-error') {
      expect(billing.finishPurchaseTransaction).toHaveBeenCalledTimes(2);
    } else {
      expect(billing.finishPurchaseTransaction).not.toHaveBeenCalled();
    }
  }
});
