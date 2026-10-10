import { getFirestore } from 'firebase-admin/firestore';

import { issueDeviceTokenForUid } from '../deviceToken/issueDeviceToken';
import { revokeDeviceToken } from '../deviceToken/revokeDeviceToken';
import { hashDeviceToken } from '../deviceTokenHash';
import { ensureAdminApp } from '../firebaseAdmin';
import { RATE_LIMITS, rateLimitDocPath } from '../rateLimit';
import { handleRecordStudyEventRequest } from '../studySession/recordStudyEvent';
import { MAX_CONFIRMATIONS_PER_SESSION } from '../studySession/recordStudySessionEvent';
import { functionUrl, getFirestoreDoc, listFirestoreDocs } from './emulator';

/**
 * ロック画面・通知アクションからの同期を受ける nativeSync の Emulator テスト(5-3b-1)。
 * issueDeviceTokenForUid(5-3a。issueDeviceToken Callable が呼ぶ共通の処理)でトークンを発行し、
 * nativeSync に送って users/{uid}/sessions を確認する
 * (5-3b-1 で recordStudySessionEvent(共通処理)を使うようになり、検証用の syncEvents への書き込みはやめた)。
 */

function uniqueUid(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** テスト対象の uid 配下に有効な目標(goals/{goalId})を作る */
async function createGoal(uid: string, goalId: string): Promise<void> {
  ensureAdminApp();
  await getFirestore().doc(`users/${uid}/goals/${goalId}`).set({ type: 'cert' });
}

describe('nativeSync (Functions Emulator)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');

  async function issueToken(uid: string): Promise<string> {
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });
    return deviceToken;
  }

  function buildBody(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      action: 'stop',
      clientTimeMs: Date.now(),
      idempotencyKey: uniqueId('evt'),
      ...overrides,
    };
  }

  async function send(body: Record<string, unknown>, token: string): Promise<Response> {
    return fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('POST 以外は 405 を返す', async () => {
    const res = await fetch(nativeSyncUrl, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('Authorization ヘッダーが無いと 401', async () => {
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody({ uid: 'nouid', goalId: 'g1' })),
    });
    expect(res.status).toBe(401);
  });

  it('不正な(発行されていない)デバイストークンは 401', async () => {
    const uid = uniqueUid('bad-token');
    const res = await send(
      buildBody({ uid, sessionId: uniqueId('session'), goalId: uniqueId('goal') }),
      'invalid-token-value',
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ['uid がパス区切りを含む', { uid: 'has/slash' }],
    ['sessionId が長すぎる', { sessionId: 'a'.repeat(129) }],
    ['goalId が空文字', { goalId: '' }],
    ['idempotencyKey が不正な文字を含む', { idempotencyKey: 'bad key!' }],
    ['action が決まった値でない', { action: 'pause' }],
    ['clientTimeMs が数値でない', { clientTimeMs: 'not-a-number' }],
    ['start なのに checkEnabled が無い', { action: 'start', checkEnabled: undefined }],
    ['start なのに checkEnabled が真偽値でない', { action: 'start', checkEnabled: 'yes' }],
  ])('不正な形の本文(%s)は 400', async (_label, overrides) => {
    const uid = uniqueUid('invalid-body');
    const token = await issueToken(uid);
    const body = buildBody({
      uid,
      sessionId: uniqueId('session'),
      goalId: uniqueId('goal'),
      ...overrides,
    });
    // undefined のキーは JSON.stringify で落ちるので「無い」を再現できる
    const res = await send(body, token);
    expect(res.status).toBe(400);
  });

  it('不正な形の本文(clientTimeMs が有限でない)は 400', async () => {
    const uid = uniqueUid('invalid-body-infinite');
    const token = await issueToken(uid);
    // JSON.stringify は Infinity を null にしてしまい typeof チェックで弾かれるだけになるため、
    // Number.isFinite のチェックを実際に通す値(JSON の範囲を超える巨大指数。パース後は Infinity になる)を
    // 生の JSON 文字列として送る
    const rawBody = JSON.stringify(
      buildBody({ uid, sessionId: uniqueId('session'), goalId: uniqueId('goal'), action: 'stop' }),
    ).replace(/"clientTimeMs":\d+/, '"clientTimeMs":1e400');
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: rawBody,
    });
    expect(res.status).toBe(400);
  });

  it('架空の goalId(本人の目標として存在しない)は 400', async () => {
    const uid = uniqueUid('no-goal');
    const token = await issueToken(uid);
    const res = await send(
      buildBody({ uid, sessionId: uniqueId('session'), goalId: uniqueId('missing-goal'), action: 'stop' }),
      token,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('goal_not_found');
  });

  it('start・停止・確認が sessions に保存される(source は lockscreen)', async () => {
    const uid = uniqueUid('full-session');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);

    const startAtMs = Date.now() - 120_000;
    const startRes = await send(
      buildBody({ uid, sessionId, goalId, action: 'start', clientTimeMs: startAtMs, checkEnabled: true }),
      token,
    );
    expect(startRes.status).toBe(200);

    const confirmAtMs = Date.now() - 60_000;
    const confirmRes = await send(
      buildBody({ uid, sessionId, goalId, action: 'confirm', clientTimeMs: confirmAtMs }),
      token,
    );
    expect(confirmRes.status).toBe(200);

    const stopAtMs = Date.now();
    const stopRes = await send(
      buildBody({ uid, sessionId, goalId, action: 'stop', clientTimeMs: stopAtMs }),
      token,
    );
    expect(stopRes.status).toBe(200);

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.goalId).toBe(goalId);
    expect(session?.source).toBe('lockscreen');
    expect(session?.checkEnabled).toBe(true);
    expect(session?.startAt).toBe(startAtMs);
    expect(session?.stopAt).toBe(stopAtMs);
    expect(session?.confirmations).toEqual([confirmAtMs]);
  });

  it('端末時刻がサーバー受信時刻より未来だと、受信時刻に補正される(時刻の補正あり)', async () => {
    const uid = uniqueUid('future-time');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);

    const futureClientTimeMs = Date.now() + 10 * 60 * 1000;
    const beforeRequestMs = Date.now();
    const res = await send(
      buildBody({ uid, sessionId, goalId, action: 'stop', clientTimeMs: futureClientTimeMs }),
      token,
    );
    expect(res.status).toBe(200);

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.stopAt).toBeGreaterThanOrEqual(beforeRequestMs);
    expect(session?.stopAt).toBeLessThan(futureClientTimeMs);
  });

  it('過去の端末時刻は補正されずそのまま使われる(時刻の補正なし)', async () => {
    const uid = uniqueUid('past-time');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);

    const pastClientTimeMs = Date.now() - 5 * 60 * 1000;
    const res = await send(
      buildBody({ uid, sessionId, goalId, action: 'stop', clientTimeMs: pastClientTimeMs }),
      token,
    );
    expect(res.status).toBe(200);

    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.stopAt).toBe(pastClientTimeMs);
  });

  it('同じ idempotencyKey を再送しても二重に記録されない(sessionEvents は1件のまま)', async () => {
    const uid = uniqueUid('replay');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);
    const idempotencyKey = uniqueId('evt');
    const body = buildBody({ uid, sessionId, goalId, action: 'confirm', idempotencyKey });

    for (let i = 0; i < 2; i += 1) {
      const res = await send(body, token);
      expect(res.status).toBe(200);
    }

    const events = await listFirestoreDocs(`users/${uid}/sessionEvents`);
    expect(events.length).toBe(1);
    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session?.confirmations).toEqual([body.clientTimeMs]);
  });

  it('トークンの uid と body の uid が一致しないと 401(他人の sessions には書けない)', async () => {
    const ownerUid = uniqueUid('owner');
    const otherUid = uniqueUid('other');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(otherUid, goalId);
    const ownerToken = await issueToken(ownerUid);

    const res = await send(
      buildBody({ uid: otherUid, sessionId, goalId, action: 'stop', idempotencyKey: 'evt-cross-uid' }),
      ownerToken,
    );
    expect(res.status).toBe(401);

    const session = await getFirestoreDoc(`users/${otherUid}/sessions/${sessionId}`);
    expect(session).toBeNull();
  });

  // 5-3b-1 からの申し送り: confirmations の上限を超えたときに 429 になることを HTTP 経由で確かめる
  it('confirmations の上限件数に達していると 429(confirmation_limit_exceeded)', async () => {
    const uid = uniqueUid('confirm-limit');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);
    ensureAdminApp();
    const existing = Array.from({ length: MAX_CONFIRMATIONS_PER_SESSION }, (_, i) => Date.now() - i);
    await getFirestore().doc(`users/${uid}/sessions/${sessionId}`).set({ confirmations: existing });

    const res = await send(buildBody({ uid, sessionId, goalId, action: 'confirm' }), token);

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('confirmation_limit_exceeded');
  });
});

// 5-3b-2: ユーザーごとの1分あたりの呼び出し回数の制限(requirements 3-2「大量の呼び出しへの対策」)
describe('nativeSync の呼び出し回数の制限(5-3b-2)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');

  async function issueToken(uid: string): Promise<string> {
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });
    return deviceToken;
  }

  function buildBody(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      action: 'stop',
      clientTimeMs: Date.now(),
      idempotencyKey: uniqueId('evt'),
      ...overrides,
    };
  }

  async function send(body: Record<string, unknown>, token: string): Promise<Response> {
    return fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('上限に達していると 429(rate_limited)', async () => {
    const uid = uniqueUid('rate-limited');
    const goalId = uniqueId('goal');
    const sessionId = uniqueId('session');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);
    const nowMs = Date.now();
    ensureAdminApp();
    await getFirestore().doc(rateLimitDocPath(uid, 'study-event', nowMs)).set({ count: RATE_LIMITS['study-event'] });

    const res = await send(buildBody({ uid, sessionId, goalId, action: 'stop' }), token);

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
    const session = await getFirestoreDoc(`users/${uid}/sessions/${sessionId}`);
    expect(session).toBeNull();
  });

  it('不正なデバイストークンでの呼び出しはカウンタを増やさない', async () => {
    const uid = uniqueUid('invalid-token-no-count');
    const nowMs = Date.now();

    const res = await send(buildBody({ uid, sessionId: uniqueId('session'), goalId: uniqueId('goal') }), 'invalid-token-value');
    expect(res.status).toBe(401);

    const snap = await getFirestoreDoc(rateLimitDocPath(uid, 'study-event', nowMs));
    expect(snap).toBeNull();
  });

  it('recordStudyEvent(Callable)と nativeSync は同じ枠を共有する', async () => {
    const uid = uniqueUid('shared-bucket');
    const goalId = uniqueId('goal');
    await createGoal(uid, goalId);
    const token = await issueToken(uid);
    const callableDeps = { now: () => Date.now() };
    const authData = { uid, token: {} as never, rawToken: '' };

    // Callable(recordStudyEvent)側だけで上限いっぱいまで呼ぶ
    for (let i = 0; i < RATE_LIMITS['study-event']; i += 1) {
      const result = await handleRecordStudyEventRequest(
        {
          auth: authData,
          data: {
            sessionId: uniqueId('session'),
            goalId,
            action: 'start',
            source: 'app',
            clientTimeMs: Date.now(),
            idempotencyKey: uniqueId('evt'),
            checkEnabled: true,
          },
        },
        callableDeps,
      );
      expect(result).toEqual({ status: 'recorded' });
    }

    // nativeSync(ロック画面)側は同じ uid で初めての呼び出しでも、既に上限に達しているので 429
    const res = await send(buildBody({ uid, sessionId: uniqueId('session'), goalId, action: 'stop' }), token);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });
});

// 5-3a: issueDeviceToken(正式な発行)が設定した expiresAt を nativeSync が確かめること、
// 作り直し(再発行)で古いトークンが無効になること、失効(revokeDeviceToken)後は拒否されることの確認
describe('nativeSync のデバイストークンの期限・失効(5-3a)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');

  async function buildBodyWithGoal(uid: string, idempotencyKey: string): Promise<Record<string, unknown>> {
    const goalId = uniqueId('goal');
    await createGoal(uid, goalId);
    return {
      uid,
      sessionId: uniqueId('session'),
      goalId,
      action: 'stop',
      clientTimeMs: Date.now(),
      idempotencyKey,
    };
  }

  async function sendWithToken(body: Record<string, unknown>, token: string): Promise<Response> {
    return fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('期限切れのデバイストークンは 401', async () => {
    const uid = uniqueUid('expired');
    // 31日前に発行した体にする(有効期限30日 → 現在は期限切れ)
    const issuedAtMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => issuedAtMs });

    const res = await sendWithToken(await buildBodyWithGoal(uid, 'evt-expired'), deviceToken);

    expect(res.status).toBe(401);
  });

  it('期限内のデバイストークンは成功する', async () => {
    const uid = uniqueUid('not-expired');
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    const res = await sendWithToken(await buildBodyWithGoal(uid, 'evt-not-expired'), deviceToken);

    expect(res.status).toBe(200);
  });

  it('作り直し(再発行)すると、古いトークンは 401 になり、新しいトークンは成功する', async () => {
    const uid = uniqueUid('reissue');
    const oldToken = await issueDeviceTokenForUid(uid, { now: () => Date.now() });
    const newToken = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    const oldRes = await sendWithToken(await buildBodyWithGoal(uid, 'evt-old'), oldToken.deviceToken);
    expect(oldRes.status).toBe(401);

    const newRes = await sendWithToken(await buildBodyWithGoal(uid, 'evt-new'), newToken.deviceToken);
    expect(newRes.status).toBe(200);
  });

  it('失効(revokeDeviceToken)したあとは 401', async () => {
    const uid = uniqueUid('revoked');
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    await revokeDeviceToken(uid);

    const res = await sendWithToken(await buildBodyWithGoal(uid, 'evt-revoked'), deviceToken);
    expect(res.status).toBe(401);
  });

  // expiresAt が無い・数値でないトークンはフェイルクローズで拒否する(5-3a-2)。
  // issueDeviceToken は常に expiresAt(number)を設定するため、ここでは「壊れたデータ」を直接
  // Firestore(Admin SDK)に書き込んで再現する
  it('expiresAt が無いデバイストークンは 401(フェイルクローズ)', async () => {
    const uid = uniqueUid('no-expires-at');
    const rawToken = `raw-${uid}`;
    ensureAdminApp();
    await getFirestore().doc(`deviceTokens/${uid}`).set({
      tokenHash: hashDeviceToken(rawToken),
      issuedAt: Date.now(),
    });

    const res = await sendWithToken(await buildBodyWithGoal(uid, 'evt-no-expires-at'), rawToken);

    expect(res.status).toBe(401);
  });

  it('expiresAt が数値でないデバイストークンは 401(フェイルクローズ)', async () => {
    const uid = uniqueUid('non-numeric-expires-at');
    const rawToken = `raw-${uid}`;
    ensureAdminApp();
    await getFirestore().doc(`deviceTokens/${uid}`).set({
      tokenHash: hashDeviceToken(rawToken),
      issuedAt: Date.now(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    const res = await sendWithToken(await buildBodyWithGoal(uid, 'evt-non-numeric-expires-at'), rawToken);

    expect(res.status).toBe(401);
  });
});
