import { addDays, diffDays, toJstDateKey, type DateKey } from '@shared/index';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { StepScreen } from '@/components/StepScreen';
import { TextField } from '@/components/TextField';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { validateExamDate, validateTargetHours } from '@/features/onboarding/validation';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** 試験日(YYYY-MM-DD)は日本時間の日付キーだが、iOS標準カレンダー(ローカルのY/M/D)との
 * やり取りはカレンダーの表示欄(年月日)をそのまま使う(端末のタイムゾーンに関係なく選んだ日をそのまま保存する) */
function dateKeyToLocalDate(key: DateKey): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function localDateToDateKey(date: Date): DateKey {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** 試験日の大きな表示用(例: 「試験日: 2027年2月25日(あと140日)」。requirements 4-1 2026-10-07 決定) */
function formatExamDateDisplay(examDate: DateKey, todayKey: DateKey): string {
  const [year, month, day] = examDate.split('-').map(Number);
  const daysUntil = diffDays(todayKey, examDate);
  return `試験日: ${year}年${month}月${day}日(あと${daysUntil}日)`;
}

/**
 * オンボーディング 5歩目(受験ルート): 目標勉強時間と試験日の入力(requirements 4-2)。
 * 3-4b-3 デザイン適用: StepScreen・TextField に置き換え(動きは変えない)。
 * 試験日のエラーは ErrorText 側に表示し、StepScreen の error には渡さない
 * (同じ testID の重複を避ける。3-4b-1・3-4b-2 と同じ考え方)
 */
export default function TargetScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();
  const [calendarOpen, setCalendarOpen] = useState(false);

  const [now] = useState(() => Date.now());
  const [todayKey] = useState(() => toJstDateKey(now));
  const [minimumDate] = useState(() => dateKeyToLocalDate(addDays(todayKey, 1)));

  const targetHoursError = validateTargetHours(draft.targetHoursText);
  const visibleTargetHoursError = draft.targetHoursText.length > 0 ? targetHoursError : null;

  const examDateError = validateExamDate(draft.examDate, now);
  const visibleExamDateError = calendarOpen || draft.examDate !== null ? examDateError : null;

  const canProceed = targetHoursError === null && examDateError === null;

  const handleNext = () => {
    if (!canProceed) return;
    router.push('/onboarding/daily-time');
  };

  const handleDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (selectedDate) {
      updateDraft({ examDate: localDateToDateKey(selectedDate) });
    }
  };

  // カレンダーを開く時点で、表示上すでにハイライトされる日付(最小の選択可能日)を実際の値として確定する。
  // ネイティブのカレンダー(UICalendarView)は、表示中の value と同じ日をタップしても onChange が
  // 発火しない(選択状態が変わらないため)。value を渡しただけ(未確定)のままにすると、
  // 最小の選択可能日(多くの場合ちょうど選びたい「明日」)をタップしても何も起きず、次へ進めなくなる。
  // そのため、カレンダーを開く操作自体を「表示されている日付を選ぶ」ことの確定として扱う
  const handleOpenCalendar = () => {
    // 目標勉強時間の数字キーボード(number-pad)には閉じる専用キーがなく、開いたままだと
    // カレンダーや「次へ」ボタンと表示が重なってしまう(特に画面の小さい端末)。
    // カレンダーを開く前にキーボードを閉じる
    Keyboard.dismiss();
    if (draft.examDate === null) {
      updateDraft({ examDate: localDateToDateKey(minimumDate) });
    }
    setCalendarOpen(true);
  };

  return (
    <StepScreen
      title="目標勉強時間と試験日を入力してください"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/target', draft))}
      onNext={handleNext}
      nextDisabled={!canProceed}
      backTestID="target-back-button"
      nextTestID="target-next-button"
    >
      <TextField
        label="目標勉強時間(時間)"
        value={draft.targetHoursText}
        onChangeText={(text) => updateDraft({ targetHoursText: text })}
        keyboardType="number-pad"
        placeholder="例: 1000"
        error={visibleTargetHoursError}
        testID="target-hours-input"
        errorTestID="target-hours-error"
      />

      <Text style={styles.label}>試験日</Text>
      <Pressable
        accessibilityRole="button"
        testID="exam-date-select-button"
        onPress={handleOpenCalendar}
        style={styles.dateButton}
      >
        <Text testID="exam-date-display" style={draft.examDate ? styles.examDateText : styles.dateButtonText}>
          {draft.examDate ? formatExamDateDisplay(draft.examDate, todayKey) : '試験日を選択してください'}
        </Text>
      </Pressable>
      <ErrorText message={visibleExamDateError} testID="exam-date-error" />
      {calendarOpen ? (
        <DateTimePicker
          testID="exam-date-picker"
          mode="date"
          display="inline"
          value={draft.examDate ? dateKeyToLocalDate(draft.examDate) : minimumDate}
          minimumDate={minimumDate}
          onChange={handleDateChange}
        />
      ) : null}
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  label: {
    marginTop: spacing.lg,
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  dateButton: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md - 4,
    paddingVertical: spacing.sm + 2,
  },
  dateButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.text,
  },
  examDateText: {
    fontSize: typography.heading.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
});
