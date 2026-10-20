import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import {
  DEVICE_TOKEN_TTL_MS,
  issueDeviceTokenForUid,
  type IssueDeviceTokenDeps,
} from '../deviceToken/issueDeviceToken';
import { handleIssueDeviceTokenRequest } from '../deviceToken/issueDeviceTokenCallable';
import { revokeDeviceToken } from '../deviceToken/revokeDeviceToken';
import { ensureAdminApp } from '../firebaseAdmin';
import { getFirestoreDoc } from './emulator';

/**
 * 5-3a: デバイストークンの正式な発行・作り直し・失効のテスト(Emulator 上)。
 */

import * as accountWriteGuard from '../account/accountWriteGuard';

const testUids = new Set<string>();

async function uniqueUid(label: string): Promise<string> {
  const uid = `uid-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testUids.add(uid);
  ensureAdminApp();
  // 既存schemaと新guardの正の前提を整える。検査回避ではない。
  await getFirestore().doc(`users/${uid}`).set({ createdAt: Timestamp.now() });
  return uid;
}

function buildDeps(now: number): IssueDeviceTokenDeps {
  return { now: () => now };
}

describe('issueDeviceTokenForUid', () => {
  it('ハッシュだけが保存され、生のトークンは保存されない', async () => {
    const uid = await uniqueUid('hash-only');
    const nowMs = Date.now();

    const result = await issueDeviceTokenForUid(uid, buildDeps(nowMs));

    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.tokenHash).toBe(createHash('sha256').update(result.deviceToken).digest('hex'));
    expect(doc?.tokenHash).not.toBe(result.deviceToken);
    expect(JSON.stringify(doc)).not.toContain(result.deviceToken);
  });

  it('有効期限は発行から30日後で、呼び出し元に issuedAt + 30日 を返す', async () => {
    const uid = await uniqueUid('expiry');
    const nowMs = Date.now();

    const result = await issueDeviceTokenForUid(uid, buildDeps(nowMs));

    expect(result.expiresAt).toBe(nowMs + DEVICE_TOKEN_TTL_MS);
    const doc = await getFirestoreDoc(`deviceTokens/${uid}`);
    expect(doc?.issuedAt).toBe(nowMs);
    expect(doc?.expiresAt).toBe(nowMs + DEVICE_TOKEN_TTL_MS);
  });

  it('作り直し(再発行)すると、新しいトークンのハッシュに上書きされ、古いトークンは一致しなくなる', async () => {
    const uid = await uniqueUid('reissue');
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
    const uid = await uniqueUid('revoke');
    await issueDeviceTokenForUid(uid, buildDeps(Date.now()));
    expect(await getFirestoreDoc(`deviceTokens/${uid}`)).not.toBeNull();

    await revokeDeviceToken(uid);

    expect(await getFirestoreDoc(`deviceTokens/${uid}`)).toBeNull();
  });

  it('トークンが存在しない uid に対しても失敗しない', async () => {
    const uid = await uniqueUid('revoke-noop');

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
    const authUid = await uniqueUid('auth');
    const otherUid = await uniqueUid('other-in-data');
    const deps = buildDeps(Date.now());
    const authData = { uid: authUid, token: {} as never, rawToken: '' };

    await handleIssueDeviceTokenRequest({ auth: authData, data: { uid: otherUid } }, deps);

    expect(await getFirestoreDoc(`deviceTokens/${authUid}`)).not.toBeNull();
    expect(await getFirestoreDoc(`deviceTokens/${otherUid}`)).toBeNull();
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (testUids.size === 0) {
    return;
  }
  const db = getFirestore();
  try {
    await Promise.all([...testUids].map(async (uid) => {
      await Promise.all([
        db.doc(`users/${uid}`).delete(),
        db.doc(`deviceTokens/${uid}`).delete(),
      ]);
    }));
  } finally {
    testUids.clear();
  }
});

describe('P-055: delayed account writes', () => {
  it.each([
    ['deleting', false],
    ['deleting', true],
    ['missing', false],
    ['missing', true],
  ] as const)(
    '遅延発行を拒否する: %s / 既存token=%s',
    async (state, existing) => {
      const uid = await uniqueUid('guard-target');
      const otherUid = await uniqueUid('guard-other');
      const db = getFirestore();
      const userRef = db.doc(`users/${uid}`);
      const otherUserRef = db.doc(`users/${otherUid}`);
      const nowMs = Date.now();
      const targetRef = db.doc(`deviceTokens/${uid}`);
      const otherRef = db.doc(`deviceTokens/${otherUid}`);
      if (existing) {
        await issueDeviceTokenForUid(uid, buildDeps(nowMs));
      }
      await issueDeviceTokenForUid(otherUid, buildDeps(nowMs));
      const otherBefore = (await otherRef.get()).data();
      const otherUserBefore = (await otherUserRef.get()).data();

      let entered!: () => void;
      let release!: () => void;
      const atGuard = new Promise<void>((resolve) => { entered = resolve; });
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const originalGuard = accountWriteGuard.getWritableAccount;
      const guardSpy = jest.spyOn(accountWriteGuard, 'getWritableAccount')
        .mockImplementationOnce(async (tx, ref) => {
          entered();
          await paused;
          return originalGuard(tx, ref);
        });

      const pending = issueDeviceTokenForUid(uid, buildDeps(nowMs));
      try {
        // guardが呼ばれない実装では即失敗し、待ち時間で結果を決めない。
        await Promise.race([
          atGuard,
          pending.then(() => {
            throw new Error('保存transactionが共有guardを経由していません');
          }),
        ]);

        if (state === 'deleting') {
          await userRef.update({ deletionInProgress: true });
        } else {
          await userRef.delete();
          // 削除本体が関連docを消した後の遅延再作成を再現する。
          await targetRef.delete();
        }
        const targetBefore = (await targetRef.get()).data();

        release();
        await expect(pending).rejects.toBeInstanceOf(
          accountWriteGuard.AccountWriteBlockedError,
        );
        await expect(pending).rejects.toMatchObject({ reason: state });

        expect((await targetRef.get()).data()).toEqual(targetBefore);
        const userAfter = await userRef.get();
        if (state === 'deleting') {
          expect(userAfter.get('deletionInProgress')).toBe(true);
        } else {
          expect(userAfter.exists).toBe(false);
        }
        expect((await otherRef.get()).data()).toEqual(otherBefore);
        expect((await otherUserRef.get()).data()).toEqual(otherUserBefore);
      } finally {
        release();
        await pending.catch(() => undefined);
        guardSpy.mockRestore();
      }
    },
  );
});
