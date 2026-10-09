import { useRouter } from 'expo-router';

import { StepScreen } from '@/components/StepScreen';
import { TextField } from '@/components/TextField';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { FREE_TEXT_MAX_LENGTH, validateUniversity } from '@/features/onboarding/validation';

/**
 * オンボーディング 2歩目(受験ルート): 目標大学の入力(requirements 4-2)。
 * 未入力(初期状態)はエラー文言を出さずに「次へ」だけ押せなくし、何か入力して無効な場合(文字数超過)は
 * 即時にエラー文言を表示する(mokuhyo.txt 1: 該当項目の下に理由を表示するため、TextField 内のエラー表示を使う。
 * StepScreen 自体の error は使わない(TextField と二重表示になるため))
 */
export default function UniversityScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();

  const validationError = validateUniversity(draft.university);
  const error = draft.university.length > 0 ? validationError : null;
  const canProceed = validationError === null;

  const handleNext = () => {
    if (!canProceed) return;
    router.push('/onboarding/deviation');
  };

  return (
    <StepScreen
      title="目標大学を入力してください"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/university', draft))}
      onNext={handleNext}
      nextDisabled={!canProceed}
      backTestID="university-back-button"
      nextTestID="university-next-button"
    >
      <TextField
        label="目標大学"
        value={draft.university}
        onChangeText={(text) => updateDraft({ university: text })}
        maxLength={FREE_TEXT_MAX_LENGTH}
        placeholder="例: ○○大学 ○○学部"
        error={error}
        testID="university-input"
        errorTestID="university-error"
      />
    </StepScreen>
  );
}
