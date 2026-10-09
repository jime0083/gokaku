import { calculateExamEstimatedHours, formatWithThousandsSeparator } from '@shared/index';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Card } from '@/components/Card';
import { StepScreen } from '@/components/StepScreen';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { resolveAutoFillPatch } from '@/features/onboarding/targetHoursAutoFill';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * オンボーディング 4歩目(受験ルート): 必要勉強時間の概算の提示(requirements 4-2, mokuhyo.txt 2)。
 * 目標偏差値 ≤ 現在の偏差値の場合は「現在の偏差値で目標に届いています」を表示し、概算は出さない
 */
export default function EstimateScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();

  const result = calculateExamEstimatedHours({
    currentDeviation: Number(draft.currentDeviationText),
    targetDeviation: Number(draft.targetDeviationText),
    subjectCount: draft.subjectCount,
  });

  // 目標勉強時間の初期値は概算の上限(概算がない場合は空欄のまま)。
  // 戻って偏差値・科目数を変えた場合も、ユーザーが書き換えていなければ新しい上限に置き換える
  // (requirements 4-2 の 5, 2026-10-09 決定)
  useEffect(() => {
    if (result.status !== 'ok') return;
    const patch = resolveAutoFillPatch(draft, result.upperHours);
    if (patch !== null) {
      updateDraft(patch);
    }
  }, [draft, result, updateDraft]);

  const handleNext = () => {
    router.push('/onboarding/target');
  };

  return (
    <StepScreen
      title="必要勉強時間の概算"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/estimate', draft))}
      onNext={handleNext}
      backTestID="estimate-back-button"
      nextTestID="estimate-next-button"
    >
      <Card style={styles.card}>
        {result.status === 'not_needed' ? (
          <Text testID="estimate-not-needed-text" style={styles.resultText}>
            現在の偏差値で目標に届いています
          </Text>
        ) : (
          <Text testID="estimate-range-text" style={styles.resultText}>
            約{formatWithThousandsSeparator(result.lowerHours)}〜{formatWithThousandsSeparator(result.upperHours)}時間
          </Text>
        )}
        <Text testID="estimate-disclaimer-text" style={styles.disclaimer}>
          あくまで目安です
        </Text>
      </Card>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.lg,
  },
  resultText: {
    fontSize: typography.heading.fontSize + 2,
    fontWeight: 'bold',
    color: colors.primary,
  },
  disclaimer: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
});
