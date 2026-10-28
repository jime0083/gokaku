import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

import { AccountWriteBlockedError } from '../../account/accountWriteGuard';
import { ensureAdminApp } from '../../firebaseAdmin';
import { RATE_LIMITS, rateLimitDocPath, RateLimitExceededError } from '../../rateLimit';
import {
  ackXNotice,
  createProductionAckXNoticeDeps,
  handleAckXNoticeRequest,
  type AckXNoticeDeps,
} from '../ackXNoticeCallable';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(host)
  || Number(host.split(':')[1]) > 65535) {
  throw new Error('ackXNotice tests require local demo-gokaku Firestore Emulator');
}

const ID = 'a'.repeat(64);
const NOW = Date.UTC(2026, 9, 27, 3);
const INTERNAL = '処理を完了できませんでした。再度お試しください';
const notice = () => ({
  schemaVersion: 1, id: ID, date: '2026-10-26', linkRevision: 1,
  kind: 'post_failed', readAt: null,
});
function request(uid = 'caller', data: unknown = { noticeId: ID }): Pick<CallableRequest<unknown>, 'auth' | 'data'> {
  return {
    auth: { uid, token: {} as NonNullable<CallableRequest['auth']>['token'], rawToken: 'fixture-only' },
    data,
  };
}
function mockDeps() {
  return {
    enforceRateLimit: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    ackXNotice: jest.fn<ReturnType<AckXNoticeDeps['ackXNotice']>, [string, string]>()
      .mockResolvedValue({ status: 'acknowledged' }),
  };
}
async function errorOf(pending: Promise<unknown>, code: string, message?: string) {
  const error: unknown = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect(error).toMatchObject({ code, ...(message === undefined ? {} : { message }) });
  if (code !== 'resource-exhausted') expect((error as HttpsError).details).toBeUndefined();
  expect(JSON.stringify((error as HttpsError).toJSON())).not.toContain('fixture-private');
  return error as HttpsError;
}

describe('ackXNotice authenticated boundary', () => {
  test.each([undefined, '', ' ', '/', '.', '..', '__reserved__', 'a'.repeat(129), '\u0000', '\ud800'])(
    'invalid auth never reaches dependencies: %p', async (uid) => {
      const input = request();
      input.auth = uid === undefined ? undefined : { ...input.auth!, uid };
      const deps = mockDeps();
      await errorOf(handleAckXNoticeRequest(input, deps), 'unauthenticated', 'ログインが必要です');
      expect(deps.enforceRateLimit).not.toHaveBeenCalled();
      expect(deps.ackXNotice).not.toHaveBeenCalled();
    },
  );
  test.each(['acknowledged', 'unchanged'] as const)('uses only authenticated UID and returns %s', async (status) => {
    const deps = mockDeps();
    deps.ackXNotice.mockResolvedValue({ status });
    await expect(handleAckXNoticeRequest(request('本人'), deps)).resolves.toEqual({ status });
    expect(deps.enforceRateLimit.mock.calls).toEqual([['本人']]);
    expect(deps.ackXNotice.mock.calls).toEqual([['本人', ID]]);
    expect(deps.enforceRateLimit.mock.invocationCallOrder[0])
      .toBeLessThan(deps.ackXNotice.mock.invocationCallOrder[0]);
  });
  test('accepts a null-prototype payload with one own data property', async () => {
    const data = Object.assign(Object.create(null), { noticeId: ID });
    await expect(handleAckXNoticeRequest(request('caller', data), mockDeps()))
      .resolves.toEqual({ status: 'acknowledged' });
  });
  const invalid: unknown[] = [
    undefined, null, [], '', 1, true, {},
    ...['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${ID}\n`, `${ID}\r\n`, ` ${ID}`, `${ID} `]
      .map((noticeId) => ({ noticeId })),
    { noticeId: null }, { noticeId: 1 }, { noticeId: { id: ID } },
    { noticeId: ID, uid: 'victim' }, { noticeId: ID, now: NOW },
    { noticeId: ID, readAt: NOW }, { noticeId: ID, auth: { uid: 'victim' } },
    { noticeId: ID, [Symbol('extra')]: true },
    Object.create({ noticeId: ID }), new Date(NOW),
    Object.defineProperty({ noticeId: ID }, 'hidden', { value: 'fixture-private' }),
    JSON.parse(`{"noticeId":"${ID}","__proto__":{}}`),
  ];
  test.each(invalid.map((data, i) => [i, data] as const))('strict payload case %s counts before rejection', async (_i, data) => {
    const deps = mockDeps();
    const input = request();
    input.data = data;
    await errorOf(handleAckXNoticeRequest(input, deps), 'invalid-argument', '入力が不正です');
    expect(deps.enforceRateLimit.mock.calls).toEqual([['caller']]);
    expect(deps.ackXNotice).not.toHaveBeenCalled();
  });
  test('does not evaluate a noticeId accessor', async () => {
    const getter = jest.fn(() => { throw new Error('fixture-private'); });
    const deps = mockDeps();
    const data = Object.defineProperty({}, 'noticeId', { get: getter, enumerable: true });
    await errorOf(handleAckXNoticeRequest(request('caller', data), deps), 'invalid-argument');
    expect(getter).not.toHaveBeenCalled();
    expect(deps.ackXNotice).not.toHaveBeenCalled();
  });
  test.each(['limit', 'store'] as const)('sanitizes errors from %s', async (phase) => {
    for (const failure of [new Error('fixture-private'), new HttpsError('permission-denied', 'fixture-private', { raw: 'fixture-private' })]) {
      const deps = mockDeps();
      if (phase === 'limit') deps.enforceRateLimit.mockRejectedValue(failure);
      else deps.ackXNotice.mockRejectedValue(failure);
      await errorOf(handleAckXNoticeRequest(request(), deps), 'internal', INTERNAL);
      if (phase === 'limit') expect(deps.ackXNotice).not.toHaveBeenCalled();
    }
  });
  test.each(['missing', 'deleting'] as const)('maps %s to private failed-precondition', async (reason) => {
    for (const phase of ['limit', 'store']) {
      const deps = mockDeps();
      const failure = new AccountWriteBlockedError(reason);
      failure.message = 'fixture-private';
      if (phase === 'limit') deps.enforceRateLimit.mockRejectedValue(failure);
      else deps.ackXNotice.mockRejectedValue(failure);
      await errorOf(handleAckXNoticeRequest(request(), deps), 'failed-precondition');
    }
  });
  test('rate rejection precedes even invalid payload and hides mutated errors', async () => {
    const deps = mockDeps();
    const failure = new RateLimitExceededError('x-notice-ack');
    failure.message = 'fixture-private';
    deps.enforceRateLimit.mockRejectedValue(failure);
    const error = await errorOf(handleAckXNoticeRequest(request('caller', null), deps), 'resource-exhausted');
    expect(error.details).toEqual({ reason: 'rate-limited' });
    expect(deps.ackXNotice).not.toHaveBeenCalled();
  });
  test('strictly validates dependency result without invoking accessors', async () => {
    const getter = jest.fn(() => 'acknowledged');
    const invalidResults: unknown[] = [
      null, undefined, [], 'acknowledged', {}, { status: 'fixture-private' },
      { status: 'acknowledged', raw: 'fixture-private' },
      Object.create({ status: 'acknowledged' }),
      Object.defineProperty({}, 'status', { get: getter, enumerable: true }),
      Object.defineProperty({ status: 'unchanged' }, 'hidden', { value: 'fixture-private' }),
      { status: 'unchanged', [Symbol('extra')]: 'fixture-private' },
    ];
    for (const result of invalidResults) {
      const deps = mockDeps();
      deps.ackXNotice.mockResolvedValue(result as Awaited<ReturnType<AckXNoticeDeps['ackXNotice']>>);
      await errorOf(handleAckXNoticeRequest(request(), deps), 'internal', INTERNAL);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  test('public callable uses the existing region and index export', async () => {
    expect(ackXNotice.__endpoint.region).toEqual(['asia-northeast1']);
    expect(readFileSync(resolve(__dirname, '../../index.ts'), 'utf8'))
      .toContain("export { ackXNotice } from './xPosting/ackXNoticeCallable';");
    await errorOf(ackXNotice.run({ data: { noticeId: ID } } as CallableRequest<unknown>), 'unauthenticated');
  });
});

describe('production dependency factory with real Emulator', () => {
  const owned = new Set<string>();
  const db = () => { ensureAdminApp(); return getFirestore(); };
  async function user(extra: Record<string, unknown> = {}) {
    const uid = `notice-callable-${randomUUID()}`;
    owned.add(uid);
    const ref = db().doc(`users/${uid}`);
    await ref.create({ xNotice: notice(), preserved: true, ...extra });
    return ref;
  }
  afterEach(async () => {
    try {
      await Promise.all([...owned].map(async (uid) => {
        const counters = await db().collection('rateLimits')
          .where(FieldPath.documentId(), '>=', `${uid}_`)
          .where(FieldPath.documentId(), '<', `${uid}_\uf8ff`).get();
        await Promise.all([
          db().recursiveDelete(db().doc(`users/${uid}`)),
          ...counters.docs.map((entry) => entry.ref.delete()),
        ]);
      }));
    } finally { owned.clear(); }
  });
  test('factory acknowledges caller only and uses injected server clock', async () => {
    const owner = await user();
    const other = await user();
    const before = (await other.get()).data();
    const deps = createProductionAckXNoticeDeps({ now: () => NOW }, () => NOW + 123);
    await expect(handleAckXNoticeRequest(request(owner.id), deps)).resolves.toEqual({ status: 'acknowledged' });
    expect((await owner.get()).data()).toEqual({ xNotice: { ...notice(), readAt: NOW + 123 }, preserved: true });
    expect((await other.get()).data()).toEqual(before);
    expect((await db().doc(rateLimitDocPath(owner.id, 'x-notice-ack', NOW)).get()).get('count')).toBe(1);
  });
  test('dedicated ten-per-minute limit preserves existing limits, users and minute isolation', async () => {
    expect(RATE_LIMITS).toMatchObject({
      'study-event': 60, 'purchase-verify': 10, 'history-initialize': 10, 'x-notice-ack': 10,
    });
    const owner = await user();
    const other = await user();
    let now = NOW;
    const deps = createProductionAckXNoticeDeps({ now: () => now }, () => now);
    for (let i = 0; i < 10; i += 1) {
      await expect(handleAckXNoticeRequest(request(owner.id), deps))
        .resolves.toEqual({ status: i === 0 ? 'acknowledged' : 'unchanged' });
    }
    const before = await owner.get();
    await errorOf(handleAckXNoticeRequest(request(owner.id), deps), 'resource-exhausted');
    expect((await owner.get()).updateTime).toEqual(before.updateTime);
    expect((await db().doc(rateLimitDocPath(owner.id, 'x-notice-ack', NOW)).get()).get('count')).toBe(10);
    for (const kind of ['study-event', 'purchase-verify', 'history-initialize'] as const) {
      expect((await db().doc(rateLimitDocPath(owner.id, kind, NOW)).get()).exists).toBe(false);
    }
    await expect(handleAckXNoticeRequest(request(other.id), deps)).resolves.toEqual({ status: 'acknowledged' });
    now += 60000;
    await expect(handleAckXNoticeRequest(request(owner.id), deps)).resolves.toEqual({ status: 'unchanged' });
  });
  test('malformed payload consumes dedicated quota without changing notice', async () => {
    const owner = await user();
    const before = await owner.get();
    await errorOf(handleAckXNoticeRequest(request(owner.id, { noticeId: ID, uid: 'victim' }),
      createProductionAckXNoticeDeps({ now: () => NOW })), 'invalid-argument');
    expect((await owner.get()).updateTime).toEqual(before.updateTime);
    expect((await db().doc(rateLimitDocPath(owner.id, 'x-notice-ack', NOW)).get()).get('count')).toBe(1);
  });
  test.each(['missing', 'deleting'] as const)('rejects %s without recreating parent or quota', async (state) => {
    const owner = await user(state === 'deleting' ? { deletionInProgress: true } : {});
    if (state === 'missing') await owner.delete();
    const before = await owner.get();
    await errorOf(handleAckXNoticeRequest(request(owner.id),
      createProductionAckXNoticeDeps({ now: () => NOW })), 'failed-precondition');
    expect((await owner.get()).data()).toEqual(before.data());
    expect((await db().doc(rateLimitDocPath(owner.id, 'x-notice-ack', NOW)).get()).exists).toBe(false);
  });
  test('malformed persisted notice becomes generic internal error without disclosure or mutation', async () => {
    const owner = await user({ xNotice: { ...notice(), kind: 'fixture-private' } });
    const before = await owner.get();
    await errorOf(handleAckXNoticeRequest(request(owner.id),
      createProductionAckXNoticeDeps({ now: () => NOW })), 'internal', INTERNAL);
    expect((await owner.get()).updateTime).toEqual(before.updateTime);
    expect((await owner.get()).data()).toEqual(before.data());
  });
});
