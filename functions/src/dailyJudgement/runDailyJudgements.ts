import {
  FieldPath,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

import { addDays, isValidDateKey, toJstDateKey } from '../../../shared/date';
import { AccountWriteBlockedError } from '../account/accountWriteGuard';
import { initializeHistory } from './initializeHistory';
import { judgeUserDay, type JudgeUserDayResult } from './judgeUserDay';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CONCURRENCY = 10;
const MS_PER_MINUTE = 60_000;
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

type Outcome = JudgeUserDayResult['status'];
export type DailyJudgementsSummary = {
  targetDateKey: string;
  processed: number;
  initialized: number;
  failed: number;
  outcomes: Record<Outcome, number>;
  excludedSessions: {
    invalid_session_shape: number;
    invalid_session_time: number;
  };
};

export type DailyJudgementsDeps = {
  db: Firestore;
  pageSize?: number;
  concurrency?: number;
  initializeHistory?: typeof initializeHistory;
  judgeUserDay?: typeof judgeUserDay;
};

/** 原例外・UID・保存値は保持せず、固定項目の集計だけを再試行元へ返す。 */
export class DailyJudgementsError extends Error {
  readonly summary: DailyJudgementsSummary;

  constructor(summary: DailyJudgementsSummary) {
    super('Daily judgements failed');
    this.name = 'DailyJudgementsError';
    this.summary = {
      ...summary,
      outcomes: { ...summary.outcomes },
      excludedSessions: { ...summary.excludedSessions },
    };
  }
}

function invalidSchedule(): never {
  throw new RangeError('Invalid daily judgement schedule time');
}

/** 日付の自動繰上げやローカル時刻への暗黙変換を許可しない。 */
function targetDate(scheduleTime: string): string {
  if (typeof scheduleTime !== 'string') return invalidSchedule();
  const match = SCHEDULE_PATTERN.exec(scheduleTime);
  // RegExpの末尾$は最後の改行の直前にも一致するため、長さも確認する。
  if (match === null || match[0].length !== scheduleTime.length) return invalidSchedule();
  const [, year, month, day, hourText, minuteText, secondText, fraction, zone] = match;
  const localDate = year + '-' + month + '-' + day;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!isValidDateKey(localDate) || hour > 23 || minute > 59 || second > 59) {
    return invalidSchedule();
  }
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return invalidSchedule();
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '+' ? 1 : -1);
  }
  // 小数秒は日付計算に必要なミリ秒まで。現在時刻には依存しない。
  const milliseconds = Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  local.setUTCHours(hour, minute, second, milliseconds);
  const epochMs = local.getTime() - offsetMinutes * MS_PER_MINUTE;
  if (!Number.isFinite(epochMs)) return invalidSchedule();
  const scheduledDate = toJstDateKey(epochMs);
  if (!isValidDateKey(scheduledDate)) return invalidSchedule();
  const previousDate = addDays(scheduledDate, -1);
  if (!isValidDateKey(previousDate)) return invalidSchedule();
  return previousDate;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('Invalid daily judgement processing configuration');
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 全員処理の内部コア。予定時刻・設定の検証を全I/Oより先に完了する。
 * ページ内workerを待ち切ってから次ページを取得し、並列上限を維持する。
 * 結果の保存・削除ガード・履歴検証は既存コアへ委譲する。
 */
export async function runDailyJudgements(
  scheduleTime: string,
  deps: DailyJudgementsDeps,
): Promise<DailyJudgementsSummary> {
  const targetDateKey = targetDate(scheduleTime);
  const pageSize = positiveInteger(deps.pageSize, DEFAULT_PAGE_SIZE);
  const concurrency = positiveInteger(deps.concurrency, DEFAULT_CONCURRENCY);
  const summary: DailyJudgementsSummary = {
    targetDateKey,
    processed: 0,
    initialized: 0,
    failed: 0,
    outcomes: {
      created: 0, already: 0, beforeCoverage: 0,
      noAccount: 0, deleting: 0, noGoal: 0, skipped: 0,
    },
    excludedSessions: { invalid_session_shape: 0, invalid_session_time: 0 },
  };
  const { db } = deps;
  const initialize = deps.initializeHistory ?? initializeHistory;
  const judge = deps.judgeUserDay ?? judgeUserDay;

  async function processUser(snapshot: QueryDocumentSnapshot): Promise<JudgeUserDayResult> {
    const uid = snapshot.id;
    // users直下のsnapshotだけを受け付ける。UID自体は各既存コアがI/O前に検証する。
    if (snapshot.ref.path !== 'users/' + uid) {
      throw new RangeError('Invalid daily judgement user reference');
    }
    const data = snapshot.data();
    if (
      data.deletionInProgress !== true
      && !hasOwn(data, 'judgementHistoryStartedAt')
      && !hasOwn(data, 'judgementRevisions')
    ) {
      try {
        const initialized = await initialize(db, uid);
        if (initialized.status === 'initialized') summary.initialized += 1;
      } catch (error: unknown) {
        // 列挙後の削除も既存transaction内のguardで分類し、親を再作成しない。
        if (error instanceof AccountWriteBlockedError) {
          return { status: error.reason === 'missing' ? 'noAccount' : 'deleting' };
        }
        throw error;
      }
    }
    // 部分metadataも修復せず渡す。初期化後のcutoff判定も実コアで再読取する。
    return judge(uid, targetDateKey, { db });
  }

  try {
    const users = db.collection('users').orderBy(FieldPath.documentId());
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      const query = cursor === undefined ? users : users.startAfter(cursor);
      const page = await query.limit(pageSize).get();
      if (page.empty) break;
      let nextIndex = 0;
      async function worker(): Promise<void> {
        while (nextIndex < page.docs.length) {
          const snapshot = page.docs[nextIndex];
          nextIndex += 1;
          summary.processed += 1;
          try {
            const outcome = await processUser(snapshot);
            summary.outcomes[outcome.status] += 1;
            if (outcome.status === 'created') {
              for (const diagnostic of outcome.excludedSessions) {
                // IDやraw値を保持せず、既存コアの固定reasonだけを数える。
                if (diagnostic.reason === 'invalid_session_shape') {
                  summary.excludedSessions.invalid_session_shape += 1;
                } else if (diagnostic.reason === 'invalid_session_time') {
                  summary.excludedSessions.invalid_session_time += 1;
                }
              }
            }
          } catch {
            summary.failed += 1;
          }
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(concurrency, page.docs.length) },
        () => worker(),
      ));
      if (page.size < pageSize) break;
      cursor = page.docs[page.docs.length - 1];
    }
  } catch {
    // query失敗時も処理済み件数を保持する。failedはユーザー単位の失敗数。
    throw new DailyJudgementsError(summary);
  }
  if (summary.failed > 0) throw new DailyJudgementsError(summary);
  return summary;
}
