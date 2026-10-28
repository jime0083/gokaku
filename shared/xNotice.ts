import { isValidDateKey } from './date';

export type XNoticeKind = 'post_failed' | 'unknown_post' | 'relink_required';

export type XNotice = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly date: string;
  readonly linkRevision: number;
  readonly kind: XNoticeKind;
  readonly readAt: number | null;
};

const FAILURE = 'Invalid X notice';
const MIN_TIMESTAMP_MS = -62135596800000;
const MAX_TIMESTAMP_MS = 253402300799999;
const NOTICE_KEYS = ['schemaVersion', 'id', 'date', 'linkRevision', 'kind', 'readAt'];

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function isKind(value: unknown): value is XNoticeKind {
  return value === 'post_failed' || value === 'unknown_post' || value === 'relink_required';
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_TIMESTAMP_MS && value <= MAX_TIMESTAMP_MS;
}

/** Only a missing field means no notice. Never repair unknown stored values. */
export function readXNotice(input: unknown): XNotice | null {
  if (input === undefined) return null;
  try {
    requireValue(input !== null && typeof input === 'object' && !Array.isArray(input));
    const prototype: unknown = Object.getPrototypeOf(input);
    requireValue(prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(input);
    requireValue(keys.length === NOTICE_KEYS.length);
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      requireValue(typeof key === 'string' && NOTICE_KEYS.includes(key));
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      requireValue(descriptor !== undefined && descriptor.enumerable === true
        && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
      fields[key] = descriptor.value;
    }
    const { schemaVersion, id, date, linkRevision, kind, readAt } = fields;
    requireValue(schemaVersion === 1);
    requireValue(typeof id === 'string' && id.length === 64 && /^[0-9a-f]{64}$/.test(id));
    requireValue(typeof date === 'string' && date.length === 10 && isValidDateKey(date));
    requireValue(typeof linkRevision === 'number'
      && Number.isSafeInteger(linkRevision) && linkRevision > 0);
    requireValue(isKind(kind));
    requireValue(readAt === null || isTime(readAt));
    return { schemaVersion: 1, id, date, linkRevision, kind, readAt };
  } catch {
    throw new Error(FAILURE);
  }
}

/** Select a root-field update without reviving acknowledged or newer notices. */
export function selectXNotice(previous: unknown, incoming: XNotice): {
  readonly notice: XNotice;
  readonly changed: boolean;
} {
  const current = readXNotice(previous);
  const next = readXNotice(incoming);
  requireValue(next !== null);
  if (current !== null) {
    if (current.id === next.id) {
      requireValue(current.date === next.date && current.linkRevision === next.linkRevision
        && current.kind === next.kind);
      return { notice: current, changed: false };
    }
    if (current.date > next.date) return { notice: current, changed: false };
  }
  return { notice: next, changed: true };
}
