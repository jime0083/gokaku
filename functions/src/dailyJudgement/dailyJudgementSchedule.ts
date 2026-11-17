import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onSchedule, type ScheduledEvent, type ScheduleOptions } from 'firebase-functions/v2/scheduler';
import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { DailyJudgementsError, runDailyJudgements } from './runDailyJudgements';

const DAILY_JUDGEMENT_SCHEDULE_OPTIONS: ScheduleOptions = {
  schedule: '0 0 * * *',
  timeZone: 'Asia/Tokyo',
  region: FUNCTIONS_REGION,
  timeoutSeconds: 1800,
  maxInstances: 1,
  concurrency: 1,
  retryCount: 3,
  maxRetrySeconds: 21600,
  minBackoffSeconds: 60,
  maxBackoffSeconds: 600,
};

type DailyJudgementScheduleDeps = {
  runDailyJudgements: (scheduleTime: string) => Promise<unknown>;
};

/** Admin SDKは依存の実行時に取得する。factory生成時には初期化しない。 */
function createProductionDailyJudgementScheduleDeps(): DailyJudgementScheduleDeps {
  return {
    runDailyJudgements: (scheduleTime) => {
      ensureAdminApp();
      return runDailyJudgements(scheduleTime, { db: getFirestore() });
    },
  };
}

const DAILY_JUDGEMENT_COUNT_KEYS = ['processed', 'initialized', 'failed'] as const;
const DAILY_JUDGEMENT_OUTCOME_KEYS = [
  'created', 'already', 'beforeCoverage', 'noAccount', 'deleting', 'noGoal', 'skipped',
] as const;
const DAILY_JUDGEMENT_EXCLUDED_KEYS = ['invalid_session_shape', 'invalid_session_time'] as const;

function isSummaryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 固定キーのown data propertyだけを読み、欠損や不正値を補完しない。 */
function readSummaryCounts(
  value: unknown,
  keys: readonly string[],
): Record<string, number> | undefined {
  if (!isSummaryRecord(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    const count: unknown = descriptor.value;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    counts[key] = count;
  }
  return counts;
}

/** ログの抽出・出力失敗は判定結果やSchedulerの再試行へ影響させない。 */
function logDailyJudgementSummary(value: unknown): void {
  try {
    if (!isSummaryRecord(value)) return;
    const counts = readSummaryCounts(value, DAILY_JUDGEMENT_COUNT_KEYS);
    const outcomes = readSummaryCounts(value.outcomes, DAILY_JUDGEMENT_OUTCOME_KEYS);
    const excludedSessions = readSummaryCounts(value.excludedSessions, DAILY_JUDGEMENT_EXCLUDED_KEYS);
    if (counts === undefined || outcomes === undefined || excludedSessions === undefined) return;
    logger.info('usage_summary', {
      event: 'usage_summary',
      operation: 'daily_judgement',
      processed: counts.processed,
      initialized: counts.initialized,
      failed: counts.failed,
      outcomes,
      excludedSessions,
    });
  } catch {
    // raw errorや入力値を別のログへ渡さない。
  }
}

async function handleDailyJudgementSchedule(
  event: ScheduledEvent,
  deps: DailyJudgementScheduleDeps,
): Promise<void> {
  let summary: unknown;
  try {
    summary = await deps.runDailyJudgements(event.scheduleTime);
  } catch (error: unknown) {
    if (error instanceof DailyJudgementsError) logDailyJudgementSummary(error.summary);
    throw error;
  }
  logDailyJudgementSummary(summary);
}

export const dailyStudyJudgement = onSchedule(
  DAILY_JUDGEMENT_SCHEDULE_OPTIONS,
  (event) => handleDailyJudgementSchedule(event, createProductionDailyJudgementScheduleDeps()),
);
