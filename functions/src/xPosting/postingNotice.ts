import { createHash } from 'node:crypto';

import { readXNotice, type XNotice, type XNoticeKind } from '../domain';

export type PostingNoticeInput = {
  readonly date: string;
  readonly goalId: string;
  readonly linkRevision: number;
  readonly kind: XNoticeKind;
};

const FAILURE = 'Invalid posting notice input';
const MAX_DOCUMENT_ID_BYTES = 1500;
const INPUT_KEYS = ['date', 'goalId', 'linkRevision', 'kind'];

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

/** Server-only identity hashing; no post body, credentials, clock or I/O. */
export function createPostingNotice(input: PostingNoticeInput): XNotice {
  try {
    requireValue(input !== null && typeof input === 'object' && !Array.isArray(input));
    const prototype: unknown = Object.getPrototypeOf(input);
    requireValue(prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(input);
    requireValue(keys.length === INPUT_KEYS.length);
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      requireValue(typeof key === 'string' && INPUT_KEYS.includes(key));
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      requireValue(descriptor !== undefined && descriptor.enumerable === true
        && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
      fields[key] = descriptor.value;
    }
    const { date, goalId, linkRevision, kind } = fields;
    requireValue(typeof goalId === 'string' && goalId.trim().length > 0
      && !goalId.includes('/') && goalId !== '.' && goalId !== '..'
      && !/^__.*__$/.test(goalId)
      && Buffer.byteLength(goalId, 'utf8') <= MAX_DOCUMENT_ID_BYTES
      && Buffer.from(goalId, 'utf8').toString('utf8') === goalId);
    // Only scalar values reach JSON.stringify; protocol validation below checks
    // the calendar date, safe positive revision and allowed kind without coercion.
    requireValue(typeof date === 'string' && typeof linkRevision === 'number'
      && typeof kind === 'string');
    const id = createHash('sha256')
      .update(JSON.stringify([date, goalId, linkRevision, kind]), 'utf8')
      .digest('hex');
    const notice = readXNotice({
      schemaVersion: 1, id, date, linkRevision, kind, readAt: null,
    });
    requireValue(notice !== null);
    return notice;
  } catch {
    throw new Error(FAILURE);
  }
}
