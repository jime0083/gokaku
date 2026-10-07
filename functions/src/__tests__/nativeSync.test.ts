import { createHash } from 'node:crypto';

import { functionUrl, getFirestoreDoc, listFirestoreDocs } from './emulator';

/**
 * Phase 1-4 技術検証: ロック画面・通知アクションからの同期を受ける nativeSync の Emulator テスト。
 * devIssueDeviceToken(Emulator専用)でトークンを発行し、nativeSync に送って Firestore を確認する
 */
describe('nativeSync (Functions Emulator)', () => {
  const nativeSyncUrl = functionUrl('nativeSync');
  const issueUrl = functionUrl('devIssueDeviceToken');

  async function issueToken(uid: string): Promise<string> {
    const res = await fetch(issueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceToken: string };
    return body.deviceToken;
  }

  function uniqueUid(label: string): string {
    return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

describe('devIssueDeviceToken (Functions Emulator)', () => {
  const issueUrl = functionUrl('devIssueDeviceToken');

  it('GET は 405', async () => {
    const res = await fetch(issueUrl, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('uid が無いと 400', async () => {
    const res = await fetch(issueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('発行したトークンは生の値ではなく sha256 ハッシュで保存される', async () => {
    const uid = `test-hash-${Date.now()}`;
    const res = await fetch(issueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    const body = (await res.json()) as { deviceToken: string };

    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.tokenHash).toBe(createHash('sha256').update(body.deviceToken).digest('hex'));
    expect(doc?.tokenHash).not.toBe(body.deviceToken);
  });
});
