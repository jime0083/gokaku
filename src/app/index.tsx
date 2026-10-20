import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { getCurrentUid } from '@/config/firebase';
import { useAccountActions } from '@/features/account/AccountActionBoundary';
import { loadGoalReplacement } from '@/features/onboarding/replacementStorage';
import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { loadOnboardingDraft } from '@/features/onboarding/storage';
import { resolveOnboardingResumeRoute } from '@/features/onboarding/navigation';
import { colors } from '@/theme/colors';

/**
 * 初回起動画面(requirements 4-1)。「はじめる」ボタンのみ。
 * ログイン導線(アカウントをお持ちの方)は 3-5 で追加する。
 * 端末に一時保存された入力があれば、続きの画面から再開する(requirements 4-1)。
 */
export default function LaunchScreen() {
  const router = useRouter();
  const accountActions = useAccountActions();
  const { ready, isReady } = accountActions;
  const [checkedAccountActions, setCheckedAccountActions] = useState<typeof accountActions | null>(null);
  const checkingReplacement = !ready || checkedAccountActions !== accountActions;
  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    const uid = getCurrentUid();
    const resume = async () => {
      const record = uid ? await loadGoalReplacement(uid) : null;
      if (mounted && isReady() && record && getCurrentUid() === uid) {
        router.replace(record.committedGoalId ? '/onboarding/pace' : resolveOnboardingResumeRoute(record.draft, Date.now()));
      }
    };
    void resume().finally(() => {
      if (mounted && isReady()) setCheckedAccountActions(accountActions);
    });
    return () => { mounted = false; };
  }, [accountActions, isReady, ready, router]);

  const handleStart = async () => {
    if (!isReady() || checkingReplacement) return;
    const draft = await loadOnboardingDraft();
    if (!isReady()) return;
    const route = resolveOnboardingResumeRoute(draft, Date.now());
    router.push(route);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>合格ウォッチ</Text>
      <Text style={styles.subtitle}>勉強時間をフォロワーがチェックし、勉強をサボれなくするアプリ</Text>
      <View style={styles.buttonArea}>
        <PrimaryButton title="はじめる" disabled={!ready || checkingReplacement} onPress={handleStart} testID="onboarding-start-button" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.primary,
  },
  subtitle: {
    marginTop: 12,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  buttonArea: {
    marginTop: 32,
    width: '100%',
  },
});
