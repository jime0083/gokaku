import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';

import {
  buildServerHistory,
  ServerHistoryError,
  type ServerHistoryResult,
  type ServerHistoryStream,
} from '../serverHistory';

jest.mock('firebase-admin/firestore', () => {
  const actual = jest.requireActual('firebase-admin/firestore');
  return {
    ...actual,
    getFirestore: jest.fn(() => {
      throw new Error('Unexpected Firestore I/O');
    }),
  };
});

const counters = () => ({ goal: 2, settings: 3, xLink: 4, subscription: 5 });
const user = (): Record<string, unknown> => ({
  judgementHistoryStartedAt: new Timestamp(100, 123),
  judgementRevisions: counters(),
  xPostEnabled: false,
  xLinked: false,
  subscription: {
    expiresAt: 1000,
    status: 'active',
    productId: 'fixture-product',
    originalTransactionId: 'fixture-transaction',
  },
  xUsername: 'fixture-name',
  encryptedAccessToken: 'fixture-only-token',
  signedTransaction: 'fixture-only-jws',
});

function onlyEntry(result: ServerHistoryResult, stream: ServerHistoryStream) {
  const matches = result.entries.filter((entry) => entry.stream === stream);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function rejected(
  current: Record<string, unknown>,
  patch: Record<string, unknown> = { xPostEnabled: true },
) {
  let caught: unknown;
  try {
    buildServerHistory(current, patch);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServerHistoryError);
  expect((caught as Error).name).toBe('ServerHistoryError');
  expect((caught as Error).message).toBe('Judgement history generation failed');
  expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('serverHistory: current user + actual parent update patch', () => {
  test('X確認のsettings+xLinkを同時生成し、必要counterだけ部分更新する', () => {
    const result = buildServerHistory(user(), {
      xPostEnabled: true,
      xLinked: true,
      xUsername: 'updated-fixture-name',
    });
    expect(result.counterPatch).toEqual({
      'judgementRevisions.settings': 4,
      'judgementRevisions.xLink': 5,
    });
    expect(result.entries).toHaveLength(2);
    const settings = onlyEntry(result, 'settings');
    const link = onlyEntry(result, 'xLink');
    expect(settings).toEqual({
      stream: 'settings',
      revisionId: '4',
      data: {
        schemaVersion: 1,
        revision: 4,
        committedAt: expect.any(FieldValue),
        before: { xPostEnabled: false },
        after: { xPostEnabled: true },
      },
    });
    expect(link).toEqual({
      stream: 'xLink',
      revisionId: '5',
      data: {
        schemaVersion: 1,
        revision: 5,
        committedAt: expect.any(FieldValue),
        before: { xLinked: false },
        after: { xLinked: true },
      },
    });
    for (const entry of result.entries) {
      expect(entry.data.committedAt.isEqual(FieldValue.serverTimestamp())).toBe(true);
    }
  });

  test('3streamを一度に生成し、subscriptionの余分な情報を捨てる', () => {
    const result = buildServerHistory(user(), {
      xPostEnabled: true,
      xLinked: true,
      subscription: {
        expiresAt: 2000,
        status: 'expired',
        productId: 'next-fixture-product',
        signedTransaction: 'next-fixture-jws',
      },
    });
    expect(result.counterPatch).toEqual({
      'judgementRevisions.settings': 4,
      'judgementRevisions.xLink': 5,
      'judgementRevisions.subscription': 6,
    });
    expect(result.entries).toHaveLength(3);
    expect(onlyEntry(result, 'subscription')).toEqual({
      stream: 'subscription',
      revisionId: '6',
      data: {
        schemaVersion: 1,
        revision: 6,
        committedAt: expect.any(FieldValue),
        before: { expiresAt: 1000 },
        after: { expiresAt: 2000 },
      },
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'fixture-only-token', 'fixture-only-jws', 'next-fixture-jws',
      'originalTransactionId', 'productId', 'xUsername', 'status',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('before=afterの明示保存もcounterを進める', () => {
    const result = buildServerHistory(user(), { xPostEnabled: false });
    expect(result.counterPatch).toEqual({ 'judgementRevisions.settings': 4 });
    expect(result.entries).toHaveLength(1);
    expect(onlyEntry(result, 'settings').data).toMatchObject({
      before: { xPostEnabled: false },
      after: { xPostEnabled: false },
    });
  });

  test('関係のない親フィールドだけの更新では履歴を作らない', () => {
    expect(buildServerHistory(user(), { xUsername: 'fixture-new-name' }))
      .toEqual({ counterPatch: {}, entries: [] });
  });

  test('subscriptionのnullとexpiresAt:nullを区別する', () => {
    const purchased = buildServerHistory(
      { ...user(), subscription: null },
      { subscription: { expiresAt: null, status: 'active' } },
    );
    expect(onlyEntry(purchased, 'subscription').data).toMatchObject({
      before: null,
      after: { expiresAt: null },
    });
    const removed = buildServerHistory(user(), { subscription: null });
    expect(onlyEntry(removed, 'subscription').data).toMatchObject({
      before: { expiresAt: 1000 },
      after: null,
    });
  });

  test('subscription.expiresAtの実update field pathもafterへ反映する', () => {
    const result = buildServerHistory(user(), {
      'subscription.expiresAt': 2500,
      'subscription.status': 'active',
    });
    expect(result.counterPatch).toEqual({ 'judgementRevisions.subscription': 6 });
    expect(result.entries).toHaveLength(1);
    expect(onlyEntry(result, 'subscription').data).toMatchObject({
      before: { expiresAt: 1000 },
      after: { expiresAt: 2500 },
    });
  });

  test('subscription全体置換でexpiresAtが消えると元値で補わず拒否する', () => {
    rejected(user(), { subscription: { status: 'active' } });
    rejected(user(), {
      subscription: { expiresAt: 2000 },
      'subscription.expiresAt': 3000,
    });
  });

  test('両metadata absentのlegacyはsnapshotを補完せず何も生成しない', () => {
    expect(buildServerHistory({}, { subscription: { expiresAt: 2000 } }))
      .toEqual({ counterPatch: {}, entries: [] });
    expect(buildServerHistory(
      { subscription: null },
      { xPostEnabled: true, xLinked: true },
    )).toEqual({ counterPatch: {}, entries: [] });
  });

  test('metadata片方のみ・明示undefined/nullはlegacyとして扱わない', () => {
    const at = new Timestamp(100, 0);
    for (const metadata of [
      { judgementHistoryStartedAt: at },
      { judgementRevisions: counters() },
      { judgementHistoryStartedAt: undefined, judgementRevisions: undefined },
      { judgementHistoryStartedAt: null, judgementRevisions: null },
    ]) {
      rejected({ xPostEnabled: false, ...metadata });
    }
  });

  test('未更新streamも含む全4counterをpositive safe integerとして検証する', () => {
    for (const stream of ['goal', 'settings', 'xLink', 'subscription'] as const) {
      rejected({
        ...user(),
        judgementRevisions: { ...counters(), [stream]: 0 },
      });
    }
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '3', null]) {
      rejected({
        ...user(),
        judgementRevisions: { ...counters(), settings: value },
      });
    }
    const missing: Record<string, unknown> = counters();
    delete missing.subscription;
    rejected({ ...user(), judgementRevisions: missing });
    rejected({ ...user(), judgementRevisions: [] });
  });

  test('更新counterのoverflowを拒否し、安全整数上限への到達は許可する', () => {
    rejected({
      ...user(),
      judgementRevisions: { ...counters(), settings: Number.MAX_SAFE_INTEGER },
    });
    const result = buildServerHistory({
      ...user(),
      judgementRevisions: { ...counters(), settings: Number.MAX_SAFE_INTEGER - 1 },
    }, { xPostEnabled: true });
    expect(result.counterPatch).toEqual({
      'judgementRevisions.settings': Number.MAX_SAFE_INTEGER,
    });
    expect(onlyEntry(result, 'settings').revisionId)
      .toBe(String(Number.MAX_SAFE_INTEGER));
  });

  test('開始時刻はSDK Timestamp必須で、改ざんされた秒/nanoも拒否する', () => {
    const malformed = (seconds: number, nanoseconds: number) => {
      const value = Object.create(Timestamp.prototype);
      Object.defineProperties(value, {
        seconds: { value: seconds },
        nanoseconds: { value: nanoseconds },
      });
      return value;
    };
    for (const value of [
      { seconds: 100, nanoseconds: 0 },
      new Date(0),
      FieldValue.serverTimestamp(),
      malformed(253402300800, 0),
      malformed(-62135596801, 0),
      malformed(100.5, 0),
      malformed(100, -1),
      malformed(100, 1000000000),
    ]) {
      rejected({ ...user(), judgementHistoryStartedAt: value });
    }
    expect(buildServerHistory({
      ...user(),
      judgementHistoryStartedAt: new Timestamp(-62135596800, 0),
    }, { xPostEnabled: true }).entries).toHaveLength(1);
  });

  test('削除中の元userはlegacyも含め拒否する', () => {
    rejected({ ...user(), deletionInProgress: true });
    rejected({ deletionInProgress: true });
  });

  test('不正boolean snapshotのbefore/afterを正常値へ補完しない', () => {
    for (const field of ['xPostEnabled', 'xLinked'] as const) {
      const current = user();
      delete current[field];
      rejected(current, { [field]: true });
      rejected({ ...user(), [field]: null }, { [field]: true });
      rejected(user(), { [field]: 'true' });
      rejected(user(), { [field]: undefined });
      rejected(user(), { [field]: FieldValue.delete() });
    }
  });

  test('initialized subscriptionのmissingは明示nullへ変換しない', () => {
    const missing = user();
    delete missing.subscription;
    rejected(missing, { subscription: { expiresAt: 2000 } });
    rejected({ ...user(), subscription: undefined }, { subscription: null });
  });

  test('subscriptionの不正before/afterとtransformを拒否する', () => {
    for (const value of [
      undefined, {}, [], { expiresAt: undefined }, { expiresAt: NaN },
      { expiresAt: Infinity }, { expiresAt: '1000' },
      { expiresAt: new Timestamp(100, 0) },
      FieldValue.delete(),
    ]) {
      rejected({ ...user(), subscription: value }, { subscription: null });
      rejected(user(), { subscription: value });
    }
    rejected(user(), { 'subscription.expiresAt': FieldValue.delete() });
    rejected(user(), { 'subscription.expiresAt': FieldValue.increment(1) });
  });

  test('入力user/patchを変更せず、同じ入力の再計算でcounterを累積しない', () => {
    const revisions = Object.freeze(counters());
    const subscription = Object.freeze({ expiresAt: 1000, status: 'active' });
    const current = Object.freeze({
      ...user(), judgementRevisions: revisions, subscription,
    });
    const nextSubscription = Object.freeze({ expiresAt: 2000, status: 'active' });
    const patch = Object.freeze({ subscription: nextSubscription, xLinked: true });
    const first = buildServerHistory(current, patch);
    const second = buildServerHistory(current, patch);
    expect(first.counterPatch).toEqual(second.counterPatch);
    expect(first.entries).toHaveLength(2);
    expect(second.entries).toHaveLength(2);
    expect(current.judgementRevisions).toBe(revisions);
    expect(current.subscription).toBe(subscription);
    expect(patch.subscription).toBe(nextSubscription);
    expect(current.subscription.expiresAt).toBe(1000);
    expect(onlyEntry(first, 'subscription').data.after).not.toBe(nextSubscription);
  });

  test('I/Oとclockを使わず同期的にSDK serverTimestampを返す', () => {
    const now = jest.spyOn(Timestamp, 'now').mockImplementation(() => {
      throw new Error('Unexpected Timestamp.now');
    });
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Unexpected Date.now');
    });
    const result = buildServerHistory(user(), { xPostEnabled: true });
    expect(result).not.toBeInstanceOf(Promise);
    expect(onlyEntry(result, 'settings').data.committedAt
      .isEqual(FieldValue.serverTimestamp())).toBe(true);
    expect(getFirestore).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(dateNow).not.toHaveBeenCalled();
  });
});
