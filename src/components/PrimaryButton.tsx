import { Pressable, Text, StyleSheet } from 'react-native';

import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 主(primary)・副(secondary)の2種類(3-4a デザインの土台)。既定は primary(3-1 の既存画面と同じ見た目) */
export type ButtonVariant = 'primary' | 'secondary';

type PrimaryButtonProps = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  testID?: string;
};

/**
 * 共通の主要アクションボタン(3-4a デザインの土台)。
 * 既存の呼び出し(title/onPress/disabled/testID のみ)は variant 省略時に primary 相当の見た目になり、
 * 3-1 の画面の動きを変えない
 */
export function PrimaryButton({
  title,
  onPress,
  disabled = false,
  variant = 'primary',
  testID,
}: PrimaryButtonProps) {
  const isSecondary = variant === 'secondary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.button,
        isSecondary ? styles.secondary : styles.primary,
        disabled ? (isSecondary ? styles.secondaryDisabled : styles.primaryDisabled) : null,
      ]}
    >
      <Text
        style={[
          styles.text,
          isSecondary ? styles.secondaryText : styles.primaryText,
          disabled && isSecondary ? styles.secondaryTextDisabled : null,
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.sm,
    paddingVertical: spacing.md - 2,
    alignItems: 'center',
  },
  primary: {
    backgroundColor: colors.primary,
  },
  primaryDisabled: {
    backgroundColor: colors.primaryDisabled,
  },
  secondary: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  secondaryDisabled: {
    borderColor: colors.border,
  },
  text: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
  },
  primaryText: {
    color: colors.onPrimary,
  },
  secondaryText: {
    color: colors.primary,
  },
  secondaryTextDisabled: {
    color: colors.textSecondary,
  },
});
