import { splitHoursMinutes } from '@shared/index';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProgressBar } from '@/components/ProgressBar';
import {
  fetchActiveGoalDailyTargets,
  type ActiveGoalDailyTargets,
} from '@/features/goals/activeGoalRepository';
import { formatElapsedClock, formatJstHourMinute } from '@/features/timer/format';
import { calcProgressRatio } from '@/features/timer/progress';
import { useStudyCheckNotificationNotice } from '@/features/timer/studyCheckNotifications';
import { useTimerSessionContext } from '@/features/timer/TimerSessionContext';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 分 → 「○時間○分」(requirements 4-6) */
function formatHoursMinutesDisplay(totalMinutes: number): string {
  const { hours, minutes } = splitHoursMinutes(totalMinutes);
  return `${hours}時間${minutes}分`;
}

/**
 * タイマー画面(requirements 3-2, 4-6)。
 * 中央に経過時間(計測中セッションの「今 − 開始時刻」)、丸い開始/停止ボタン、
 * 計測中は「勉強中」、下に今日の勉強時間と最低/努力目標への進み具合のバー。
 * 記録は端末内のみ(サーバー保存は 5-1b)。有効な目標の読み込みは activeGoalRepository(画面から切り離した層)を使う
 */
export default function TimerScreen() {
  const insets = useSafeAreaInsets();
  const {
    isLoading,
    isRunning,
    elapsedMs,
    todayMinutes,
    start,
    stop,
    autoStopNotice,
    dismissAutoStopNotice,
  } = useTimerSessionContext();
  const [goalTargets, setGoalTargets] = useState<ActiveGoalDailyTargets | null | undefined>(undefined);
  const showNotificationPermissionNotice = useStudyCheckNotificationNotice();

  useEffect(() => {
    let mounted = true;
    fetchActiveGoalDailyTargets().then((result) => {
      if (mounted) {
        setGoalTargets(result);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const toggle = () => {
    if (isRunning) {
      void stop();
    } else {
      void start();
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {showNotificationPermissionNotice ? (
        <Text testID="timer-notification-permission-notice" style={styles.permissionNoticeText}>
          通知がオフのため、アプリを閉じていると計測開始から60分で計測が止まります。設定アプリで通知を許可してください
        </Text>
      ) : null}
      {autoStopNotice ? (
        <View testID="timer-auto-stop-notice" style={styles.notice}>
          <Text testID="timer-auto-stop-notice-text" style={styles.noticeText}>
            {`「勉強中？」に応答がなかったため、${formatJstHourMinute(autoStopNotice.stoppedAt)}で計測を停止しました`}
          </Text>
          <Pressable
            accessibilityRole="button"
            testID="timer-auto-stop-notice-close-button"
            onPress={() => void dismissAutoStopNotice()}
          >
            <Text style={styles.noticeCloseText}>閉じる</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.centerArea}>
        <Text testID="timer-elapsed-text" style={styles.elapsed}>
          {formatElapsedClock(elapsedMs)}
        </Text>
        {isRunning ? (
          <Text testID="timer-status-text" style={styles.status}>
            勉強中
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          testID="timer-toggle-button"
          onPress={toggle}
          disabled={isLoading}
          style={[styles.toggleButton, isRunning ? styles.toggleButtonActive : null]}
        >
          <Text style={styles.toggleButtonText}>{isRunning ? '停止' : '開始'}</Text>
        </Pressable>
      </View>

      <View style={styles.summary}>
        <Text testID="timer-today-total-text" style={styles.todayTotal}>
          {`今日の勉強時間 ${formatHoursMinutesDisplay(todayMinutes)}`}
        </Text>

        {goalTargets === undefined ? null : goalTargets === null ? (
          <Text testID="timer-goal-not-set-text" style={styles.goalNotSet}>
            目標未設定
          </Text>
        ) : (
          <>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>最低勉強時間</Text>
              <ProgressBar
                testID="timer-min-progress-bar"
                ratio={calcProgressRatio(todayMinutes, goalTargets.minDailyMinutes)}
              />
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>努力目標勉強時間</Text>
              <ProgressBar
                testID="timer-goal-progress-bar"
                ratio={calcProgressRatio(todayMinutes, goalTargets.goalDailyMinutes)}
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const TOGGLE_BUTTON_SIZE = 120;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    justifyContent: 'space-between',
  },
  permissionNoticeText: {
    marginTop: spacing.md,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  notice: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  noticeText: {
    flex: 1,
    marginRight: spacing.md,
    fontSize: typography.caption.fontSize,
    color: colors.text,
  },
  noticeCloseText: {
    fontSize: typography.caption.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  elapsed: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.text,
  },
  status: {
    marginTop: spacing.sm,
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  toggleButton: {
    marginTop: spacing.xl,
    width: TOGGLE_BUTTON_SIZE,
    height: TOGGLE_BUTTON_SIZE,
    borderRadius: TOGGLE_BUTTON_SIZE / 2,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleButtonActive: {
    backgroundColor: colors.error,
  },
  toggleButtonText: {
    fontSize: typography.heading.fontSize,
    fontWeight: 'bold',
    color: colors.onPrimary,
  },
  summary: {
    paddingBottom: spacing.xl,
  },
  todayTotal: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
  goalNotSet: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  progressRow: {
    marginTop: spacing.md,
  },
  progressLabel: {
    marginBottom: spacing.xs,
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
});
