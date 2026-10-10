import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { useTimerSessionContext } from './TimerSessionContext';

/**
 * 「勉強中？」のアプリ内確認(requirements 3-2, 2026-10-10 追記)。
 * どのタブ(ホーム・タイマー)を表示していても画面の上に重ねて出す
 * (src/app/(tabs)/_layout.tsx で Tabs と並べて配置する)。
 *
 * RN の Modal は使わない(CLAUDE.md の決まり)。文言「勉強中？」とボタン「勉強中」の1つだけで、
 * 止めたいときは各画面の既存の停止ボタンを使うため、カード以外の部分は pointerEvents="box-none" にして
 * タッチを下の画面(タイマー画面の停止ボタンなど)に通す
 *
 * カードは画面上の安全域(useSafeAreaInsets の insets.top)の下に出す(P-030。2026-10-10)。
 * 固定の paddingTop だけでは Dynamic Island がある端末(iPhone 16 Pro Max 等)で安全域が
 * paddingTop より大きく、カードの上部が Dynamic Island と重なるため
 */
export function StudyCheckOverlay() {
  const insets = useSafeAreaInsets();
  const { pendingCheck, confirm } = useTimerSessionContext();

  if (!pendingCheck) {
    return null;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.md }]} pointerEvents="box-none">
      <View testID="study-check-overlay" style={styles.card}>
        <Text testID="study-check-text" style={styles.text}>
          勉強中？
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="study-check-confirm-button"
          onPress={() => void confirm()}
          style={styles.button}
        >
          <Text style={styles.buttonText}>勉強中</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  text: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.text,
    marginRight: spacing.md,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  buttonText: {
    fontSize: typography.label.fontSize,
    fontWeight: 'bold',
    color: colors.onPrimary,
  },
});
