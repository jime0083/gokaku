import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';

import { ensureAdminApp } from '../firebaseAdmin';
import {
  enforceRateLimit,
  RATE_LIMITS,
  rateLimitDocPath,
  RateLimitExceededError,
  type RateLimitDeps,
} from '../rateLimit';

/**
 * 5-3b-2: ユーザーごとの1分あたりの呼び出し回数の制限(requirements 3-2「大量の呼び出しへの対策」)の
 * コア処理(enforceRateLimit)のテスト(Emulator 上)。時刻を差し替えられる(RateLimitDeps.now)ので、
 * 「次の1分になると戻る」を実際に待たずに確認できる
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

function buildDeps(now: number): RateLimitDeps {
  return { now: () => now };
}

describe('enforceRateLimit', () => {
  it('上限の手前までは何度呼んでも通る', async () => {
    const uid = await uniqueUid('under-limit');
    const nowMs = Date.now();
    const deps = buildDeps(nowMs);
    const limit = RATE_LIMITS['purchase-verify']; // 10回/分(数が少なく境界をテストしやすい)

    for (let i = 0; i < limit; i += 1) {
      await expect(enforceRateLimit(uid, 'purchase-verify', deps)).resolves.toBeUndefined();
    }
  });

  it('上限を超えると RateLimitExceededError になり、カウンタは増えない', async () => {
    const uid = await uniqueUid('over-limit');
    const nowMs = Date.now();
    const deps = buildDeps(nowMs);
    const limit = RATE_LIMITS['purchase-verify'];

    for (let i = 0; i < limit; i += 1) {
      await enforceRateLimit(uid, 'purchase-verify', deps);
    }

    const error = await enforceRateLimit(uid, 'purchase-verify', deps).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect((error as RateLimitExceededError).kind).toBe('purchase-verify');

    ensureAdminApp();
    const snap = await getFirestore().doc(rateLimitDocPath(uid, 'purchase-verify', nowMs)).get();
    expect(snap.get('count')).toBe(limit);
  });

  it('次の1分になると、上限に達していても再び通る', async () => {
    const uid = await uniqueUid('next-minute');
    const nowMs = Date.now();
    const limit = RATE_LIMITS['purchase-verify'];
    const depsThisMinute = buildDeps(nowMs);

    for (let i = 0; i < limit; i += 1) {
      await enforceRateLimit(uid, 'purchase-verify', depsThisMinute);
    }
    await expect(enforceRateLimit(uid, 'purchase-verify', depsThisMinute)).rejects.toBeInstanceOf(RateLimitExceededError);

    // 次の分(60,000ms 後)に進める
    const depsNextMinute = buildDeps(nowMs + 60_000);
    await expect(enforceRateLimit(uid, 'purchase-verify', depsNextMinute)).resolves.toBeUndefined();
  });

  it('kind が異なれば、同じ uid・同じ分でも別の枠として数える', async () => {
    const uid = await uniqueUid('separate-kind');
    const nowMs = Date.now();
    const deps = buildDeps(nowMs);
    const purchaseLimit = RATE_LIMITS['purchase-verify'];

    for (let i = 0; i < purchaseLimit; i += 1) {
      await enforceRateLimit(uid, 'purchase-verify', deps);
    }
    await expect(enforceRateLimit(uid, 'purchase-verify', deps)).rejects.toBeInstanceOf(RateLimitExceededError);

    // purchase-verify の枠が尽きていても、study-event の枠は別に数えられる
    await expect(enforceRateLimit(uid, 'study-event', deps)).resolves.toBeUndefined();
  });

  it('uid が異なれば、同じ kind・同じ分でも別の枠として数える', async () => {
    const uidA = await uniqueUid('user-a');
    const uidB = await uniqueUid('user-b');
    const nowMs = Date.now();
    const deps = buildDeps(nowMs);
    const limit = RATE_LIMITS['purchase-verify'];

    for (let i = 0; i < limit; i += 1) {
      await enforceRateLimit(uidA, 'purchase-verify', deps);
    }
    await expect(enforceRateLimit(uidA, 'purchase-verify', deps)).rejects.toBeInstanceOf(RateLimitExceededError);

    await expect(enforceRateLimit(uidB, 'purchase-verify', deps)).resolves.toBeUndefined();
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  const db = getFirestore();
  try {
    await Promise.all([...testUids].map(async (uid) => {
      const counters = await db.collection('rateLimits')
        .where(FieldPath.documentId(), '>=', `${uid}_`)
        .where(FieldPath.documentId(), '<', `${uid}_\uf8ff`)
        .get();
      await Promise.all([
        db.doc(`users/${uid}`).delete(),
        ...counters.docs.map((doc) => doc.ref.delete()),
      ]);
    }));
  } finally {
    testUids.clear();
  }
});

describe('P-055: delayed account writes', () => {
  it.each([
    ['deleting', false, 'study-event'],
    ['deleting', true, 'study-event'],
    ['missing', false, 'study-event'],
    ['missing', true, 'study-event'],
    ['deleting', false, 'purchase-verify'],
    ['deleting', true, 'purchase-verify'],
    ['missing', false, 'purchase-verify'],
    ['missing', true, 'purchase-verify'],
  ] as const)(
    '遅延カウンタ書込を拒否する: %s / 既存counter=%s / %s',
    async (state, existing, kind) => {
      const uid = await uniqueUid('guard-target');
      const otherUid = await uniqueUid('guard-other');
      const db = getFirestore();
      const userRef = db.doc(`users/${uid}`);
      const otherUserRef = db.doc(`users/${otherUid}`);
      const nowMs = Date.now();
      const targetRef = db.doc(rateLimitDocPath(uid, kind, nowMs));
      const otherRef = db.doc(rateLimitDocPath(otherUid, kind, nowMs));
      if (existing) {
        await enforceRateLimit(uid, kind, buildDeps(nowMs));
      }
      await enforceRateLimit(otherUid, kind, buildDeps(nowMs));
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

      const pending = enforceRateLimit(uid, kind, buildDeps(nowMs));
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
