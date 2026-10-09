import { Picker } from '@react-native-picker/picker';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/Card';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StepScreen } from '@/components/StepScreen';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { validateDailyMinutes, validateGoalNotLessThanMin } from '@/features/onboarding/validation';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 時間の選択肢(0〜16) */
const HOUR_OPTIONS = Array.from({ length: 17 }, (_, i) => i);

/** 分の選択肢。hour=16 のときは 0 のみ、hour=0 のときは 0(=0時間0分)を除く(mokuhyo.txt 1) */
function minuteOptionsForHour(hour: number): number[] {
  if (hour === 16) return [0];
  if (hour === 0) return [10, 20, 30, 40, 50];
  return [0, 10, 20, 30, 40, 50];
}

/** 行を開いた時点でまだ値が確定していない場合の、ドラムロールの初期表示(最小の有効値 = 0時間10分) */
const DEFAULT_DISPLAY = { hour: 0, minute: 10 };

function splitMinutes(totalMinutes: number | null): { hour: number; minute: number } {
  if (totalMinutes === null) return DEFAULT_DISPLAY;
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

/** 新しい hour に対して minute が選べない組み合わせになっていたら、選べる値に合わせる */
function clampMinuteForHour(hour: number, minute: number): number {
  const options = minuteOptionsForHour(hour);
  return options.includes(minute) ? minute : options[0];
}

function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}時間${minutes}分`;
}

type FieldKey = 'min' | 'goal';

type DailyTimeRowProps = {
  label: string;
  totalMinutes: number | null;
  onPress: () => void;
  rowTestID: string;
  valueTestID: string;
};

function DailyTimeRow({ label, totalMinutes, onPress, rowTestID, valueTestID }: DailyTimeRowProps) {
  return (
    <Pressable accessibilityRole="button" testID={rowTestID} onPress={onPress}>
      <Card style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text testID={valueTestID} style={styles.rowValue}>
          {totalMinutes === null ? '未設定' : formatMinutes(totalMinutes)}
        </Text>
      </Card>
    </Pressable>
  );
}

/**
 * オンボーディング 6歩目(受験ルート): 1日の最低・努力目標勉強時間の入力(requirements 4-1, 4-2)。
 * 3-4b-3 デザイン適用: StepScreen・Card に置き換え(動きは変えない)。
 * P-014 対応: ドラムロールは常時表示せず、行をタップしたときだけ画面下から表示する(「完了」で確定)。
 * RN の Modal は使わず、StepScreen と同じ画面内の View を重ねて表示する(CLAUDE.md の決まり)。
 * 「次へ」でペース確認画面(3-3)へ進む
 */
export default function DailyTimeScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [pendingHour, setPendingHour] = useState(DEFAULT_DISPLAY.hour);
  const [pendingMinute, setPendingMinute] = useState(DEFAULT_DISPLAY.minute);

  const minError = validateDailyMinutes(draft.minDailyMinutes, '1日の最低勉強時間');
  const goalError = validateDailyMinutes(draft.goalDailyMinutes, '1日の努力目標勉強時間');
  const goalVsMinError = validateGoalNotLessThanMin(draft.minDailyMinutes, draft.goalDailyMinutes);

  // 未操作(null)はエラー文言を出さずに「次へ」だけ押せなくする(他の画面と同じ考え方)
  const visibleMinError = draft.minDailyMinutes !== null ? minError : null;
  const visibleGoalError = draft.goalDailyMinutes !== null ? goalError : null;

  const canProceed = minError === null && goalError === null && goalVsMinError === null;

  const openEditor = (field: FieldKey) => {
    const current = field === 'min' ? draft.minDailyMinutes : draft.goalDailyMinutes;
    const { hour, minute } = splitMinutes(current);
    setPendingHour(hour);
    setPendingMinute(minute);
    setEditing(field);
  };

  const handlePendingHourChange = (nextHour: number) => {
    setPendingHour(nextHour);
    setPendingMinute((prevMinute) => clampMinuteForHour(nextHour, prevMinute));
  };

  const handleDone = () => {
    if (editing === null) return;
    const totalMinutes = pendingHour * 60 + pendingMinute;
    if (editing === 'min') {
      updateDraft({ minDailyMinutes: totalMinutes });
    } else {
      updateDraft({ goalDailyMinutes: totalMinutes });
    }
    setEditing(null);
  };

  const minuteOptions = minuteOptionsForHour(pendingHour);
  const hourPickerTestID = editing === 'min' ? 'min-hour-picker' : 'goal-hour-picker';
  const minutePickerTestID = editing === 'min' ? 'min-minute-picker' : 'goal-minute-picker';

  return (
    <View style={styles.root}>
      <StepScreen
        title="1日の最低・努力目標勉強時間を入力してください"
        onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/daily-time', draft))}
        onNext={() => router.push('/onboarding/pace')}
        nextDisabled={!canProceed}
        backTestID="daily-time-back-button"
        nextTestID="daily-time-next-button"
      >
        <DailyTimeRow
          label="1日の最低勉強時間"
          totalMinutes={draft.minDailyMinutes}
          onPress={() => openEditor('min')}
          rowTestID="min-daily-time-row"
          valueTestID="min-daily-time-value"
        />
        <ErrorText message={visibleMinError} testID="min-daily-minutes-error" />

        <DailyTimeRow
          label="1日の努力目標勉強時間"
          totalMinutes={draft.goalDailyMinutes}
          onPress={() => openEditor('goal')}
          rowTestID="goal-daily-time-row"
          valueTestID="goal-daily-time-value"
        />
        <ErrorText message={visibleGoalError} testID="goal-daily-minutes-error" />
        <ErrorText message={goalVsMinError} testID="goal-vs-min-error" />
      </StepScreen>

      {editing !== null ? (
        // RN の Modal コンポーネントは iOS では別のネイティブウィンドウに描画され、
        // Maestro のアクセシビリティ階層の取得対象に含まれない(画面には映るが要素として見つからない)ため、
        // 同じ画面の中に重ねて表示する View で代用する(requirements 4-1, problem P-014)
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              {editing === 'min' ? '1日の最低勉強時間' : '1日の努力目標勉強時間'}
            </Text>
            <View style={styles.pickerRow}>
              <Picker
                testID={hourPickerTestID}
                style={styles.picker}
                selectedValue={pendingHour}
                onValueChange={(value) => handlePendingHourChange(Number(value))}
              >
                {HOUR_OPTIONS.map((value) => (
                  <Picker.Item key={value} label={`${value}時間`} value={value} />
                ))}
              </Picker>
              <Picker
                testID={minutePickerTestID}
                style={styles.picker}
                selectedValue={pendingMinute}
                onValueChange={(value) => setPendingMinute(Number(value))}
              >
                {minuteOptions.map((value) => (
                  <Picker.Item key={value} label={`${value}分`} value={value} />
                ))}
              </Picker>
            </View>
            <View style={styles.sheetButtonArea}>
              <PrimaryButton title="完了" onPress={handleDone} testID="daily-time-sheet-done-button" />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  row: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    fontSize: typography.label.fontSize + 1,
    color: colors.text,
  },
  rowValue: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  sheetTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.text,
    textAlign: 'center',
  },
  pickerRow: {
    flexDirection: 'row',
  },
  picker: {
    flex: 1,
  },
  sheetButtonArea: {
    marginTop: spacing.md,
  },
});
