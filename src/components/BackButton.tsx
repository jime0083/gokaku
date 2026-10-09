import { Pressable, Text, StyleSheet } from 'react-native';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type BackButtonProps = {
  onPress: () => void;
  testID?: string;
};

/** 各ステップの「戻る」(requirements 4-1)。入力中の値は画面側の state ではなく
 * OnboardingDraftContext に保持しているため、戻っても値は保持される */
export function BackButton({ onPress, testID }: BackButtonProps) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID} style={styles.button}>
      <Text style={styles.text}>戻る</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  text: {
    color: colors.primary,
    fontSize: typography.label.fontSize + 1,
  },
});
