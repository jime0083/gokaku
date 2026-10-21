import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card } from '@/components/Card';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { openXAuthorization } from '@/features/xLink/openXAuthorization';
import { xLinkApi, type XLinkPending } from '@/features/xLink/xLinkApi';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

const COMMUNICATION_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';
const POST_PERMISSION = '最低勉強時間に届かなかった日に、翌0:00にXへ自動投稿します。許可しますか？';

type Action =
  | { kind: 'pending' }
  | { kind: 'begin'; differentAccount: boolean }
  | { kind: 'discard'; candidateId: string }
  | { kind: 'confirm'; candidateId: string; postEnabled: boolean };

export default function XLinkScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<XLinkPending | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [failedAction, setFailedAction] = useState<Action | null>(null);
  const busyRef = useRef(true);
  const mounted = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    let active = true;
    xLinkApi.getPending()
      .then(({ pending: candidate }) => {
        if (!active) return;
        setPending(candidate);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setFailedAction({ kind: 'pending' });
      })
      .finally(() => {
        if (!active) return;
        busyRef.current = false;
        setBusy(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  async function run(action: Action) {
    if (!mounted.current || busyRef.current) return;
    const currentGeneration = generation.current;
    const active = () => mounted.current && generation.current === currentGeneration;
    busyRef.current = true;
    setBusy(true);
    setFailedAction(null);
    let retryAction = action;
    let navigated = false;
    try {
      if (action.kind === 'begin' || action.kind === 'discard') {
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
        router.replace('/(tabs)/home');
        navigated = true;
      }
    } catch {
      if (active()) setFailedAction(retryAction);
    } finally {
      if (active() && !navigated) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

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
        disabled={disabled} onPress={() => void run({ kind: 'begin', differentAccount: false })} /> : null}
      {!dialog ? feedback : null}
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
