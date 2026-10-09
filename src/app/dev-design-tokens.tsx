import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StepScreen } from '@/components/StepScreen';
import { TextField } from '@/components/TextField';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';

const SAMPLE_TEXT_MAX_LENGTH = 10;

/**
 * 3-4a デザインの土台: 共通部品(ボタン・入力欄・カード・エラー文言)と
 * ステップ画面の型(StepScreen)の見本画面。
 * タブ・ナビゲーションには含めない。本番ビルド(Emulator に接続しない)では空の画面にする
 * (dev-maestro-text-probe・dev-lockscreen-spike と同じパターン)
 */
export default function DevDesignTokensScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [sampleText, setSampleText] = useState('');
  const [backCount, setBackCount] = useState(0);
  const [nextCount, setNextCount] = useState(0);
  const [secondaryCount, setSecondaryCount] = useState(0);

  if (!emulatorConfig) {
    return <View style={styles.container} />;
  }

  const error =
    sampleText.length > SAMPLE_TEXT_MAX_LENGTH
      ? `${SAMPLE_TEXT_MAX_LENGTH}文字以内で入力してください`
      : null;

  return (
    <StepScreen
      title="デザイン見本"
      onBack={() => setBackCount((count) => count + 1)}
      onNext={() => setNextCount((count) => count + 1)}
      nextDisabled={error !== null}
      error={error}
      backTestID="sample-back-button"
      nextTestID="sample-next-button"
      titleTestID="sample-title"
      errorTestID="sample-error"
    >
      <Text testID="sample-back-count" style={styles.counter}>
        {`戻るを押した回数: ${backCount}`}
      </Text>
      <Text testID="sample-next-count" style={styles.counter}>
        {`次へを押した回数: ${nextCount}`}
      </Text>

      <TextField
        label={`サンプル入力(${SAMPLE_TEXT_MAX_LENGTH}文字以内)`}
        value={sampleText}
        onChangeText={setSampleText}
        error={error}
        placeholder="例: 合格ウォッチ"
        testID="sample-textfield"
        labelTestID="sample-textfield-label"
        errorTestID="sample-textfield-error"
      />

      <View style={styles.buttonRow}>
        <PrimaryButton
          title="サブ操作"
          variant="secondary"
          onPress={() => setSecondaryCount((count) => count + 1)}
          testID="sample-secondary-button"
        />
      </View>
      <Text testID="sample-secondary-count" style={styles.counter}>
        {`サブ操作を押した回数: ${secondaryCount}`}
      </Text>
      <View style={styles.buttonRow}>
        <PrimaryButton
          title="サブ操作(無効)"
          variant="secondary"
          disabled
          onPress={() => {}}
          testID="sample-secondary-disabled-button"
        />
      </View>
      <View style={styles.buttonRow}>
        <PrimaryButton title="主操作(無効)" disabled onPress={() => {}} testID="sample-primary-disabled-button" />
      </View>

      <Card testID="sample-card" style={styles.card}>
        <Text style={styles.cardTitle}>カードの見本</Text>
        <Text style={styles.cardBody}>
          薄いグレーの背景と境界線で、白背景の画面から内容を区切って見せる部品です。
        </Text>
      </Card>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  counter: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  buttonRow: {
    marginTop: spacing.lg,
  },
  card: {
    marginTop: spacing.lg,
  },
  cardTitle: {
    fontSize: typography.label.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
  cardBody: {
    marginTop: spacing.xs,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
});
