import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule, type ScheduledEvent, type ScheduleOptions } from 'firebase-functions/v2/scheduler';
import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { runDailyJudgements } from './runDailyJudgements';

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

async function handleDailyJudgementSchedule(
  event: ScheduledEvent,
  deps: DailyJudgementScheduleDeps,
): Promise<void> {
  await deps.runDailyJudgements(event.scheduleTime);
}

export const dailyStudyJudgement = onSchedule(
  DAILY_JUDGEMENT_SCHEDULE_OPTIONS,
  (event) => handleDailyJudgementSchedule(event, createProductionDailyJudgementScheduleDeps()),
);
