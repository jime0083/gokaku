import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { StepScreen } from '@/components/StepScreen';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { REPLACEMENT_COMMUNICATION_ERROR } from '@/features/goals/goalReplacementFlow';
import { spacing } from '@/theme/spacing';

/**
 * オンボーディング 1歩目: 受験 / 資格勉強の選択(requirements 4-2・4-3)。
 * 3-2a: 資格ボタンを有効化し、資格の選択画面(cert-select)へ進めるようにする(3-1 の暫定を解除)。
 * この画面には「次へ」ボタンがないため StepScreen の showNext=false を使う
 */
export default function RouteSelectScreen() {
  const router = useRouter();
  const { draft, updateDraft, replacement, cancelReplacement } = useOnboardingDraft();
  const [error, setError] = useState<string | null>(null);
  const goBack = async () => {
    if (!replacement) { router.replace(resolveOnboardingBackRoute('/onboarding', draft)); return; }
    try {
      await cancelReplacement();
      router.replace('/(tabs)/home');
    } catch { setError(REPLACEMENT_COMMUNICATION_ERROR); }
  };

  const handleSelectExam = () => {
    updateDraft({ type: 'exam' });
    router.push('/onboarding/university');
  };

  const handleSelectCert = () => {
    updateDraft({ type: 'cert' });
    router.push('/onboarding/cert-select');
  };

  return (
    <StepScreen
      title="目標の種類を選んでください"
      onBack={goBack}
      error={error}
      errorTestID="route-select-replacement-error"
      showNext={false}
      backTestID="route-select-back-button"
    >
      <View style={styles.optionArea}>
        <PrimaryButton title="受験" onPress={handleSelectExam} testID="route-select-exam-button" />
        <View style={styles.spacer} />
        <PrimaryButton
          title="資格"
          onPress={handleSelectCert}
          variant="secondary"
          testID="route-select-cert-button"
        />
      </View>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  optionArea: {
    marginTop: spacing.xl,
  },
  spacer: {
    height: spacing.md,
  },
});
