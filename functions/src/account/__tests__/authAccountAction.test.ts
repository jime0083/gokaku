import { randomUUID } from 'node:crypto';

import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';

import { ensureAdminApp } from '../../firebaseAdmin';
import { rateLimitDocPath } from '../../rateLimit';
import {
  createProductionAccountActionDeps,
  type AccountAction,
  type AccountActionDeps,
} from '../accountAction';
import { handleAuthAccountActionRequest } from '../authAccountAction';
import { ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS } from '../config';
import { getWritableAccount, markAccountDeletionStarted } from '../accountWriteGuard';

const NOW = Date.UTC(2026, 9, 16, 0, 0, 0);
const ownedUids: string[] = [];
const ownedPaths: string[] = [];

beforeAll(() => {
  // Admin SDK初期化より前に拒否する。未設定時にproductionへフォールバックしない。
  if (
    process.env.GCLOUD_PROJECT !== 'demo-gokaku' ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '') ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
  ) {
    throw new Error('demo-gokakuのAuth・Firestore Emulatorが必要です');
  }
  ensureAdminApp();
});

afterEach(async () => {
  // 自分が作成したUID・パスだけを片付ける。全体のclearは使わない。
  try {
    for (const path of ownedPaths) {
      await getFirestore().doc(path).delete();
    }
  } finally {
    try {
      for (const uid of ownedUids) {
        try {
          await getFirestore().recursiveDelete(getFirestore().doc(`users/${uid}`));
        } finally {
          try {
            await getAuth().deleteUser(uid);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'auth/user-not-found')) {
              throw error;
            }
          }
        }
      }
    } finally {
      ownedPaths.length = 0;
      ownedUids.length = 0;
    }
  }
});

function deps(): AccountActionDeps {
  return { ...createProductionAccountActionDeps(), now: () => NOW };
}

function request(
  uid: string,
  action: AccountAction,
  claims: Record<string, unknown> = {},
): Pick<CallableRequest<unknown>, 'auth' | 'data'> {
  return {
    auth: {
      uid,
      token: {
        auth_time: NOW / 1000,
        firebase: { sign_in_provider: 'apple.com', identities: {} },
        ...claims,
      } as CallableRequest<unknown>['auth'] extends infer T
        ? NonNullable<T> extends { token: infer U } ? U : never
        : never,
      rawToken: '',
    },
    data: { action },
  };
}

async function seed(uid = `account-${randomUUID()}`): Promise<{ uid: string; paths: string[] }> {
  ownedUids.push(uid);
  await getAuth().createUser({ uid });
  const paths = [
    `users/${uid}`,
    `users/${uid}/goals/goal`,
    `users/${uid}/goals/goal/sessions/nested`,
    `users/${uid}/sessions/session`,
    `users/${uid}/sessionEvents/event`,
    `users/${uid}/dailyResults/2026-10-16`,
    `deviceTokens/${uid}`,
    `xTokens/${uid}`,
    `devProbe/${uid}`,
    `appleSubscriptions/${uid}`,
    rateLimitDocPath(uid, 'study-event', NOW),
    rateLimitDocPath(uid, 'purchase-verify', NOW),
  ];
  ownedPaths.push(...paths);
  for (const path of paths) {
    await getFirestore().doc(path).set({ uid, marker: path });
  }
  return { uid, paths };
}

async function read(paths: string[]): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const path of paths) {
    values.push((await getFirestore().doc(path).get()).data());
  }
  return values;
}

async function expectDeleted(fixture: { uid: string; paths: string[] }): Promise<void> {
  expect(await read(fixture.paths)).toEqual(fixture.paths.map(() => undefined));
  await expect(getAuth().getUser(fixture.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
}

describe('6-4 backend', () => {
  it('1: 未認証とUID等の余分な入力を副作用なしで拒否する', async () => {
    const fixture = await seed();
    const before = await read(fixture.paths);
    await expect(handleAuthAccountActionRequest(
      { auth: undefined, data: { action: 'delete' } }, deps(),
    )).rejects.toMatchObject({ code: 'unauthenticated' });

    for (const data of [
      null, [], {}, { action: 'other' },
      { action: 'delete', uid: 'other' },
      { action: 'logout', uid: fixture.uid },
      { action: 'delete', appleCode: 'not-accepted' },
    ]) {
      await expect(handleAuthAccountActionRequest(
        { ...request(fixture.uid, 'delete'), data }, deps(),
      )).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(await read(fixture.paths)).toEqual(before);
    expect((await getAuth().getUser(fixture.uid)).uid).toBe(fixture.uid);
  });

  it('2: Apple以外・auth_time不正・未来・300秒境界を副作用なしで拒否する', async () => {
    const fixture = await seed();
    const before = await read(fixture.paths);
    await expect(handleAuthAccountActionRequest(request(fixture.uid, 'delete', {
      firebase: { sign_in_provider: 'custom', identities: {} },
    }), deps())).rejects.toMatchObject({ code: 'permission-denied' });

    for (const authTime of [
      undefined, null, 'recent', NaN, Infinity, 0, NOW / 1000 + 1,
      NOW / 1000 - ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS,
      NOW / 1000 - ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS - 1,
    ]) {
      await expect(handleAuthAccountActionRequest(
        request(fixture.uid, 'delete', { auth_time: authTime }), deps(),
      )).rejects.toMatchObject({
        code: 'failed-precondition',
        details: { reason: 'requires-recent-login' },
      });
    }
    expect(await read(fixture.paths)).toEqual(before);
  });

  it('3: logoutはdeviceTokenだけ失効し、Auth・クラウド履歴を保持する', async () => {
    const fixture = await seed();
    const preserved = fixture.paths.filter((path) => path !== `deviceTokens/${fixture.uid}`);
    const before = await read(preserved);
    const req = request(fixture.uid, 'logout', { auth_time: 1 });
    const logoutDeps = deps();
    const beginDeletion = jest.fn(logoutDeps.beginDeletion);
    logoutDeps.beginDeletion = beginDeletion;
    await expect(handleAuthAccountActionRequest(req, logoutDeps))
      .resolves.toEqual({ action: 'logout', success: true });
    expect((await getFirestore().doc(`deviceTokens/${fixture.uid}`).get()).exists).toBe(false);
    expect(await read(preserved)).toEqual(before);
    expect((await getAuth().getUser(fixture.uid)).uid).toBe(fixture.uid);
    await expect(handleAuthAccountActionRequest(req, logoutDeps)).resolves.toMatchObject({ success: true });
    expect(beginDeletion).not.toHaveBeenCalled();
  });

  it('4: recent Apple本人の全関連データを削除し、似たUIDを含む他人は保持する', async () => {
    const fixture = await seed();
    const other = await seed(`${fixture.uid}_study-event_0`);
    const before = await read(other.paths);
    await expect(handleAuthAccountActionRequest(
      request(fixture.uid, 'delete', {
        auth_time: NOW / 1000 - ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS + 1,
      }), deps(),
    )).resolves.toEqual({ action: 'delete', success: true });
    await expectDeleted(fixture);
    expect(await read(other.paths)).toEqual(before);
    expect((await getAuth().getUser(other.uid)).uid).toBe(other.uid);
    // 応答喪失後の再実行。子孫・関連データ・Authが既に無くても安全。
    await expect(handleAuthAccountActionRequest(
      request(fixture.uid, 'delete'), deps(),
    )).resolves.toMatchObject({ success: true });
  });

  it('markerは本人の既存フィールドと他UIDを保持し、再設定では書き直さない', async () => {
    const fixture = await seed();
    const other = await seed();
    const userRef = getFirestore().doc(`users/${fixture.uid}`);
    const before = (await userRef.get()).data();
    const otherBefore = await read(other.paths);

    await markAccountDeletionStarted(fixture.uid);
    const first = await userRef.get();
    expect(first.data()).toEqual({ ...before, deletionInProgress: true });
    await markAccountDeletionStarted(fixture.uid);
    const second = await userRef.get();
    expect(second.data()).toEqual(first.data());
    expect(second.updateTime).toEqual(first.updateTime);
    expect(await read(other.paths)).toEqual(otherBefore);
    expect((await getFirestore().doc(`deviceTokens/${fixture.uid}`).get()).exists).toBe(true);
    expect((await getAuth().getUser(fixture.uid)).uid).toBe(fixture.uid);
  });

  it('親missingではmarker用の親を作らず、残る子孫と関連データを再試行で削除する', async () => {
    const fixture = await seed();
    const userRef = getFirestore().doc(`users/${fixture.uid}`);
    await userRef.delete();

    await markAccountDeletionStarted(fixture.uid);
    await markAccountDeletionStarted(fixture.uid);
    expect((await userRef.get()).exists).toBe(false);
    expect((await getFirestore().doc(`users/${fixture.uid}/goals/goal`).get()).exists).toBe(true);
    expect((await getFirestore().doc(`devProbe/${fixture.uid}`).get()).exists).toBe(true);
    expect((await getAuth().getUser(fixture.uid)).uid).toBe(fixture.uid);

    await expect(handleAuthAccountActionRequest(
      request(fixture.uid, 'delete'), deps(),
    )).resolves.toMatchObject({ success: true });
    await expectDeleted(fixture);
  });

  it.each(['deleting', 'deleted'] as const)(
    '遅延したtransaction書込は%sの親をガードで拒否し、再作成しない',
    async (state) => {
      const fixture = await seed();
      const db = getFirestore();
      const userRef = db.doc(`users/${fixture.uid}`);
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });

      // 外部API等の待機を模したもの。待機後の実transactionで必ず親を読み直す。
      // 本番の各writerへの組込みは、後続handoffで個別に検証する。
      const lateWrite = (async () => {
        await gate;
        await db.runTransaction(async (tx) => {
          await getWritableAccount(tx, userRef);
          tx.set(userRef, { subscription: { status: 'active' } }, { merge: true });
          tx.set(db.doc(`deviceTokens/${fixture.uid}`), { marker: 'late-write' });
          tx.set(db.doc(`devProbe/${fixture.uid}`), { marker: 'late-write' });
        });
      })();
      // 先に拒否handlerを接続し、失敗したassertionでも未処理Promiseを残さない。
      const observed = lateWrite.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );

      try {
        if (state === 'deleting') {
          await markAccountDeletionStarted(fixture.uid);
        } else {
          await handleAuthAccountActionRequest(request(fixture.uid, 'delete'), deps());
        }
        const before = await read(fixture.paths);
        resume();
        expect((await observed).error).toMatchObject({
          name: 'AccountWriteBlockedError',
          reason: state === 'deleting' ? 'deleting' : 'missing',
        });
        expect(await read(fixture.paths)).toEqual(before);
        if (state === 'deleted') {
          await expectDeleted(fixture);
        }
      } finally {
        resume();
        await observed;
      }
    },
  );

  it.each(['beginDeletion', 'revokeDeviceToken', 'deleteRelatedData', 'deleteAuthUser'] as const)(
    '5: %sの失敗を成功にせず、Authを残して同じ操作を再試行できる',
    async (stage) => {
      const fixture = await seed();
      const other = await seed();
      const before = await read(other.paths);
      const failing = deps();
      failing[stage] = async (uid) => {
        if (stage === 'deleteRelatedData') {
          // 一部の削除だけ完了した実状態からの再試行を検証する。
          await getFirestore().doc(`xTokens/${uid}`).delete();
        }
        throw new Error('injected failure');
      };
      await expect(handleAuthAccountActionRequest(
        request(fixture.uid, 'delete'), failing,
      )).rejects.toMatchObject({ code: 'internal' });
      expect((await getAuth().getUser(fixture.uid)).uid).toBe(fixture.uid);
      expect((await getFirestore().doc(`deviceTokens/${fixture.uid}`).get()).exists)
        .toBe(stage === 'beginDeletion' || stage === 'revokeDeviceToken');
      const parent = await getFirestore().doc(`users/${fixture.uid}`).get();
      if (stage === 'deleteAuthUser') {
        // データ削除完了後のAuth失敗では、markerを含む親は既に無い。
        expect(parent.exists).toBe(false);
      } else {
        expect(parent.exists).toBe(true);
        expect(parent.get('deletionInProgress')).toBe(
          stage === 'beginDeletion' ? undefined : true,
        );
      }
      expect(await read(other.paths)).toEqual(before);
      await expect(handleAuthAccountActionRequest(
        request(fixture.uid, 'delete'), deps(),
      )).resolves.toMatchObject({ success: true });
      await expectDeleted(fixture);
      expect(await read(other.paths)).toEqual(before);
    },
  );
});
