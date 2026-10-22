export const RELINK_INTENT_PREFIX = 'x-link:relink:v1:';

export type RelinkIntent = Readonly<{
  version: 1;
  uid: string;
}>;

export function relinkIntentKey(uid: string): string {
  if (typeof uid !== 'string' || uid.trim().length === 0) {
    throw new Error('relink-intent-invalid-uid');
  }
  return RELINK_INTENT_PREFIX + encodeURIComponent(uid);
}

/** Pure ownership validation shared with account cleanup. Never adopt unknown data. */
export function parseRelinkIntent(key: string, raw: string): RelinkIntent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'uid,version' ||
      record.version !== 1 || typeof record.uid !== 'string' ||
      key !== relinkIntentKey(record.uid)) return null;
    return { version: 1, uid: record.uid };
  } catch {
    return null;
  }
}
