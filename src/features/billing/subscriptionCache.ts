import { normalizeSubscription, type SubscriptionWire } from './subscriptionAccess';

export const SUBSCRIPTION_CACHE_PREFIX = 'billing:subscription:v1:';

export type SubscriptionSnapshot = Readonly<{
  version: 1;
  uid: string;
  registered: boolean;
  xLinked: boolean;
  subscription: SubscriptionWire | null;
}>;

export function subscriptionCacheKey(uid: string): string {
  if (typeof uid !== 'string' || uid.trim().length === 0) {
    throw new Error('subscription-invalid-uid');
  }
  return SUBSCRIPTION_CACHE_PREFIX + encodeURIComponent(uid);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}

/** Pure validation shared with account cleanup; only the exact canonical UID key is accepted. */
export function parseSubscriptionCache(key: string, raw: string): SubscriptionSnapshot | null {
  try {
    const value = object(JSON.parse(raw));
    if (!value || !exactKeys(value, [
      'version', 'uid', 'registered', 'xLinked', 'subscription',
    ]) || value.version !== 1 || typeof value.uid !== 'string' ||
      key !== subscriptionCacheKey(value.uid) ||
      typeof value.registered !== 'boolean' || typeof value.xLinked !== 'boolean') return null;

    let subscription: SubscriptionWire | null = null;
    if (value.subscription !== null) {
      const wire = object(value.subscription);
      if (!wire || !exactKeys(wire, ['status', 'expiresAt'])) return null;
      subscription = normalizeSubscription(wire);
      if (subscription === null) return null;
    }
    return {
      version: 1,
      uid: value.uid,
      registered: value.registered,
      xLinked: value.xLinked,
      subscription,
    };
  } catch {
    return null;
  }
}
