import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { addDays, diffDays, SUBJECT_COUNT_RANGE, toJstDateKey, type DateKey } from '@shared/index';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { TextField } from '@/components/TextField';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';

import { buildGoalEditPatch, createGoalEditDraft, validateGoalEditDraft, type GoalEditDraft, type GoalEditPatch } from './editGoal';
import { updateGoalNumbers } from './editGoalRepository';
import type { GoalDocument } from './types';

function localDate(key: DateKey): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}
function dateKey(date: Date): DateKey {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function minutesText(minutes: number): string {
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
function minuteOptions(hour: number): number[] {
  return hour === 16 ? [0] : hour === 0 ? [10, 20, 30, 40, 50] : [0, 10, 20, 30, 40, 50];
}

/** Existing numeric keyboard/calendar/drum controls, in the home View hierarchy. */
export function GoalEditPopup({ goal, goalId, onCancel, onSaved }: {
  goal: GoalDocument; goalId: string; onCancel: () => void; onSaved: (patch: GoalEditPatch) => void;
}) {
  const [draft, setDraft] = useState(() => createGoalEditDraft(goal));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [editingTime, setEditingTime] = useState<'minDailyMinutes' | 'goalDailyMinutes' | null>(null);
  const [hour, setHour] = useState(0);
  const [minute, setMinute] = useState(10);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [communicationError, setCommunicationError] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationNow, setValidationNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => {
      const next = Date.now();
      setValidationNow((current) => toJstDateKey(current) === toJstDateKey(next) ? current : next);
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  const today = toJstDateKey(validationNow);
  const tomorrow = addDays(today, 1);
  const errors = validateGoalEditDraft(goal.type, draft, validationNow);
  const canSave = Object.values(errors).every((error) => error === null) && editingTime === null;
  const change = (patch: Partial<GoalEditDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  };
  const openTime = (field: 'minDailyMinutes' | 'goalDailyMinutes') => {
    Keyboard.dismiss();
    setCalendarOpen(false);
    setHour(Math.floor(draft[field] / 60));
    setMinute(draft[field] % 60);
    setEditingTime(field);
  };
  const save = async () => {
    if (savingRef.current || !canSave) return;
    const now = Date.now();
    let patch: GoalEditPatch;
    try {
      // Recheck with the current JST day even if midnight passed without a render.
      patch = buildGoalEditPatch(goal.type, draft, now);
    } catch (error) {
      setValidationNow(now);
      setValidationError(error instanceof Error ? error.message : '入力を確認してください');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setCommunicationError(false);
    try {
      await updateGoalNumbers(goalId, goal.type, draft, now);
    } catch {
      setCommunicationError(true);
      return;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    onSaved(patch);
  };
  const [year, month, day] = draft.examDate.split('-').map(Number);

  return (
    <KeyboardAvoidingView testID="goal-edit-popup" style={styles.backdrop} behavior="padding">
      <View style={styles.popup} accessibilityViewIsModal>
        <Text style={styles.title}>目標の数値を変更</Text>
        <ScrollView testID="goal-edit-scroll" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View pointerEvents={saving || editingTime !== null ? 'none' : 'auto'}>
            <TextField label="目標勉強時間(時間)" value={draft.targetHoursText}
              onChangeText={(targetHoursText) => change({ targetHoursText })} keyboardType="number-pad"
              error={errors.targetHours} testID="edit-target-hours-input" />
            <Pressable accessibilityRole="button" testID="edit-exam-date-open" style={styles.row} onPress={() => {
              Keyboard.dismiss();
              if (draft.examDate < tomorrow) change({ examDate: tomorrow });
              setCalendarOpen((open) => !open);
            }}>
              <Text testID="edit-exam-date-value" style={styles.dateText}>{`試験日: ${year}年${month}月${day}日(あと${diffDays(today, draft.examDate)}日)`}</Text>
            </Pressable>
            <ErrorText message={errors.examDate} />
            {calendarOpen ? <DateTimePicker testID="edit-exam-date-picker" mode="date" display="inline"
              value={localDate(draft.examDate)} minimumDate={localDate(tomorrow)}
              onChange={(_event, selectedDate) => { if (selectedDate) change({ examDate: dateKey(selectedDate) }); }} /> : null}
            {goal.type === 'exam' ? <>
              <TextField label="目標偏差値" value={draft.targetDeviationText} keyboardType="decimal-pad"
                onChangeText={(targetDeviationText) => change({ targetDeviationText })}
                error={errors.targetDeviation} testID="edit-target-deviation-input" />
              <TextField label="現在の偏差値" value={draft.currentDeviationText} keyboardType="decimal-pad"
                onChangeText={(currentDeviationText) => change({ currentDeviationText })}
                error={errors.currentDeviation} testID="edit-current-deviation-input" />
              <Text style={styles.label}>受験科目数</Text>
              <View style={styles.counter}>
                <PrimaryButton title="−" variant="secondary" testID="edit-subject-decrement"
                  disabled={draft.subjectCount <= SUBJECT_COUNT_RANGE.min}
                  onPress={() => change({ subjectCount: Math.max(SUBJECT_COUNT_RANGE.min, draft.subjectCount - 1) })} />
                <Text testID="edit-subject-value" style={styles.count}>{draft.subjectCount}</Text>
                <PrimaryButton title="＋" variant="secondary" testID="edit-subject-increment"
                  disabled={draft.subjectCount >= SUBJECT_COUNT_RANGE.max}
                  onPress={() => change({ subjectCount: Math.min(SUBJECT_COUNT_RANGE.max, draft.subjectCount + 1) })} />
              </View>
              <ErrorText message={errors.subjectCount} />
            </> : null}
            <Pressable accessibilityRole="button" style={styles.row} testID="edit-min-row" onPress={() => openTime('minDailyMinutes')}>
              <Text style={styles.label}>1日の最低勉強時間</Text><Text testID="edit-min-value" style={styles.value}>{minutesText(draft.minDailyMinutes)}</Text>
            </Pressable>
            <ErrorText message={errors.minDailyMinutes} />
            <Pressable accessibilityRole="button" style={styles.row} testID="edit-goal-row" onPress={() => openTime('goalDailyMinutes')}>
              <Text style={styles.label}>1日の努力目標勉強時間</Text><Text testID="edit-goal-value" style={styles.value}>{minutesText(draft.goalDailyMinutes)}</Text>
            </Pressable>
            <ErrorText message={errors.goalDailyMinutes || errors.dailyOrder} />
          </View>
          <ErrorText message={validationError} />
          {communicationError ? <>
            <ErrorText testID="edit-communication-error" message="通信できませんでした。電波の良い場所で再度お試しください" />
            <PrimaryButton title="再試行" testID="edit-retry" disabled={!canSave || saving} onPress={() => void save()} />
          </> : null}
          <View style={styles.actions}>
            <PrimaryButton title={saving ? '保存中…' : '保存'} testID="edit-save" disabled={!canSave || saving} onPress={() => void save()} />
            <PrimaryButton title="キャンセル" variant="secondary" testID="edit-cancel" disabled={saving} onPress={onCancel} />
          </View>
        </ScrollView>
        {editingTime !== null ? <View style={styles.timeBackdrop}>
          <View style={styles.timeSheet}>
            <Text style={styles.title}>{editingTime === 'minDailyMinutes' ? '1日の最低勉強時間' : '1日の努力目標勉強時間'}</Text>
            <View style={styles.pickers}>
              <Picker testID="edit-hour-picker" style={styles.picker} selectedValue={hour} onValueChange={(value) => {
                const nextHour = Number(value);
                setHour(nextHour);
                setMinute((current) => minuteOptions(nextHour).includes(current) ? current : minuteOptions(nextHour)[0]);
              }}>
                {Array.from({ length: 17 }, (_, value) => <Picker.Item key={value} label={`${value}時間`} value={value} />)}
              </Picker>
              <Picker testID="edit-minute-picker" style={styles.picker} selectedValue={minute} onValueChange={(value) => setMinute(Number(value))}>
                {minuteOptions(hour).map((value) => <Picker.Item key={value} label={`${value}分`} value={value} />)}
              </Picker>
            </View>
            <PrimaryButton title="完了" testID="edit-time-done" onPress={() => {
              change({ [editingTime]: hour * 60 + minute });
              setEditingTime(null);
            }} />
          </View>
        </View> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', padding: spacing.md },
  popup: { maxHeight: '95%', flexShrink: 1, backgroundColor: colors.background, borderRadius: radius.lg, overflow: 'hidden' },
  title: { color: colors.text, fontSize: 18, fontWeight: 'bold', padding: spacing.md, textAlign: 'center' },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  label: { color: colors.textSecondary, fontSize: 14, marginTop: spacing.sm },
  value: { color: colors.primary, fontSize: 18, fontWeight: 'bold' },
  dateText: { color: colors.primary, fontSize: 20, fontWeight: 'bold' },
  row: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, marginTop: spacing.lg },
  counter: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  count: { width: 50, textAlign: 'center', color: colors.text, fontSize: 18 },
  actions: { marginTop: spacing.lg, gap: spacing.md },
  timeBackdrop: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)' },
  timeSheet: { backgroundColor: colors.background, padding: spacing.md },
  pickers: { flexDirection: 'row' },
  picker: { flex: 1 },
});
