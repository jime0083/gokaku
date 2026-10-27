import {
  FieldPath,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

import { isValidDateKey } from '../../../shared/date';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CONCURRENCY = 10;
const MAX_UID_LENGTH = 128;
const MAX_DOCUMENT_ID_BYTES = 1500;
const DATE_KEY_LENGTH = 10;
const POSTING_STATUSES = [
  'posted', 'retry_wait', 'failed', 'unknown',
  'cancelled', 'waiting', 'skipped', 'unavailable',
] as const;

type PostingStatus = typeof POSTING_STATUSES[number];

export type PendingPostingsSummary = {
  processed: number;
  errors: number;
  outcomes: Record<PostingStatus, number>;
};

export type PendingPostingsDeps = {
  db: Firestore;
  processPostingDate: (uid: string, date: string) => Promise<{ status: PostingStatus }>;
  pageSize?: number;
  concurrency?: number;
};

/** 原例外・文書参照・保存値を保持せず、既知の集計項目だけをコピーする。 */
export class PendingPostingsError extends Error {
  readonly summary: PendingPostingsSummary;

  constructor(summary: PendingPostingsSummary) {
    super('Pending postings failed');
    this.name = 'PendingPostingsError';
    this.summary = {
      processed: summary.processed,
      errors: summary.errors,
      outcomes: {
        posted: summary.outcomes.posted,
        retry_wait: summary.outcomes.retry_wait,
        failed: summary.outcomes.failed,
        unknown: summary.outcomes.unknown,
        cancelled: summary.outcomes.cancelled,
        waiting: summary.outcomes.waiting,
        skipped: summary.outcomes.skipped,
        unavailable: summary.outcomes.unavailable,
      },
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('Invalid pending posting processing configuration');
  }
  return value;
}

/** postingJobStore/createPostingJobと同じUID制約をI/Oなしで確認する。 */
function isUid(value: string): boolean {
  return value.trim().length > 0
    && value.length <= MAX_UID_LENGTH
    && !value.includes('/')
    && value !== '.'
    && value !== '..'
    && !/^__.*__$/.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_DOCUMENT_ID_BYTES
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function postingTarget(snapshot: QueryDocumentSnapshot): { uid: string; date: string } {
  const parts = snapshot.ref.path.split('/');
  if (
    parts.length !== 4
    || parts[0] !== 'users'
    || parts[2] !== 'dailyResults'
    || !isUid(parts[1])
    // sharedの日付検証に加え、末尾改行を含むキーも拒否する。
    || parts[3].length !== DATE_KEY_LENGTH
    || !isValidDateKey(parts[3])
  ) {
    throw new RangeError('Invalid pending posting reference');
  }
  return { uid: parts[1], date: parts[3] };
}

function isPostingStatus(value: unknown): value is PostingStatus {
  return typeof value === 'string' && POSTING_STATUSES.some((status) => status === value);
}

/** 投稿状態の保存・送信判断は注入された1日分workerへ委譲する。 */
export async function runPendingPostings(
  deps: PendingPostingsDeps,
): Promise<PendingPostingsSummary> {
  const pageSize = positiveInteger(deps.pageSize, DEFAULT_PAGE_SIZE);
  const concurrency = positiveInteger(deps.concurrency, DEFAULT_CONCURRENCY);
  if (typeof deps.processPostingDate !== 'function') {
    throw new TypeError('Invalid pending posting worker');
  }
  const { db, processPostingDate } = deps;
  const summary: PendingPostingsSummary = {
    processed: 0,
    errors: 0,
    outcomes: {
      posted: 0, retry_wait: 0, failed: 0, unknown: 0,
      cancelled: 0, waiting: 0, skipped: 0, unavailable: 0,
    },
  };

  try {
    const pending = db.collectionGroup('dailyResults')
      .where('postStatus', '==', 'pending')
      .orderBy(FieldPath.documentId(), 'asc');
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      const query = cursor === undefined ? pending : pending.startAfter(cursor);
      const page = await query.limit(pageSize).get();
      if (page.empty) break;
      const documents = page.docs;
      let nextIndex = 0;
      async function worker(): Promise<void> {
        while (nextIndex < documents.length) {
          const snapshot = documents[nextIndex];
          nextIndex += 1;
          summary.processed += 1;
          try {
            const { uid, date } = postingTarget(snapshot);
            const result = await processPostingDate(uid, date);
            if (!isPostingStatus(result.status)) {
              throw new Error('Invalid pending posting worker result');
            }
            summary.outcomes[result.status] += 1;
          } catch {
            summary.errors += 1;
          }
        }
      }
      // 個別失敗はworker内で集計する。全worker完了後にだけ次ページへ進む。
      await Promise.all(Array.from(
        { length: Math.min(concurrency, documents.length) },
        () => worker(),
      ));
      if (page.size < pageSize) break;
      // workerがpendingを解消しても、取得済みsnapshotの文書パスを境界にする。
      cursor = documents[documents.length - 1];
    }
  } catch {
    // query失敗を行エラーとして加算せず、完了した行の既知集計だけを返す。
    throw new PendingPostingsError(summary);
  }
  if (summary.errors > 0) throw new PendingPostingsError(summary);
  return summary;
}
