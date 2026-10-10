import { getFirestore } from 'firebase-admin/firestore';

import { toJstDateKey } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';
import { handleRecordStudyEventRequest } from '../studySession/recordStudyEvent';
import {
  recordStudySessionEvent,
  RecordStudySessionEventError,
  type RecordStudySessionEventDeps,
  type RecordStudySessionEventInput,
} from '../studySession/recordStudySessionEvent';
import { getFirestoreDoc } from './emulator';

/**
 * 5-1b-1: 計測記録を受け取る Function のテスト(Emulator 上。requirements 3-2「アプリからの記録の保存」)。
 */

function uniqueId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildDeps(now: number): RecordStudySessionEventDeps {
  return { now: () => now };
}

/** テスト対象の uid 配下に有効な目標(goals/{goalId})を作る */
async function createGoal(uid: string, goalId: string): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`users/${uid}/goals/${goalId}`).set({ type: 'cert' });
}

async function createDailyResult(uid: string, dateKey: string): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`users/${uid}/dailyResults/${dateKey}`).set({ studiedMinutes: 0 });
}

function buildInput(overrides: Partial<RecordStudySessionEventInput> & { sessionId: string; goalId: string }): RecordStudySessionEventInput {
  return {
    action: 'start',
    source: 'app',
    clientTimeMs: Date.now(),
    idempotencyKey: uniqueId('evt'),
    ...overrides,
  };
}

describe('recordStudySessionEvent', () => {
  it('開始→停止の保存(2回のイベントで startAt・stopAt の両方が揃う)', async () => {
    const uid = uniqueId('uid-start-stop');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const startAtMs = Date.now() - 60_000;
    const stopAtMs = Date.now();
    const deps = buildDeps(Date.now() + 1000);

    const startResult = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: startAtMs }),
      deps,
    );
    expect(startResult).toEqual({ status: 'recorded' });

    const stopResult = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: stopAtMs }),
      deps,
    );
    expect(stopResult).toEqual({ status: 'recorded' });

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(startAtMs);
    expect(session?.stopAt).toBe(stopAtMs);
    expect(session?.goalId).toBe(goalId);
    expect(session?.source).toBe('app');
    expect(session?.endReason).toBe('manual');
  });

  it('同じ idempotencyKey を再送しても二重に記録されない(2回目は no-op)', async () => {
    const uid = uniqueId('uid-replay');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const clientTimeMs = Date.now() - 1000;
    const idempotencyKey = uniqueId('evt');
    const deps = buildDeps(Date.now() + 1000);
    const input = buildInput({ sessionId, goalId, action: 'start', clientTimeMs, idempotencyKey });

    const first = await recordStudySessionEvent(uid, input, deps);
    expect(first).toEqual({ status: 'recorded' });

    // 2回目は別の(あり得ない)時刻を送っても上書きされない(リプレイとして無視される)
    const second = await recordStudySessionEvent(
      uid,
      { ...input, clientTimeMs: clientTimeMs + 999_999 },
      deps,
    );
    expect(second).toEqual({ status: 'duplicate' });

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(clientTimeMs);
  });

  it('停止が先に届いても、後から届いた開始と揃って正しいセッションになる', async () => {
    const uid = uniqueId('uid-stop-first');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const startAtMs = Date.now() - 30_000;
    const stopAtMs = Date.now();
    const deps = buildDeps(Date.now() + 1000);

    const stopResult = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: stopAtMs }),
      deps,
    );
    expect(stopResult).toEqual({ status: 'recorded' });

    const startResult = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: startAtMs }),
      deps,
    );
    expect(startResult).toEqual({ status: 'recorded' });

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(startAtMs);
    expect(session?.stopAt).toBe(stopAtMs);
  });

  it('同じ sessionId にすでにある startAt を、別の値の start で上書きしようとしても最初の値が残る', async () => {
    const uid = uniqueId('uid-overwrite');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const firstStartAtMs = Date.now() - 100_000;
    const deps = buildDeps(Date.now() + 1000);

    await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: firstStartAtMs }),
      deps,
    );
    // 別の idempotencyKey(≠リプレイ)で、同じ sessionId に異なる開始時刻を送る
    await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: firstStartAtMs + 50_000 }),
      deps,
    );

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(firstStartAtMs);
  });

  it('端末時刻がサーバー受信時刻より未来だと、受信時刻に補正される', async () => {
    const uid = uniqueId('uid-future');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const serverNowMs = Date.now();
    const futureClientTimeMs = serverNowMs + 10 * 60 * 1000;
    const deps = buildDeps(serverNowMs);

    const result = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: futureClientTimeMs }),
      deps,
    );
    expect(result).toEqual({ status: 'recorded' });

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(serverNowMs);
  });

  it('端末時刻の日付の判定(dailyResults)がすでに確定していると、受信時刻に補正される', async () => {
    const uid = uniqueId('uid-judged');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const serverNowMs = Date.now();
    // 判定済みの過去の日付に属する端末時刻(未来ではない)
    const pastClientTimeMs = serverNowMs - 3 * 24 * 60 * 60 * 1000;
    const dateKey = toJstDateKey(pastClientTimeMs);
    await createDailyResult(uid, dateKey);
    const deps = buildDeps(serverNowMs);

    const result = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: pastClientTimeMs }),
      deps,
    );
    expect(result).toEqual({ status: 'recorded' });

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.stopAt).toBe(serverNowMs);
  });

  it('判定が確定していない日付の端末時刻は、補正されずそのまま使われる', async () => {
    const uid = uniqueId('uid-not-judged');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);

    const serverNowMs = Date.now();
    const pastClientTimeMs = serverNowMs - 60_000;
    const deps = buildDeps(serverNowMs);

    await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId, action: 'start', clientTimeMs: pastClientTimeMs }),
      deps,
    );

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.startAt).toBe(pastClientTimeMs);
  });

  it('架空の goalId(本人の目標として存在しない)は RecordStudySessionEventError(goal-not-found)', async () => {
    const uid = uniqueId('uid-no-goal');
    const sessionId = uniqueId('session');
    const deps = buildDeps(Date.now());

    const error = await recordStudySessionEvent(
      uid,
      buildInput({ sessionId, goalId: uniqueId('ghost-goal'), action: 'start' }),
      deps,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(RecordStudySessionEventError);
    expect((error as RecordStudySessionEventError).reason).toBe('goal-not-found');

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session).toBeNull();
  });

  it('他人の goalId(別ユーザーの目標)は使えない', async () => {
    const ownerUid = uniqueId('uid-owner');
    const otherUid = uniqueId('uid-other');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(ownerUid, goalId);
    const deps = buildDeps(Date.now());

    const error = await recordStudySessionEvent(
      otherUid,
      buildInput({ sessionId, goalId, action: 'start' }),
      deps,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(RecordStudySessionEventError);
    expect((error as RecordStudySessionEventError).reason).toBe('goal-not-found');
  });
});

describe('handleRecordStudyEventRequest', () => {
  it('未認証(auth なし)は HttpsError(unauthenticated)', async () => {
    const deps = buildDeps(Date.now());

    const error = await handleRecordStudyEventRequest(
      { auth: undefined, data: buildInput({ sessionId: 's1', goalId: 'g1' }) },
      deps,
    ).catch((e) => e);

    expect(error).toMatchObject({ code: 'unauthenticated' });
  });

  it('request.auth.uid のもとに保存される(data に含めた別 uid は無視される。なりすまし防止)', async () => {
    const authUid = uniqueId('uid-auth');
    const otherUid = uniqueId('uid-other-in-data');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(authUid, goalId);
    const deps = buildDeps(Date.now());
    const authData = { uid: authUid, token: {} as never, rawToken: '' };

    const result = await handleRecordStudyEventRequest(
      { auth: authData, data: { ...buildInput({ sessionId, goalId }), uid: otherUid } },
      deps,
    );
    expect(result).toEqual({ status: 'recorded' });

    const ownSession = await getFirestoreDoc(`users/${authUid}/sessions/${sessionId}`);
    expect(ownSession).not.toBeNull();
    const otherSession = await getFirestoreDoc(`users/${otherUid}/sessions/${sessionId}`);
    expect(otherSession).toBeNull();
  });

  it('架空の goalId は HttpsError(invalid-argument)', async () => {
    const authUid = uniqueId('uid-bad-goal');
    const deps = buildDeps(Date.now());
    const authData = { uid: authUid, token: {} as never, rawToken: '' };

    const error = await handleRecordStudyEventRequest(
      { auth: authData, data: buildInput({ sessionId: uniqueId('session'), goalId: uniqueId('ghost') }) },
      deps,
    ).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid-argument' });
  });

  describe('不正な入力(HttpsError(invalid-argument))', () => {
    const authUid = uniqueId('uid-invalid');
    const authData = { uid: authUid, token: {} as never, rawToken: '' };
    const deps = buildDeps(Date.now());
    const base = () => buildInput({ sessionId: uniqueId('session'), goalId: uniqueId('goal') });

    it.each<[string, Record<string, unknown>]>([
      ['data が object でない', ['not', 'an', 'object'] as unknown as Record<string, unknown>],
      ['action が不正な値', { ...base(), action: 'confirm' }],
      ['source が不正な値', { ...base(), source: 'live_activity' }],
      ['clientTimeMs が数値でない', { ...base(), clientTimeMs: 'now' }],
      ['clientTimeMs が NaN', { ...base(), clientTimeMs: Number.NaN }],
      ['clientTimeMs が Infinity', { ...base(), clientTimeMs: Number.POSITIVE_INFINITY }],
      ['sessionId が空文字', { ...base(), sessionId: '' }],
      ['sessionId に区切り文字(/)を含む', { ...base(), sessionId: 'a/b' }],
      ['sessionId に相対パス(..)を含む', { ...base(), sessionId: '..' }],
      ['idempotencyKey が空文字', { ...base(), idempotencyKey: '' }],
      ['idempotencyKey に区切り文字(/)を含む', { ...base(), idempotencyKey: 'a/b' }],
      ['goalId が空文字', { ...base(), goalId: '' }],
      ['goalId に区切り文字(/)を含む', { ...base(), goalId: 'a/b' }],
      ['sessionId が欠落', (() => { const { sessionId, ...rest } = base(); return rest; })()],
    ])('%s', async (_label, data) => {
      const error = await handleRecordStudyEventRequest({ auth: authData, data }, deps).catch((e) => e);
      expect(error).toMatchObject({ code: 'invalid-argument' });
    });
  });
});
