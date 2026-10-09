import {
  isDeviationAlreadyReached,
  validateCertOtherName,
  validateDailyMinutes,
  validateDeviation,
  validateExamDate,
  validateGoalNotLessThanMin,
  validateTargetHours,
  validateUniversity,
} from './validation';
import { OTHER_CERTIFICATION_ID, type OnboardingDraft } from './types';

/** オンボーディング(受験ルート・資格ルート)の画面パス */
export type OnboardingRoute =
  | '/onboarding'
  | '/onboarding/university'
  | '/onboarding/deviation'
  | '/onboarding/estimate'
  | '/onboarding/cert-select'
  | '/onboarding/cert-estimate'
  | '/onboarding/target'
  | '/onboarding/daily-time'
  | '/onboarding/pace';

/**
 * 受験ルートの画面の並び順(「戻る」の行き先をここから決める。requirements 4-1, problem P-015)。
 * アプリ再起動後に途中の画面から再開した場合、入れ子の Stack にはその画面しか履歴がなく、
 * ナビゲーション側の「戻る」(router.back())だけでは正しい前の画面に戻れない。
 * そのため各画面の「戻る」は、実際の遷移履歴ではなくこの並び順から行き先を決める
 */
const EXAM_ROUTE_ORDER: readonly OnboardingRoute[] = [
  '/onboarding',
  '/onboarding/university',
  '/onboarding/deviation',
  '/onboarding/estimate',
  '/onboarding/target',
  '/onboarding/daily-time',
  '/onboarding/pace',
];

/** 資格ルートの画面の並び順(一覧から選択した場合。requirements 4-3) */
const CERT_ROUTE_ORDER: readonly OnboardingRoute[] = [
  '/onboarding',
  '/onboarding/cert-select',
  '/onboarding/cert-estimate',
  '/onboarding/target',
  '/onboarding/daily-time',
  '/onboarding/pace',
];

/** 資格ルートの画面の並び順(「その他」を選択した場合。概算画面を飛ばす。requirements 4-3) */
const CERT_OTHER_ROUTE_ORDER: readonly OnboardingRoute[] = [
  '/onboarding',
  '/onboarding/cert-select',
  '/onboarding/target',
  '/onboarding/daily-time',
  '/onboarding/pace',
];

/**
 * 「戻る」の行き先の判定に使うステップ順の配列を、現在の画面と draft から選ぶ。
 * university・deviation・estimate は受験ルートにしかない画面、cert-select・cert-estimate は
 * 資格ルートにしかない画面のため、画面自体から一意に決まる。target・daily-time(と最初のステップの
 * /onboarding)は両ルート共通の画面のため、draft.type(資格ルートはさらに certId が
 * OTHER_CERTIFICATION_ID か)で決める
 */
function resolveRouteOrder(
  current: OnboardingRoute,
  draft: OnboardingDraft,
): readonly OnboardingRoute[] {
  if (
    current === '/onboarding/university' ||
    current === '/onboarding/deviation' ||
    current === '/onboarding/estimate'
  ) {
    return EXAM_ROUTE_ORDER;
  }
  if (current === '/onboarding/cert-select' || current === '/onboarding/cert-estimate') {
    return draft.certId === OTHER_CERTIFICATION_ID ? CERT_OTHER_ROUTE_ORDER : CERT_ROUTE_ORDER;
  }
  if (draft.type === 'cert') {
    return draft.certId === OTHER_CERTIFICATION_ID ? CERT_OTHER_ROUTE_ORDER : CERT_ROUTE_ORDER;
  }
  return EXAM_ROUTE_ORDER;
}

/**
 * 「戻る」の行き先を、現在の画面のステップの並び順から決める(requirements 4-1, problem P-015)。
 * 最初のステップ(/onboarding。受験/資格の選択)の戻り先は初回起動画面('/')
 */
export function resolveOnboardingBackRoute(
  current: OnboardingRoute,
  draft: OnboardingDraft,
): '/' | OnboardingRoute {
  const order = resolveRouteOrder(current, draft);
  const index = order.indexOf(current);
  if (index <= 0) {
    return '/';
  }
  return order[index - 1];
}

/** 1日の最低・努力目標勉強時間が両方確定し、入力チェックを通っているか(ペース確認画面へ進めるか) */
function isDailyTimeComplete(draft: OnboardingDraft): boolean {
  return (
    validateDailyMinutes(draft.minDailyMinutes, '1日の最低勉強時間') === null &&
    validateDailyMinutes(draft.goalDailyMinutes, '1日の努力目標勉強時間') === null &&
    validateGoalNotLessThanMin(draft.minDailyMinutes, draft.goalDailyMinutes) === null
  );
}

/** 資格ルートの再開先を判定する(resolveOnboardingResumeRoute の資格ルート部分。requirements 4-3) */
function resolveCertResumeRoute(draft: OnboardingDraft, now: number): OnboardingRoute {
  if (draft.certId === null) {
    return '/onboarding/cert-select';
  }
  if (draft.certId === OTHER_CERTIFICATION_ID) {
    if (validateCertOtherName(draft.certOtherName) !== null) {
      return '/onboarding/cert-select';
    }
  } else if (draft.targetHoursText.trim().length === 0) {
    // まだ概算画面の「次へ」を見ていない(目標勉強時間の初期値が決まっていない)ため、概算画面へ
    return '/onboarding/cert-estimate';
  }
  if (validateTargetHours(draft.targetHoursText) !== null || validateExamDate(draft.examDate, now) !== null) {
    return '/onboarding/target';
  }
  if (!isDailyTimeComplete(draft)) {
    return '/onboarding/daily-time';
  }
  return '/onboarding/pace';
}

/**
 * 端末に一時保存された入力から、再開すべき画面を決める(requirements 4-1: 「次に開いたときに同じ画面から続けられる」)。
 * 現在位置そのものは保存しないため、各画面の入力チェック(validation.ts)を使って
 * 「まだ入力が必要な、最初の画面」を順に判定する。now は「今日」の判定に使う(日本時間。requirements 3-1)
 */
export function resolveOnboardingResumeRoute(draft: OnboardingDraft, now: number): OnboardingRoute {
  if (draft.type === 'cert') {
    return resolveCertResumeRoute(draft, now);
  }
  if (draft.type !== 'exam') {
    return '/onboarding';
  }
  if (validateUniversity(draft.university) !== null) {
    return '/onboarding/university';
  }
  const deviationsOk =
    validateDeviation(draft.targetDeviationText, '目標偏差値') === null &&
    validateDeviation(draft.currentDeviationText, '現在の偏差値') === null;
  if (!deviationsOk) {
    return '/onboarding/deviation';
  }
  const targetHoursEmpty = draft.targetHoursText.trim().length === 0;
  const alreadyReached = isDeviationAlreadyReached(draft.currentDeviationText, draft.targetDeviationText);
  if (targetHoursEmpty && !alreadyReached) {
    // 概算の上限をまだ見ていない(目標勉強時間の初期値が決まっていない)ため、概算画面へ
    return '/onboarding/estimate';
  }
  if (validateTargetHours(draft.targetHoursText) !== null || validateExamDate(draft.examDate, now) !== null) {
    return '/onboarding/target';
  }
  if (!isDailyTimeComplete(draft)) {
    return '/onboarding/daily-time';
  }
  return '/onboarding/pace';
}
