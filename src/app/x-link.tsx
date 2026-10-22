import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getCurrentUid } from '@/config/firebase';
import { Card } from '@/components/Card';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { clearRelinkIntent, saveRelinkIntent } from '@/features/xLink/relinkIntentStorage';
import { openXAuthorization } from '@/features/xLink/openXAuthorization';
import { xLinkApi, type XLinkPending } from '@/features/xLink/xLinkApi';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

const COMMUNICATION_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';
const POST_PERMISSION = '最低勉強時間に届かなかった日に、翌0:00にXへ自動投稿します。許可しますか？';

type Action =
  | { kind: 'home' }
  | { kind: 'pending' }
  | { kind: 'begin'; differentAccount: boolean }
  | { kind: 'discard'; candidateId: string }
  | { kind: 'confirm'; candidateId: string; postEnabled: boolean };

export default function XLinkScreen() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const relink = mode === 'relink';
  const [ownerUid] = useState(getCurrentUid);
  const confirming = useRef(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<XLinkPending | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [failedAction, setFailedAction] = useState<Action | null>(null);
  const busyRef = useRef(true);
  const mounted = useRef(false);
  const generation = useRef(0);
  const intentSaved = useRef(false);

  useFocusEffect(useCallback(() => {
    mounted.current = true;
    generation.current += 1;
    const currentGeneration = generation.current;
    let focused = true;
    const active = () => focused && mounted.current &&
      generation.current === currentGeneration && !!ownerUid && getCurrentUid() === ownerUid;
    intentSaved.current = false;
    confirming.current = false;
    setIsConfirming(false);
    busyRef.current = true;
    setBusy(true);
    setLoaded(false);
    setPending(null);
    setDialog(false);
    setFailedAction(null);
    Promise.resolve().then(async () => {
      if (!active() || !ownerUid) return;
      if (relink) {
        await saveRelinkIntent(ownerUid);
        if (!active()) return;
        intentSaved.current = true;
      }
      const { pending: candidate } = await xLinkApi.getPending();
      if (!active()) return;
      setPending(candidate);
      setLoaded(true);
    })
      .catch(() => {
        if (active()) setFailedAction({ kind: 'pending' });
      })
      .finally(() => {
        if (!active()) return;
        busyRef.current = false;
        setBusy(false);
      });
    return () => {
      focused = false;
      mounted.current = false;
      generation.current += 1;
    };
  }, [ownerUid, relink]));

  async function run(action: Action) {
    if (!mounted.current || (busyRef.current && action.kind !== 'home')) return;
    if (action.kind === 'home' && (!relink || confirming.current)) return;
    if (!ownerUid || getCurrentUid() !== ownerUid) {
      setFailedAction({ kind: 'pending' });
      return;
    }
    // Home exit invalidates pending/browser continuations before awaiting storage.
    if (action.kind === 'home') generation.current += 1;
    const currentGeneration = generation.current;
    const active = () => mounted.current && generation.current === currentGeneration &&
      getCurrentUid() === ownerUid;
    busyRef.current = true;
    confirming.current = action.kind === 'confirm' || action.kind === 'home';
    setIsConfirming(action.kind === 'confirm' || action.kind === 'home');
    setBusy(true);
    setFailedAction(null);
    let retryAction = action;
    let navigated = false;
    try {
      if (relink && action.kind !== 'home' && !intentSaved.current) {
        await saveRelinkIntent(ownerUid);
        if (!active()) return;
        intentSaved.current = true;
      }
      if (action.kind === 'home') {
        await clearRelinkIntent(ownerUid);
        if (!active()) return;
        router.replace('/(tabs)/home');
        navigated = true;
      } else if (action.kind === 'begin' || action.kind === 'discard') {
        const differentAccount = action.kind === 'discard' || action.differentAccount;
        if (action.kind === 'discard') {
          await xLinkApi.discard(action.candidateId);
          if (!active()) return;
          setPending(null);
        }
        retryAction = { kind: 'begin', differentAccount };
        const { authorizationUrl } = await xLinkApi.begin();
        if (!active()) return;
        const result = await openXAuthorization(authorizationUrl, { differentAccount });
        if (!active()) return;
        if (result.type === 'cancel') {
          setPending(null);
          setLoaded(true);
          return;
        }
        // Codes are single-use. Recovery after submission reads server state.
        retryAction = { kind: 'pending' };
        await xLinkApi.complete(result.state, result.code);
        if (!active()) return;
        const { pending: candidate } = await xLinkApi.getPending();
        if (!active()) return;
        setPending(candidate);
        setLoaded(true);
      } else if (action.kind === 'pending') {
        const { pending: candidate } = await xLinkApi.getPending();
        if (!active()) return;
        setPending(candidate);
        setLoaded(true);
      } else {
        await xLinkApi.confirm(action.candidateId, action.postEnabled);
        if (!active()) return;
        if (relink) {
          await clearRelinkIntent(ownerUid);
          if (!active()) return;
        }
        router.replace('/(tabs)/home');
        navigated = true;
      }
    } catch {
      if (active()) setFailedAction(retryAction);
    } finally {
      if (active() && !navigated) {
        confirming.current = false;
        setIsConfirming(false);
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const returnHome = () => { void run({ kind: 'home' }); };
  const homeButton = relink ? <PrimaryButton title="ホームへ戻る" variant="secondary"
    testID="x-link-home" disabled={busy && isConfirming} onPress={returnHome} /> : null;
  const disabled = busy || failedAction !== null;
  const feedback = <>
    {busy ? <Text testID="x-link-busy" style={styles.note}>読み込み中...</Text> : null}
    {failedAction ? <>
      <ErrorText testID="x-link-error" message={COMMUNICATION_ERROR} />
      <PrimaryButton title="再試行" testID="x-link-retry" disabled={busy}
        onPress={() => void run(failedAction)} />
    </> : null}
  </>;

  return <View style={styles.screen}>
    <ScrollView testID="x-link-scroll" accessibilityElementsHidden={dialog}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
      ]}>
      <Text style={styles.title}>X連携</Text>
      {pending ? <>
        <Card style={styles.account} testID="x-link-profile">
          {pending.profile.profileImageUrl ? <Image
            testID="x-link-avatar" accessibilityLabel="Xアカウントのアイコン"
            source={{ uri: pending.profile.profileImageUrl }} style={styles.avatar}
          /> : <Ionicons testID="x-link-avatar-fallback" name="person-outline"
            accessibilityLabel="Xアカウントのアイコン"
            size={spacing.xxl} color={colors.primary} />}
          <Text style={styles.username}>@{pending.profile.username}</Text>
        </Card>
        <PrimaryButton title="このアカウントで連携" testID="x-link-use-account"
          disabled={disabled || dialog} onPress={() => {
            if (busyRef.current || failedAction) return;
            setDialog(true);
          }} />
        <PrimaryButton title="別のアカウントにする" variant="secondary"
          testID="x-link-different-account" disabled={disabled || dialog}
          onPress={() => void run({ kind: 'discard', candidateId: pending.candidateId })} />
      </> : loaded ? <PrimaryButton title="Xと連携" testID="x-link-start"
        disabled={disabled} onPress={() => void run({ kind: 'begin', differentAccount: relink })} /> : null}
      {!dialog ? <>{feedback}{homeButton}</> : null}
    </ScrollView>
    {dialog && pending ? <View style={[
      styles.backdrop,
      { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md },
    ]}>
      <ScrollView testID="x-link-permission-scroll" style={styles.dialogScroll}
        contentContainerStyle={styles.dialogContent}>
        <View testID="x-link-permission" accessibilityViewIsModal style={styles.dialog}>
          <Text style={styles.body}>{POST_PERMISSION}</Text>
          <PrimaryButton title="許可する" testID="x-link-allow" disabled={disabled}
            onPress={() => void run({
              kind: 'confirm', candidateId: pending.candidateId, postEnabled: true,
            })} />
          <PrimaryButton title="許可しない" testID="x-link-deny" variant="secondary"
            disabled={disabled} onPress={() => void run({
              kind: 'confirm', candidateId: pending.candidateId, postEnabled: false,
            })} />
          {feedback}
          {homeButton}
        </View>
      </ScrollView>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.display, color: colors.text, marginBottom: spacing.md },
  account: { alignItems: 'center', gap: spacing.md },
  avatar: { width: spacing.xxl * 2, height: spacing.xxl * 2, borderRadius: radius.pill },
  username: { ...typography.heading, color: colors.text, textAlign: 'center' },
  body: { ...typography.body, color: colors.text, lineHeight: spacing.lg },
  note: { ...typography.label, color: colors.textSecondary },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  dialogScroll: { flexGrow: 0, flexShrink: 1 },
  dialogContent: { flexGrow: 1, justifyContent: 'center' },
  dialog: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
    gap: spacing.md,
  },
});
