import {
  parseSubscriptionCache, subscriptionCacheKey, SUBSCRIPTION_CACHE_PREFIX,
} from '../subscriptionCache';

const uid = 'owner/a%日本';
const key = subscriptionCacheKey(uid);
const snapshot = {
  version: 1, uid, registered: true, xLinked: false,
  subscription: { status: 'active', expiresAt: 100 },
};

it('uses canonical encoded UID keys and returns a validated independent snapshot', () => {
  expect(key).toBe(SUBSCRIPTION_CACHE_PREFIX + encodeURIComponent(uid));
  expect(subscriptionCacheKey('a/b')).not.toBe(subscriptionCacheKey('a%2Fb'));
  expect(parseSubscriptionCache(key, JSON.stringify(snapshot))).toEqual(snapshot);
  const empty = { ...snapshot, subscription: null };
  expect(parseSubscriptionCache(key, JSON.stringify(empty))).toEqual(empty);
  expect(() => subscriptionCacheKey(' ')).toThrow('subscription-invalid-uid');
  expect(parseSubscriptionCache(key.replace('%2F', '%2f'), JSON.stringify(snapshot))).toBeNull();
});

it('rejects corrupt, foreign, incorrectly typed and extra-field envelopes', () => {
  const invalid = [
    '{', 'null', '[]', '{}',
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, uid: 'another-owner' }),
    JSON.stringify({ ...snapshot, registered: 'true' }),
    JSON.stringify({ ...snapshot, xLinked: 1 }),
    JSON.stringify({ ...snapshot, token: 'must-not-be-cached' }),
    JSON.stringify({ ...snapshot, subscription: undefined }),
  ];
  for (const raw of invalid) expect(parseSubscriptionCache(key, raw)).toBeNull();
});

it('rejects malformed or noncanonical subscription wire data', () => {
  for (const subscription of [
    {}, [], 'active', { status: 'active', expiresAt: '100' },
    { status: 'active', expiresAt: 1.5 },
    { status: 'revoked', expiresAt: 100 },
    { status: 'active', expiresAt: 100, purchaseToken: 'forbidden' },
  ]) {
    expect(parseSubscriptionCache(key, JSON.stringify({ ...snapshot, subscription }))).toBeNull();
  }
});
