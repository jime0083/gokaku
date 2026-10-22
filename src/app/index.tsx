import { useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentUid } from '@/config/firebase';
import { useAccountActions } from '@/features/account/AccountActionBoundary';
import { useSubscriptionAccess } from '@/features/billing/SubscriptionBoundary';
import { loadRelinkIntent } from '@/features/xLink/relinkIntentStorage';
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
  const { reportLaunchInspection } = useSubscriptionAccess();
  const uid = getCurrentUid();
  const identity = useRef({ accountActions, uid });
  useLayoutEffect(() => {
    identity.current = { accountActions, uid };
  });
  const [checkedAccountActions, setCheckedAccountActions] = useState<{
    owner: typeof accountActions;
    uid: string | null;
  } | null>(null);
  const checkingReplacement = !ready ||
    checkedAccountActions?.owner !== accountActions || checkedAccountActions?.uid !== uid;
  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    let generation = 0;
    let working = false;
    let completed = false;
    const valid = () => mounted && isReady() && getCurrentUid() === uid &&
      identity.current.accountActions === accountActions && identity.current.uid === uid;
    const resume = async () => {
      if (!valid() || working || completed) return;
      working = true;
      const token = ++generation;
      reportLaunchInspection(uid, accountActions, { phase: 'checking', retry });
      try {
        const record = uid ? await loadGoalReplacement(uid) : null;
        if (!valid() || generation !== token) return;
        const relinkIntent = !record && uid ? await loadRelinkIntent(uid) : false;
        if (!valid() || generation !== token) return;
        const route = record
          ? record.committedGoalId ? '/onboarding/pace' : resolveOnboardingResumeRoute(record.draft, Date.now())
          : relinkIntent ? '/x-link?mode=relink' : undefined;
        completed = true;
        reportLaunchInspection(uid, accountActions, Boolean(record || relinkIntent), route);
        setCheckedAccountActions({ owner: accountActions, uid });
      } catch {
        if (valid() && generation === token) {
          reportLaunchInspection(uid, accountActions, { phase: 'error', retry });
        }
      } finally {
        if (generation === token) working = false;
      }
    };
    function retry() { void resume(); }
    retry();
    return () => { mounted = false; ++generation; };
  }, [accountActions, isReady, ready, reportLaunchInspection, uid]);

  const handleStart = async () => {
    if (!isReady() || checkingReplacement || getCurrentUid() !== uid) return;
    const draft = await loadOnboardingDraft();
    if (!isReady() || getCurrentUid() !== uid) return;
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
