import { Stack } from 'expo-router';
import { View } from 'react-native';

import { OnboardingDraftProvider, useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { colors } from '@/theme/colors';

function OnboardingStack() {
  const { ready } = useOnboardingDraft();
  // 端末からの一時保存の読み込み中は何も描画しない(初期値での一瞬の表示を防ぐ)
  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function OnboardingLayout() {
  return (
    <OnboardingDraftProvider>
      <OnboardingStack />
    </OnboardingDraftProvider>
  );
}
