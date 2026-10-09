import type { DateKey } from '@shared/index';

/**
 * 目標(users/{uid}/goals/{goalId})のドキュメントの形(requirements 5)。
 * 登録時に一度だけ作る(数値変更での上書き・目標変更での新規作成は Phase 6)。
 */

/** 必要勉強時間の概算のスナップショット(登録時に計算した値を保存する。表示には使っていない) */
export type GoalEstimatedHours =
  | { status: 'not_needed' }
  | { status: 'ok'; lowerHours: number | null; upperHours: number }
  | null;

type GoalCommonFields = {
  estimatedHours: GoalEstimatedHours;
  /** 目標勉強時間(時間) */
  targetHours: number;
  /** 試験日(受験日) */
  examDate: DateKey;
  /** 1日の最低勉強時間(分) */
  minDailyMinutes: number;
  /** 1日の努力目標勉強時間(分) */
  goalDailyMinutes: number;
  /** 目標の開始日(登録日。日本時間) */
  startDate: DateKey;
  status: 'active';
  /** 登録時刻(epoch ミリ秒) */
  createdAt: number;
};

export type ExamGoalDocument = GoalCommonFields & {
  type: 'exam';
  university: string;
  targetDeviation: number;
  currentDeviation: number;
  subjectCount: number;
};

export type CertGoalDocument = GoalCommonFields & {
  type: 'cert';
  certId: string;
  /** 「その他」(certId === OTHER_CERTIFICATION_ID)のときの資格名。それ以外は空文字 */
  certOtherName: string;
};

export type GoalDocument = ExamGoalDocument | CertGoalDocument;
