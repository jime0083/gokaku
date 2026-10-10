import { getFirestore } from 'firebase-admin/firestore';

import { issueDeviceTokenForUid } from '../deviceToken/issueDeviceToken';
import { revokeDeviceToken } from '../deviceToken/revokeDeviceToken';
import { hashDeviceToken } from '../deviceTokenHash';
import { ensureAdminApp } from '../firebaseAdmin';
import { functionUrl, getFirestoreDoc, listFirestoreDocs } from './emulator';

function uniqueUid(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * ロック画面・通知アクションからの同期を受ける nativeSync の Emulator テスト。
 * issueDeviceTokenForUid(5-3a。issueDeviceToken Callable が呼ぶ共通の処理)でトークンを発行し、
 * nativeSync に送って Firestore を確認する(5-3a-2: devIssueDeviceToken は削除済みのため使わない)
 */
describe('nativeSync (Functions Emulator)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');

  async function issueToken(uid: string): Promise<string> {
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });
    return deviceToken;
  }

  it('POST 以外は 405 を返す', async () => {
    const res = await fetch(nativeSyncUrl, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('Authorization ヘッダーが無いと 401', async () => {
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: 'nouid',
        goalId: 'g1',
        action: 'stop',
        source: 'live_activity',
        clientTimeMs: Date.now(),
        idempotencyKey: 'k1',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('不正な(発行されていない)デバイストークンは 401', async () => {
    const uid = uniqueUid('bad-token');
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token-value',
      },
      body: JSON.stringify({
        uid,
        goalId: 'g1',
        action: 'stop',
        source: 'live_activity',
        clientTimeMs: Date.now(),
        idempotencyKey: 'k1',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('必須項目が欠けていると 400', async () => {
    const uid = uniqueUid('invalid-body');
    const token = await issueToken(uid);
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ uid, action: 'stop' }),
    });
    expect(res.status).toBe(400);
  });

  it('正しいトークンで送ると、端末時刻とサーバー受信時刻の両方を記録する(ロック画面からの停止を模擬)', async () => {
    const uid = uniqueUid('stop-ok');
    const token = await issueToken(uid);
    const clientTimeMs = Date.now() - 1234;
    const idempotencyKey = `evt-${Math.random().toString(36).slice(2)}`;

    const beforeRequestMs = Date.now();
    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uid,
        goalId: 'goal-1',
        action: 'stop',
        source: 'live_activity',
        clientTimeMs,
        idempotencyKey,
      }),
    });
    expect(res.status).toBe(200);

    const doc = await getFirestoreDoc(`users/${uid}/syncEvents/${idempotencyKey}`);
    expect(doc).not.toBeNull();
    expect(doc?.goalId).toBe('goal-1');
    expect(doc?.action).toBe('stop');
    expect(doc?.source).toBe('live_activity');
    expect(doc?.clientTime).toBe(new Date(clientTimeMs).toISOString());
    expect(typeof doc?.serverReceivedAt).toBe('string');
    const serverReceivedAtMs = Date.parse(doc?.serverReceivedAt as string);
    expect(serverReceivedAtMs).toBeGreaterThanOrEqual(beforeRequestMs);
  });

  it('同じ idempotencyKey を再送しても重複レコードにならない(リプレイで上書きのみ)', async () => {
    const uid = uniqueUid('replay');
    const token = await issueToken(uid);
    const idempotencyKey = `evt-${Math.random().toString(36).slice(2)}`;
    const payload = {
      uid,
      goalId: 'goal-1',
      action: 'confirm' as const,
      source: 'notification_action' as const,
      clientTimeMs: Date.now(),
      idempotencyKey,
    };

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(nativeSyncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
    }

    const docs = await listFirestoreDocs(`users/${uid}/syncEvents`);
    expect(docs.length).toBe(1);
  });

  it('トークンの uid と body の uid が一致しないと 401', async () => {
    const ownerUid = uniqueUid('owner');
    const otherUid = uniqueUid('other');
    const ownerToken = await issueToken(ownerUid);

    const res = await fetch(nativeSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        uid: otherUid,
        goalId: 'goal-1',
        action: 'stop',
        source: 'live_activity',
        clientTimeMs: Date.now(),
        idempotencyKey: 'evt-cross-uid',
      }),
    });
    expect(res.status).toBe(401);
  });
});

// 5-3a: issueDeviceToken(正式な発行)が設定した expiresAt を nativeSync が確かめること、
// 作り直し(再発行)で古いトークンが無効になること、失効(revokeDeviceToken)後は拒否されることの確認
describe('nativeSync のデバイストークンの期限・失効(5-3a)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');

  function buildBody(uid: string, idempotencyKey: string): Record<string, unknown> {
    return {
      uid,
      goalId: 'goal-1',
      action: 'stop',
      source: 'live_activity',
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

    const res = await sendWithToken(buildBody(uid, 'evt-expired'), deviceToken);

    expect(res.status).toBe(401);
  });

  it('期限内のデバイストークンは成功する', async () => {
    const uid = uniqueUid('not-expired');
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    const res = await sendWithToken(buildBody(uid, 'evt-not-expired'), deviceToken);

    expect(res.status).toBe(200);
  });

  it('作り直し(再発行)すると、古いトークンは 401 になり、新しいトークンは成功する', async () => {
    const uid = uniqueUid('reissue');
    const oldToken = await issueDeviceTokenForUid(uid, { now: () => Date.now() });
    const newToken = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    const oldRes = await sendWithToken(buildBody(uid, 'evt-old'), oldToken.deviceToken);
    expect(oldRes.status).toBe(401);

    const newRes = await sendWithToken(buildBody(uid, 'evt-new'), newToken.deviceToken);
    expect(newRes.status).toBe(200);
  });

  it('失効(revokeDeviceToken)したあとは 401', async () => {
    const uid = uniqueUid('revoked');
    const { deviceToken } = await issueDeviceTokenForUid(uid, { now: () => Date.now() });

    await revokeDeviceToken(uid);

    const res = await sendWithToken(buildBody(uid, 'evt-revoked'), deviceToken);
    expect(res.status).toBe(401);
  });

  // 5-3a-2: expiresAt が無い・数値でないトークンはフェイルクローズで拒否する(5-3a レビュー指摘)。
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

    const res = await sendWithToken(buildBody(uid, 'evt-no-expires-at'), rawToken);

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

    const res = await sendWithToken(buildBody(uid, 'evt-non-numeric-expires-at'), rawToken);

    expect(res.status).toBe(401);
  });
});
