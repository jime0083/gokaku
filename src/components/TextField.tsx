import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type TextFieldProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  maxLength?: number;
  testID?: string;
  labelTestID?: string;
  errorTestID?: string;
};

/** ラベル・エラー表示付きの共通入力欄(3-4a デザインの土台) */
export function TextField({
  label,
  value,
  onChangeText,
  error = null,
  placeholder,
  keyboardType,
  maxLength,
  testID,
  labelTestID,
  errorTestID,
}: TextFieldProps) {
  return (
    <View style={styles.container}>
      <Text testID={labelTestID} style={styles.label}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        keyboardType={keyboardType}
        maxLength={maxLength}
      />
      <ErrorText message={error} testID={errorTestID} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.lg,
  },
  label: {
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  input: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md - 4,
    paddingVertical: spacing.sm + 2,
    fontSize: typography.body.fontSize,
    color: colors.text,
  },
  inputError: {
    borderColor: colors.error,
  },
});
