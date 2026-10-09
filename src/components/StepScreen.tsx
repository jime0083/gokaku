import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

function noop(): void {}

type StepScreenProps = {
  title: string;
  onBack: () => void;
  onNext?: () => void;
  /** 「次へ」ボタンを表示するか(既定は表示する。3-2a: 一覧の選択だけで進む画面等では false にする) */
  showNext?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
  error?: string | null;
  children: ReactNode;
  backTestID?: string;
  nextTestID?: string;
  titleTestID?: string;
  errorTestID?: string;
};

/**
 * オンボーディング共通の「ステップ画面の型」(3-4a デザインの土台)。
 * 上から: 戻る(固定)→ 見出し・本文(ScrollView でスクロール)→ 下部にエラー表示と「次へ」(固定)。
 * iPhone SE でキーボードが出た場合も KeyboardAvoidingView で「次へ」を押せる位置に保つ。
 * RN の Modal は使わない(CLAUDE.md の決まり)
 */
export function StepScreen({
  title,
  onBack,
  onNext,
  showNext = true,
  nextDisabled = false,
  nextLabel = '次へ',
  error = null,
  children,
  backTestID,
  nextTestID,
  titleTestID,
  errorTestID,
}: StepScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <BackButton onPress={onBack} testID={backTestID} />
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text testID={titleTestID} style={styles.title}>
            {title}
          </Text>
          <View style={styles.body}>{children}</View>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <ErrorText message={error} testID={errorTestID} />
          {showNext ? (
            <View style={styles.buttonArea}>
              <PrimaryButton
                title={nextLabel}
                onPress={onNext ?? noop}
                disabled={nextDisabled}
                testID={nextTestID}
              />
            </View>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  scrollContent: {
    flexGrow: 1,
  },
  title: {
    marginTop: spacing.lg,
    fontSize: typography.heading.fontSize,
    fontWeight: typography.heading.fontWeight,
    color: colors.text,
  },
  body: {
    marginTop: spacing.xs,
  },
  footer: {
    paddingTop: spacing.sm,
  },
  buttonArea: {
    marginTop: spacing.sm,
  },
});
