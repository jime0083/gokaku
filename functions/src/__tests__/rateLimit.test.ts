import { getFirestore } from 'firebase-admin/firestore';

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

function uniqueUid(label: string): string {
  return `uid-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildDeps(now: number): RateLimitDeps {
  return { now: () => now };
}

describe('enforceRateLimit', () => {
  it('上限の手前までは何度呼んでも通る', async () => {
    const uid = uniqueUid('under-limit');
    const nowMs = Date.now();
    const deps = buildDeps(nowMs);
    const limit = RATE_LIMITS['purchase-verify']; // 10回/分(数が少なく境界をテストしやすい)

    for (let i = 0; i < limit; i += 1) {
      await expect(enforceRateLimit(uid, 'purchase-verify', deps)).resolves.toBeUndefined();
    }
  });

  it('上限を超えると RateLimitExceededError になり、カウンタは増えない', async () => {
    const uid = uniqueUid('over-limit');
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
    const uid = uniqueUid('next-minute');
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
    const uid = uniqueUid('separate-kind');
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
    const uidA = uniqueUid('user-a');
    const uidB = uniqueUid('user-b');
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
