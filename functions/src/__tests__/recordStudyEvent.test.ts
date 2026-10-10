import { getFirestore } from 'firebase-admin/firestore';

import { addDays, jstStartOfDay, toJstDateKey } from '../domain';
import { ensureAdminApp } from '../firebaseAdmin';
import { RATE_LIMITS, rateLimitDocPath } from '../rateLimit';
import { handleRecordStudyEventRequest } from '../studySession/recordStudyEvent';
import {
  MAX_CONFIRMATIONS_PER_SESSION,
  recordStudySessionEvent,
  RecordStudySessionEventError,
  type RecordStudySessionEventDeps,
  type RecordStudySessionEventInput,
} from '../studySession/recordStudySessionEvent';
import { getFirestoreDoc } from './emulator';

/**
 * 5-1b-1・5-2a: 計測記録を受け取る Function のテスト(Emulator 上。requirements 3-2「アプリからの記録の保存」)。
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

/** confirmations[] を直接セットした sessions ドキュメントを作る(上限境界のテスト用) */
async function createSessionWithConfirmations(
  uid: string,
  sessionId: string,
  confirmations: number[],
): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`users/${uid}/sessions/${sessionId}`).set({ confirmations });
}

function buildInput(overrides: Partial<RecordStudySessionEventInput> & { sessionId: string; goalId: string }): RecordStudySessionEventInput {
  return {
    action: 'start',
    source: 'app',
    clientTimeMs: Date.now(),
    idempotencyKey: uniqueId('evt'),
    // action のデフォルトが 'start' なので、呼び出し側が明示しなくても必須項目を満たすようにしておく
    // (start 以外の action では無視される値なので、上書きしなくても害はない)
    checkEnabled: true,
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

  describe('checkEnabled の保存(5-2a)', () => {
    it('start の checkEnabled を保存し、既にある場合は最初の値を残す', async () => {
      const uid = uniqueId('uid-check-enabled');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);
      const deps = buildDeps(Date.now() + 1000);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'start', checkEnabled: false }),
        deps,
      );
      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.checkEnabled).toBe(false);

      // 別の idempotencyKey(リプレイではない)で同じ sessionId に異なる checkEnabled を送っても上書きされない
      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'start', checkEnabled: true }),
        deps,
      );
      const session2 = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session2?.checkEnabled).toBe(false);
    });

    it('start 以外(stop・confirm)で送られた checkEnabled は無視される(保存されない)', async () => {
      const uid = uniqueId('uid-check-ignore');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);
      const deps = buildDeps(Date.now() + 1000);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'stop', checkEnabled: true }),
        deps,
      );

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.checkEnabled).toBeUndefined();
    });
  });

  describe('confirm(「勉強中？」確認への応答。5-2a)', () => {
    it('応答時刻(補正なし)を confirmations[] に追加する', async () => {
      const uid = uniqueId('uid-confirm');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const startAtMs = Date.now() - 120_000;
      const confirmAtMs = Date.now() - 60_000;
      const deps = buildDeps(Date.now() + 1000);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'start', clientTimeMs: startAtMs }),
        deps,
      );
      const result = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: confirmAtMs }),
        deps,
      );
      expect(result).toEqual({ status: 'recorded' });

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toEqual([confirmAtMs]);
    });

    it('端末時刻が未来だと、受信時刻に補正されて confirmations[] に追加される', async () => {
      const uid = uniqueId('uid-confirm-future');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const serverNowMs = Date.now();
      const futureClientTimeMs = serverNowMs + 5 * 60 * 1000;
      const deps = buildDeps(serverNowMs);

      const result = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: futureClientTimeMs }),
        deps,
      );
      expect(result).toEqual({ status: 'recorded' });

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toEqual([serverNowMs]);
    });

    it('confirm が start より先に届いても保存でき、後から届いた start と両立する', async () => {
      const uid = uniqueId('uid-confirm-first');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const confirmAtMs = Date.now() - 30_000;
      const startAtMs = Date.now() - 90_000;
      const deps = buildDeps(Date.now() + 1000);

      const confirmResult = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: confirmAtMs }),
        deps,
      );
      expect(confirmResult).toEqual({ status: 'recorded' });

      let session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toEqual([confirmAtMs]);
      expect(session?.startAt).toBeUndefined();

      const startResult = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'start', clientTimeMs: startAtMs }),
        deps,
      );
      expect(startResult).toEqual({ status: 'recorded' });

      session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.startAt).toBe(startAtMs);
      expect(session?.confirmations).toEqual([confirmAtMs]);
    });

    it('同じ idempotencyKey の confirm を再送しても confirmations に二重に追加されない', async () => {
      const uid = uniqueId('uid-confirm-replay');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const confirmAtMs = Date.now() - 10_000;
      const idempotencyKey = uniqueId('evt');
      const deps = buildDeps(Date.now() + 1000);
      const input = buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: confirmAtMs, idempotencyKey });

      const first = await recordStudySessionEvent(uid, input, deps);
      expect(first).toEqual({ status: 'recorded' });

      // 2回目は別の(あり得ない)時刻を送っても追加されない(リプレイとして無視される)
      const second = await recordStudySessionEvent(uid, { ...input, clientTimeMs: confirmAtMs + 999_999 }, deps);
      expect(second).toEqual({ status: 'duplicate' });

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toEqual([confirmAtMs]);
    });

    it('複数回の confirm がすべて confirmations[] に積まれる', async () => {
      const uid = uniqueId('uid-confirm-multi');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const firstConfirmAtMs = Date.now() - 300_000;
      const secondConfirmAtMs = Date.now() - 200_000;
      const deps = buildDeps(Date.now() + 1000);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: firstConfirmAtMs }),
        deps,
      );
      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: secondConfirmAtMs }),
        deps,
      );

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toHaveLength(2);
      expect(session?.confirmations).toEqual(expect.arrayContaining([firstConfirmAtMs, secondConfirmAtMs]));
    });

    it('confirmations が上限の1つ手前なら、もう1件追加できる(境界)', async () => {
      const uid = uniqueId('uid-confirm-limit-ok');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);
      const existing = Array.from({ length: MAX_CONFIRMATIONS_PER_SESSION - 1 }, (_, i) => Date.now() - i);
      await createSessionWithConfirmations(uid, sessionId, existing);
      const deps = buildDeps(Date.now() + 1000);

      const result = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: Date.now() }),
        deps,
      );
      expect(result).toEqual({ status: 'recorded' });

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toHaveLength(MAX_CONFIRMATIONS_PER_SESSION);
    });

    it('confirmations が上限件数に達していると、それ以上は追加できない(境界。confirmation-limit-exceeded)', async () => {
      const uid = uniqueId('uid-confirm-limit-ng');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);
      const existing = Array.from({ length: MAX_CONFIRMATIONS_PER_SESSION }, (_, i) => Date.now() - i);
      await createSessionWithConfirmations(uid, sessionId, existing);
      const deps = buildDeps(Date.now() + 1000);

      const error = await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'confirm', clientTimeMs: Date.now() }),
        deps,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(RecordStudySessionEventError);
      expect((error as RecordStudySessionEventError).reason).toBe('confirmation-limit-exceeded');

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.confirmations).toHaveLength(MAX_CONFIRMATIONS_PER_SESSION);
    });
  });

  describe('時刻補正の境界(problem の軽微な指摘。5-2a で常設)', () => {
    it('端末時刻とサーバー受信時刻がちょうど同じときは補正しない', async () => {
      const uid = uniqueId('uid-boundary-equal');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const serverNowMs = Date.now();
      const deps = buildDeps(serverNowMs);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: serverNowMs }),
        deps,
      );

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.stopAt).toBe(serverNowMs);
    });

    it('日本時間の 0:00.000 はその日に属するので、前日が判定確定済みでも補正しない', async () => {
      const uid = uniqueId('uid-boundary-midnight');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const serverNowMs = Date.now();
      const todayKey = toJstDateKey(serverNowMs);
      const yesterdayKey = addDays(todayKey, -1);
      await createDailyResult(uid, yesterdayKey);
      const startOfTodayMs = jstStartOfDay(todayKey);
      const deps = buildDeps(serverNowMs);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: startOfTodayMs }),
        deps,
      );

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.stopAt).toBe(startOfTodayMs);
    });

    it('0:00 の1ミリ秒前は前日に属するので、前日が判定確定済みなら補正する', async () => {
      const uid = uniqueId('uid-boundary-before-midnight');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(uid, goalId);

      const serverNowMs = Date.now();
      const todayKey = toJstDateKey(serverNowMs);
      const yesterdayKey = addDays(todayKey, -1);
      await createDailyResult(uid, yesterdayKey);
      const justBeforeMidnightMs = jstStartOfDay(todayKey) - 1;
      const deps = buildDeps(serverNowMs);

      await recordStudySessionEvent(
        uid,
        buildInput({ sessionId, goalId, action: 'stop', clientTimeMs: justBeforeMidnightMs }),
        deps,
      );

      const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
      expect(session?.stopAt).toBe(serverNowMs);
    });
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

  describe('confirm(5-2a)', () => {
    it('confirm も未認証では HttpsError(unauthenticated)', async () => {
      const deps = buildDeps(Date.now());

      const error = await handleRecordStudyEventRequest(
        { auth: undefined, data: buildInput({ sessionId: uniqueId('session'), goalId: uniqueId('goal'), action: 'confirm' }) },
        deps,
      ).catch((e) => e);

      expect(error).toMatchObject({ code: 'unauthenticated' });
    });

    it('confirm も request.auth.uid のもとに保存される(data に含めた別 uid には書けない)', async () => {
      const authUid = uniqueId('uid-confirm-auth');
      const otherUid = uniqueId('uid-confirm-other-in-data');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(authUid, goalId);
      const deps = buildDeps(Date.now());
      const authData = { uid: authUid, token: {} as never, rawToken: '' };

      const result = await handleRecordStudyEventRequest(
        { auth: authData, data: { ...buildInput({ sessionId, goalId, action: 'confirm' }), uid: otherUid } },
        deps,
      );
      expect(result).toEqual({ status: 'recorded' });

      const ownSession = await getFirestoreDoc(`users/${authUid}/sessions/${sessionId}`);
      expect(ownSession?.confirmations).toHaveLength(1);
      const otherSession = await getFirestoreDoc(`users/${otherUid}/sessions/${sessionId}`);
      expect(otherSession).toBeNull();
    });

    it('confirmations が上限件数に達していると HttpsError(resource-exhausted)', async () => {
      const authUid = uniqueId('uid-confirm-limit-http');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(authUid, goalId);
      const existing = Array.from({ length: MAX_CONFIRMATIONS_PER_SESSION }, (_, i) => Date.now() - i);
      await createSessionWithConfirmations(authUid, sessionId, existing);
      const deps = buildDeps(Date.now());
      const authData = { uid: authUid, token: {} as never, rawToken: '' };

      const error = await handleRecordStudyEventRequest(
        { auth: authData, data: buildInput({ sessionId, goalId, action: 'confirm' }) },
        deps,
      ).catch((e) => e);

      expect(error).toMatchObject({ code: 'resource-exhausted' });
    });
  });

  describe('不正な入力(HttpsError(invalid-argument))', () => {
    const authUid = uniqueId('uid-invalid');
    const authData = { uid: authUid, token: {} as never, rawToken: '' };
    const deps = buildDeps(Date.now());
    const base = () => buildInput({ sessionId: uniqueId('session'), goalId: uniqueId('goal') });

    it.each<[string, Record<string, unknown>]>([
      ['data が object でない', ['not', 'an', 'object'] as unknown as Record<string, unknown>],
      ['action が不正な値', { ...base(), action: 'pause' }],
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
      ['action が start で checkEnabled が欠落', (() => { const { checkEnabled, ...rest } = base(); return rest; })()],
      ['action が start で checkEnabled が bool でない', { ...base(), checkEnabled: 'true' }],
    ])('%s', async (_label, data) => {
      const error = await handleRecordStudyEventRequest({ auth: authData, data }, deps).catch((e) => e);
      expect(error).toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('呼び出し回数の制限(5-3b-2。requirements 3-2「大量の呼び出しへの対策」)', () => {
    async function seedRateLimitCount(uid: string, nowMs: number, count: number): Promise<void> {
      ensureAdminApp();
      await getFirestore().doc(rateLimitDocPath(uid, 'study-event', nowMs)).set({ count });
    }

    it('上限の1回手前まで数えてあっても、もう1回は通る(境界)', async () => {
      const authUid = uniqueId('uid-rate-ok');
      const goalId = uniqueId('goal');
      await createGoal(authUid, goalId);
      const nowMs = Date.now();
      const deps = buildDeps(nowMs);
      await seedRateLimitCount(authUid, nowMs, RATE_LIMITS['study-event'] - 1);
      const authData = { uid: authUid, token: {} as never, rawToken: '' };

      const result = await handleRecordStudyEventRequest(
        { auth: authData, data: buildInput({ sessionId: uniqueId('session'), goalId }) },
        deps,
      );
      expect(result).toEqual({ status: 'recorded' });
    });

    it('上限に達していると HttpsError(resource-exhausted, reason: rate-limited)。sessions には保存されない', async () => {
      const authUid = uniqueId('uid-rate-exceeded');
      const goalId = uniqueId('goal');
      const sessionId = uniqueId('session');
      await createGoal(authUid, goalId);
      const nowMs = Date.now();
      const deps = buildDeps(nowMs);
      await seedRateLimitCount(authUid, nowMs, RATE_LIMITS['study-event']);
      const authData = { uid: authUid, token: {} as never, rawToken: '' };

      const error = await handleRecordStudyEventRequest(
        { auth: authData, data: buildInput({ sessionId, goalId }) },
        deps,
      ).catch((e) => e);

      expect(error).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
      const session = await getFirestoreDoc(`users/${authUid}/sessions/${sessionId}`);
      expect(session).toBeNull();
    });

    it('次の1分になると、上限に達していても再び通る', async () => {
      const authUid = uniqueId('uid-rate-next-minute');
      const goalId = uniqueId('goal');
      await createGoal(authUid, goalId);
      const nowMs = Date.now();
      await seedRateLimitCount(authUid, nowMs, RATE_LIMITS['study-event']);
      const authData = { uid: authUid, token: {} as never, rawToken: '' };

      const stillLimited = await handleRecordStudyEventRequest(
        { auth: authData, data: buildInput({ sessionId: uniqueId('session'), goalId }) },
        buildDeps(nowMs),
      ).catch((e) => e);
      expect(stillLimited).toMatchObject({ code: 'resource-exhausted' });

      const result = await handleRecordStudyEventRequest(
        { auth: authData, data: buildInput({ sessionId: uniqueId('session'), goalId }) },
        buildDeps(nowMs + 60_000),
      );
      expect(result).toEqual({ status: 'recorded' });
    });
  });
});
