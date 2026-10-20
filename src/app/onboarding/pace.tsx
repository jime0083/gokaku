import {
  calculatePace,
  formatWithThousandsSeparator,
  splitHoursMinutes,
  type DateKey,
  type PaceTotal,
} from '@shared/index';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { submitGoalReplacement, ReplacementMeasuringError, REPLACEMENT_COMMUNICATION_ERROR } from '@/features/goals/goalReplacementFlow';

import { Card } from '@/components/Card';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StepScreen } from '@/components/StepScreen';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import {
  validateDailyMinutes,
  validateExamDate,
  validateGoalNotLessThanMin,
  validateTargetHours,
} from '@/features/onboarding/validation';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 分 → 「○時間○分」(時間は3桁区切り。requirements 4-4, problem P-017) */
function formatHoursMinutesDisplay(totalMinutes: number): string {
  const { hours, minutes } = splitHoursMinutes(totalMinutes);
  return `${formatWithThousandsSeparator(hours)}時間${minutes}分`;
}

/** 試験日の大きな表示(target.tsx と同じ形式。requirements 4-1) */
function formatExamDateDisplay(examDate: DateKey, days: number): string {
  const [year, month, day] = examDate.split('-').map(Number);
  return `試験日: ${year}年${month}月${day}日(あと${days}日)`;
}

/** 「1日○時間○分 × ○日 = ○時間○分(目標の○%)」(requirements 4-4, mokuhyo.txt 3) */
function formatPaceLine(dailyMinutes: number, days: number, total: PaceTotal): string {
  return (
    `1日${formatHoursMinutesDisplay(dailyMinutes)} × ${days}日 = ` +
    `${formatHoursMinutesDisplay(total.totalMinutes)}(目標の${total.percent.toFixed(1)}%)`
  );
}

/**
 * オンボーディング 7歩目(受験・資格ルート共通): ペース確認画面(requirements 4-4, mokuhyo.txt 3)。
 * 「OK、登録する」の登録処理(Sign in with Apple → 目標保存)は 3-5c で実装するため、ここでは何もしない。
 * 「修正する」は StepScreen の「戻る」と同じ、1つ前の画面(1日の時間)に戻る。
 * 計算は shared/pace.ts の calculatePace を使い、ここでは重複実装しない
 */
export default function PaceScreen() {
  const router = useRouter();
  const { draft, replacement } = useOnboardingDraft();
  const [registering, setRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const registrationLock = useRef(false);
  const register = async () => {
    // 初回登録(3-5c)は未実装。replacement branchだけ処理する。
    if (!replacement || registrationLock.current) return;
    registrationLock.current = true; setRegistering(true); setRegistrationError(null);
    try {
      await submitGoalReplacement(replacement, Date.now());
      router.replace('/(tabs)/home');
    } catch (error) {
      setRegistrationError(error instanceof ReplacementMeasuringError ? error.message : REPLACEMENT_COMMUNICATION_ERROR);
    } finally { registrationLock.current = false; setRegistering(false); }
  };
  const [now] = useState(() => Date.now());

  const dailyTimeValid =
    validateDailyMinutes(draft.minDailyMinutes, '1日の最低勉強時間') === null &&
    validateDailyMinutes(draft.goalDailyMinutes, '1日の努力目標勉強時間') === null &&
    validateGoalNotLessThanMin(draft.minDailyMinutes, draft.goalDailyMinutes) === null;

  const targetValid =
    validateTargetHours(draft.targetHoursText) === null &&
    validateExamDate(draft.examDate, now) === null;

  const pace =
    dailyTimeValid && targetValid
      ? calculatePace(
          {
            targetHours: Number(draft.targetHoursText),
            examDate: draft.examDate as DateKey,
            minDailyMinutes: draft.minDailyMinutes as number,
            goalDailyMinutes: draft.goalDailyMinutes as number,
          },
          now,
        )
      : null;

  const goBack = () => { if (!registrationLock.current && !replacement?.committedGoalId) router.replace(resolveOnboardingBackRoute('/onboarding/pace', draft)); };

  // この画面に不完全な入力(前の画面を飛ばした場合)や、画面を開いている間に日付が変わって
  // 試験日が今日以前になった場合(calculatePace の exam_date_not_future)は、入力画面へ戻す
  useEffect(() => {
    if (replacement?.committedGoalId) return;
    if (!dailyTimeValid) {
      router.replace('/onboarding/daily-time');
      return;
    }
    if (!targetValid || pace?.status === 'exam_date_not_future') {
      router.replace('/onboarding/target');
    }
  }, [dailyTimeValid, targetValid, pace, router, replacement]);

  if (replacement?.committedGoalId) {
    return <StepScreen title="目標の変更を反映" onBack={goBack} showNext={false}>
      <ErrorText message={registrationError} testID="pace-replacement-error" />
      <PrimaryButton title={registering ? '反映中...' : '反映を続ける'} onPress={register} disabled={registering} testID="pace-replacement-retry" />
    </StepScreen>;
  }

  if (pace === null || pace.status !== 'ok' || draft.examDate === null) {
    return <View style={styles.root} />;
  }

  return (
    <StepScreen title="ペース確認" onBack={goBack} showNext={false} backTestID="pace-back-button">
      <Text testID="pace-exam-date-text" style={styles.examDate}>
        {formatExamDateDisplay(draft.examDate, pace.days)}
      </Text>

      <Text testID="pace-target-hours-text" style={styles.targetHours}>
        目標勉強時間: {formatWithThousandsSeparator(Number(draft.targetHoursText))}時間
      </Text>

      <Card style={styles.card}>
        <Text style={styles.label}>最低勉強時間ペース</Text>
        <Text testID="pace-min-line-text" style={styles.line}>
          {formatPaceLine(draft.minDailyMinutes as number, pace.days, pace.minPace)}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>努力目標勉強時間ペース</Text>
        <Text testID="pace-goal-line-text" style={styles.line}>
          {formatPaceLine(draft.goalDailyMinutes as number, pace.days, pace.goalPace)}
        </Text>
      </Card>

      {pace.warning ? (
        <ErrorText
          testID="pace-warning-text"
          message={`目標達成には1日${formatHoursMinutesDisplay(pace.requiredDailyMinutes as number)}必要です`}
        />
      ) : null}

      <Text testID="pace-question-text" style={styles.question}>
        このペースで大丈夫ですか？
      </Text>

      <View style={styles.buttonArea}>
        <PrimaryButton
          title="修正する"
          onPress={goBack}
          variant="secondary"
          disabled={registering}
          testID="pace-fix-button"
        />
        <View style={styles.spacer} />
        <PrimaryButton
          title={registering ? '登録中...' : 'OK、登録する'}
          disabled={registering}
          onPress={register}
          testID="pace-register-button"
        />
        <ErrorText message={registrationError} testID="pace-replacement-error" />
        {registrationError ? <PrimaryButton title="再試行" onPress={register} disabled={registering} testID="pace-replacement-retry" /> : null}
      </View>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  examDate: {
    marginTop: spacing.lg,
    fontSize: typography.heading.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  targetHours: {
    marginTop: spacing.sm,
    fontSize: typography.body.fontSize,
    color: colors.text,
  },
  card: {
    marginTop: spacing.md,
  },
  label: {
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  line: {
    marginTop: spacing.xs,
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
  question: {
    marginTop: spacing.lg,
    fontSize: typography.body.fontSize,
    color: colors.text,
  },
  buttonArea: {
    marginTop: spacing.md,
  },
  spacer: {
    height: spacing.sm,
  },
});
