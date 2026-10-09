import { Text, StyleSheet } from 'react-native';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type ErrorTextProps = {
  message: string | null;
  testID?: string;
};

/** 入力エラーの表示(mokuhyo.txt 1: 該当項目の下に理由を表示する) */
export function ErrorText({ message, testID }: ErrorTextProps) {
  if (!message) return null;
  return (
    <Text testID={testID} style={styles.text}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.error,
    fontSize: typography.caption.fontSize,
    marginTop: spacing.xs,
  },
});
