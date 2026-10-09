import { SUBJECT_COUNT_RANGE, type DateKey } from '@shared/index';

/**
 * オンボーディング(受験ルート)の入力中の値(登録前に端末へ一時保存する。requirements 4-1)。
 * 偏差値・目標勉強時間は数字キーボードで自由に入力できるため、未入力(空欄)を表現できる文字列で保持する。
 * 科目数・1日の時間は部品(+-・ドラムロール)が常に値を持つため、「まだ確定していない」ことを示す null を持てるようにする。
 */
export type OnboardingDraft = {
  /** 受験 / 資格の選択 */
  type: 'exam' | 'cert' | null;
  /** 目標大学(自由入力・1〜50文字) */
  university: string;
  /** 目標偏差値(数字キーボードの入力値をそのまま文字列で保持。空文字 = 未入力) */
  targetDeviationText: string;
  /** 現在の偏差値 */
  currentDeviationText: string;
  /** 受験科目数(初期値 3) */
  subjectCount: number;
  /**
   * 目標資格の id(shared/certifications.ts の id。資格ルートのみ)。
   * 一覧にない資格を選んだ場合は OTHER_CERTIFICATION_ID。未選択は null(requirements 4-3)
   */
  certId: string | null;
  /** 資格名(その他。certId が OTHER_CERTIFICATION_ID のときの自由入力・1〜50文字) */
  certOtherName: string;
  /** 目標勉強時間(数字キーボードの入力値をそのまま文字列で保持。空文字 = 未入力) */
  targetHoursText: string;
  /**
   * 最後に自動で入れた目標勉強時間(概算の上限。概算画面の表示や「その他」選択時に設定)。
   * targetHoursText がこの値と一致する間は「ユーザーが自分で書き換えていない」とみなし、
   * 偏差値・科目数・資格を戻って変えたときに新しい上限へ置き換える対象にする(requirements 4-2 の 5, 2026-10-09 決定)。
   * 未自動入力、またはユーザーが書き換えた後は null にはしない(targetHoursText と不一致のまま残る)
   */
  autoFilledTargetHoursText: string | null;
  /** 試験日(未選択は null) */
  examDate: DateKey | null;
  /** 1日の最低勉強時間(分。ドラムロールで確定するまでは null) */
  minDailyMinutes: number | null;
  /** 1日の努力目標勉強時間(分。ドラムロールで確定するまでは null) */
  goalDailyMinutes: number | null;
};

/** 一覧にない資格を選んだことを示す certId の値(requirements 4-3) */
export const OTHER_CERTIFICATION_ID = 'other';

/** 初期状態(すべて未入力) */
export const INITIAL_ONBOARDING_DRAFT: OnboardingDraft = {
  type: null,
  university: '',
  targetDeviationText: '',
  currentDeviationText: '',
  subjectCount: SUBJECT_COUNT_RANGE.default,
  certId: null,
  certOtherName: '',
  targetHoursText: '',
  autoFilledTargetHoursText: null,
  examDate: null,
  minDailyMinutes: null,
  goalDailyMinutes: null,
};
