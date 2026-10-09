import { SUBJECT_COUNT_RANGE } from '@shared/index';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { TextField } from '@/components/TextField';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { validateDeviation } from '@/features/onboarding/validation';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * オンボーディング 3歩目(受験ルート): 目標偏差値・現在の偏差値・受験科目数の入力(requirements 4-2)。
 * 未入力(初期状態)はエラー文言を出さずに「次へ」だけ押せなくし、何か入力して無効な場合(範囲外)は
 * 即時にエラー文言を表示する(mokuhyo.txt 1: 該当項目の下に理由を表示するため、TextField 内のエラー表示を使う。
 * StepScreen 自体の error は使わない(TextField と二重表示になるため))
 */
export default function DeviationScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();

  const targetError = validateDeviation(draft.targetDeviationText, '目標偏差値');
  const currentError = validateDeviation(draft.currentDeviationText, '現在の偏差値');
  const visibleTargetError = draft.targetDeviationText.length > 0 ? targetError : null;
  const visibleCurrentError = draft.currentDeviationText.length > 0 ? currentError : null;
  const canProceed = targetError === null && currentError === null;

  const handleNext = () => {
    if (!canProceed) return;
    router.push('/onboarding/estimate');
  };

  const changeSubjectCount = (delta: number) => {
    const next = Math.min(
      SUBJECT_COUNT_RANGE.max,
      Math.max(SUBJECT_COUNT_RANGE.min, draft.subjectCount + delta),
    );
    updateDraft({ subjectCount: next });
  };

  return (
    <StepScreen
      title="偏差値と受験科目数を入力してください"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/deviation', draft))}
      onNext={handleNext}
      nextDisabled={!canProceed}
      backTestID="deviation-back-button"
      nextTestID="deviation-next-button"
    >
      <TextField
        label="目標偏差値"
        value={draft.targetDeviationText}
        onChangeText={(text) => updateDraft({ targetDeviationText: text })}
        keyboardType="decimal-pad"
        placeholder="例: 60.0"
        error={visibleTargetError}
        testID="target-deviation-input"
        errorTestID="target-deviation-error"
      />
      <TextField
        label="現在の偏差値"
        value={draft.currentDeviationText}
        onChangeText={(text) => updateDraft({ currentDeviationText: text })}
        keyboardType="decimal-pad"
        placeholder="例: 50.0"
        error={visibleCurrentError}
        testID="current-deviation-input"
        errorTestID="current-deviation-error"
      />
      <Text style={styles.label}>受験科目数</Text>
      <View style={styles.counterRow}>
        <Pressable
          accessibilityRole="button"
          testID="subject-count-decrement-button"
          onPress={() => changeSubjectCount(-1)}
          style={styles.counterButton}
        >
          <Text style={styles.counterButtonText}>−</Text>
        </Pressable>
        <Text testID="subject-count-value" style={styles.counterValue}>
          {draft.subjectCount}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="subject-count-increment-button"
          onPress={() => changeSubjectCount(1)}
          style={styles.counterButton}
        >
          <Text style={styles.counterButtonText}>＋</Text>
        </Pressable>
      </View>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  label: {
    marginTop: spacing.lg,
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  counterRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  counterButton: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counterButtonText: {
    fontSize: 20,
    color: colors.primary,
  },
  counterValue: {
    width: 48,
    textAlign: 'center',
    fontSize: typography.body.fontSize + 2,
    color: colors.text,
  },
});
