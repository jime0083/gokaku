import {
  normalizeSubscription,
  resolveSubscriptionAccess,
  type SubscriptionCache,
  type SubscriptionRead,
} from '../subscriptionAccess';

const NOW = 1_800_000_000_000;
const UID = 'billing-user-a';
const active = { status: 'active' as const, expiresAt: NOW + 1000 };
const cache: SubscriptionCache = { uid: UID, subscription: active };
const unavailable: SubscriptionRead = { kind: 'unavailable' };

function online(subscription: unknown, uid = UID): SubscriptionRead {
  return { kind: 'success', uid, subscription };
}

function resolve(
  read: SubscriptionRead,
  cached: SubscriptionCache | null = cache,
  now = NOW,
  uid = UID,
) {
  return resolveSubscriptionAccess({ uid, read, cache: cached, now });
}

describe('subscriptionAccess(requirements 3-4 / 4-3 内部単位)', () => {
  it('wireを正規化し、商品・取引・X・目標の情報を持ち込まない', () => {
    const result = normalizeSubscription({
      ...active,
      productId: 'server-product',
      originalTransactionId: 'server-transaction',
      environment: 'SANDBOX',
      xPostEnabled: true,
      activeGoalId: 'goal',
    });
    expect(result).toEqual(active);
    expect(result).not.toBe(active);
    expect(normalizeSubscription({ status: 'expired', expiresAt: NOW }))
      .toEqual({ status: 'expired', expiresAt: NOW });
  });

  it('active以外の未定義状態やrevokedは期限が未来でも正規化しない', () => {
    for (const status of ['revoked', 'pending', 'ACTIVE', '', null, true, 1]) {
      expect(normalizeSubscription({ status, expiresAt: active.expiresAt })).toBeNull();
    }
  });

  it('期限の型・有限性・安全な整数を検証しTimestampを直接受け取らない', () => {
    const toMillis = jest.fn(() => active.expiresAt);
    for (const expiresAt of [
      undefined, null, '1800000001000', NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1, NOW + 0.5, { toMillis },
    ]) {
      expect(normalizeSubscription({ status: 'active', expiresAt })).toBeNull();
    }
    expect(toMillis).not.toHaveBeenCalled();
  });

  it('欠損・プリミティブ・配列・必須項目欠損を拒否する', () => {
    for (const value of [
      undefined, null, true, 42, 'active', [], [active], {},
      { status: 'active' }, { expiresAt: active.expiresAt },
    ]) {
      expect(normalizeSubscription(value)).toBeNull();
    }
  });

  it('オンライン成功は古いキャッシュより優先し正規化したキャッシュを返す', () => {
    const old: SubscriptionCache = {
      uid: UID, subscription: { status: 'expired', expiresAt: NOW - 1 },
    };
    expect(resolve(online({ ...active, xLinked: true }), old)).toEqual({
      access: 'allowed', cache,
    });
  });

  it('オンライン欠損は有効キャッシュを置き換え、後のオフラインでもロックする', () => {
    for (const missing of [null, undefined]) {
      const result = resolve(online(missing));
      expect(result).toEqual({
        access: 'locked', cache: { uid: UID, subscription: null },
      });
      expect(resolve(unavailable, result.cache).access).toBe('locked');
    }
  });

  it('オンラインexpiredは未来の期限でも有効キャッシュより優先してロックする', () => {
    const subscription = { ...active, status: 'expired' as const };
    expect(resolve(online(subscription))).toEqual({
      access: 'locked', cache: { uid: UID, subscription },
    });
    expect(resolve(online({ ...active, status: 'revoked' })).access).toBe('locked');
  });

  it('オンライン不正データを通信不能として扱ってキャッシュへ戻さない', () => {
    expect(resolve(online({ status: 'active', expiresAt: Infinity }))).toEqual({
      access: 'locked', cache: { uid: UID, subscription: null },
    });
  });

  it('通信不能時は同じUIDの期限内キャッシュで利用を許可する', () => {
    expect(resolve(unavailable)).toEqual({ access: 'allowed', cache });
  });

  it('オンライン・オフラインとも期限直前だけ許可し同時刻と期限後はロックする', () => {
    for (const read of [unavailable, online(active)]) {
      expect(resolve(read, cache, active.expiresAt - 1).access).toBe('allowed');
      expect(resolve(read, cache, active.expiresAt).access).toBe('locked');
      expect(resolve(read, cache, active.expiresAt + 1).access).toBe('locked');
    }
    expect(resolve(unavailable, {
      uid: UID, subscription: { ...active, status: 'expired' },
    }).access).toBe('locked');
  });

  it('通信不能でキャッシュ未取得または前回欠損ならロックする', () => {
    expect(resolve(unavailable, null)).toEqual({ access: 'locked', cache: null });
    expect(resolve(unavailable, { uid: UID, subscription: null })).toEqual({
      access: 'locked', cache: { uid: UID, subscription: null },
    });
  });

  it('別UIDのキャッシュは利用せず空UIDにも利用を許可しない', () => {
    expect(resolve(unavailable, { ...cache, uid: 'billing-user-b' })).toEqual({
      access: 'locked', cache: null,
    });
    expect(resolve(unavailable, cache, NOW, '')).toEqual({
      access: 'locked', cache: null,
    });
  });

  it('別UIDに対するオンライン応答で現在の利用可否やキャッシュを更新しない', () => {
    expect(resolve(online(active, 'billing-user-b'))).toEqual({
      access: 'locked', cache: null,
    });
  });

  it('現在時刻が有限でなければオンライン・オフラインとも許可しない', () => {
    for (const now of [NaN, Infinity, -Infinity]) {
      for (const read of [unavailable, online(active)]) {
        expect(resolve(read, cache, now)).toEqual({ access: 'locked', cache });
      }
    }
  });

  it('入力を変更せず判定を保持し、明示的な再確認時だけ期限を再評価する', () => {
    const subscription = Object.freeze({ ...active });
    const previous = Object.freeze({ uid: UID, subscription });
    const result = resolve(unavailable, previous, active.expiresAt - 1);
    expect(result).toEqual({ access: 'allowed', cache: previous });
    const rechecked = resolve(unavailable, result.cache, active.expiresAt);
    expect(rechecked.access).toBe('locked');
    expect(result.access).toBe('allowed');
    expect(previous).toEqual(cache);
    expect(result.cache).not.toBe(previous);
    expect(result.cache?.subscription).not.toBe(subscription);
  });
});
