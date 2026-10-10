import { createHash } from 'node:crypto';

import {
  DEVICE_TOKEN_TTL_MS,
  issueDeviceTokenForUid,
  type IssueDeviceTokenDeps,
} from '../deviceToken/issueDeviceToken';
import { handleIssueDeviceTokenRequest } from '../deviceToken/issueDeviceTokenCallable';
import { revokeDeviceToken } from '../deviceToken/revokeDeviceToken';
import { getFirestoreDoc } from './emulator';

/**
 * 5-3a: デバイストークンの正式な発行・作り直し・失効のテスト(Emulator 上)。
 */

function uniqueUid(label: string): string {
  return `uid-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildDeps(now: number): IssueDeviceTokenDeps {
  return { now: () => now };
}

describe('issueDeviceTokenForUid', () => {
  it('ハッシュだけが保存され、生のトークンは保存されない', async () => {
    const uid = uniqueUid('hash-only');
    const nowMs = Date.now();

    const result = await issueDeviceTokenForUid(uid, buildDeps(nowMs));

    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.tokenHash).toBe(createHash('sha256').update(result.deviceToken).digest('hex'));
    expect(doc?.tokenHash).not.toBe(result.deviceToken);
    expect(JSON.stringify(doc)).not.toContain(result.deviceToken);
  });

  it('有効期限は発行から30日後で、呼び出し元に issuedAt + 30日 を返す', async () => {
    const uid = uniqueUid('expiry');
    const nowMs = Date.now();

    const result = await issueDeviceTokenForUid(uid, buildDeps(nowMs));

    expect(result.expiresAt).toBe(nowMs + DEVICE_TOKEN_TTL_MS);
    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.issuedAt).toBe(nowMs);
    expect(doc?.expiresAt).toBe(nowMs + DEVICE_TOKEN_TTL_MS);
  });

  it('作り直し(再発行)すると、新しいトークンのハッシュに上書きされ、古いトークンは一致しなくなる', async () => {
    const uid = uniqueUid('reissue');
    const first = await issueDeviceTokenForUid(uid, buildDeps(Date.now()));
    const firstHash = createHash('sha256').update(first.deviceToken).digest('hex');

    const second = await issueDeviceTokenForUid(uid, buildDeps(Date.now()));

    expect(second.deviceToken).not.toBe(first.deviceToken);
    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.tokenHash).not.toBe(firstHash);
    expect(doc?.tokenHash).toBe(createHash('sha256').update(second.deviceToken).digest('hex'));
  });
});

describe('revokeDeviceToken', () => {
  it('deviceTokens/{uid} を削除する(失効)', async () => {
    const uid = uniqueUid('revoke');
    await issueDeviceTokenForUid(uid, buildDeps(Date.now()));
    expect(await getFirestoreDoc(`deviceTokens/${uid}`)).not.toBeNull();

    await revokeDeviceToken(uid);

    expect(await getFirestoreDoc(`deviceTokens/${uid}`)).toBeNull();
  });

  it('トークンが存在しない uid に対しても失敗しない', async () => {
    const uid = uniqueUid('revoke-noop');

    await expect(revokeDeviceToken(uid)).resolves.toBeUndefined();
  });
});

describe('handleIssueDeviceTokenRequest', () => {
  it('未認証(auth なし)は HttpsError(unauthenticated)', async () => {
    const deps = buildDeps(Date.now());

    const error = await handleIssueDeviceTokenRequest({ auth: undefined, data: {} }, deps).catch(
      (e) => e,
    );

    expect(error).toMatchObject({ code: 'unauthenticated' });
  });

  it('request.auth.uid のもとに発行される(data に含めた別 uid は無視される。他人の uid では発行できない)', async () => {
    const authUid = uniqueUid('auth');
    const otherUid = uniqueUid('other-in-data');
    const deps = buildDeps(Date.now());
    const authData = { uid: authUid, token: {} as never, rawToken: '' };

    await handleIssueDeviceTokenRequest({ auth: authData, data: { uid: otherUid } }, deps);

    expect(await getFirestoreDoc(`deviceTokens/${authUid}`)).not.toBeNull();
    expect(await getFirestoreDoc(`deviceTokens/${otherUid}`)).toBeNull();
  });
});
