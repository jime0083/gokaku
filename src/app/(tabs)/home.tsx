import { calculateHomeSummary, formatWithThousandsSeparator, splitHoursMinutes, toJstDateKey, type HomeSummary } from '@shared/index';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getCurrentUid } from '@/config/firebase';
import { useAccountActions } from '@/features/account/AccountActionBoundary';
import { assertReplacementStopped, beginGoalReplacement, ReplacementMeasuringError, REPLACEMENT_COMMUNICATION_ERROR } from '@/features/goals/goalReplacementFlow';
import { resolveOnboardingResumeRoute } from '@/features/onboarding/navigation';

import { Card } from '@/components/Card';
import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressBar } from '@/components/ProgressBar';
import { fetchHomeData, type HomeData, type HomeNotice } from '@/features/home/homeDataRepository';
import { xNoticeApi } from '@/features/home/xNoticeApi';
import { GoalEditPopup } from '@/features/goals/GoalEditPopup';
import type { GoalDocument } from '@/features/goals/types';
import { SettingsPopup, settingsPopupStyles } from '@/features/settings/SettingsPopup';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 分 → 「○時間○分」(時間は3桁区切り。requirements 4-6, mokuhyo.txt「5」, problem P-017) */
function formatHoursMinutesDisplay(totalMinutes: number): string {
  const { hours, minutes } = splitHoursMinutes(totalMinutes);
  return `${formatWithThousandsSeparator(hours)}時間${minutes}分`;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'no_goal' }
  | { status: 'error' }
  | { status: 'ok'; data: HomeData; summary: HomeSummary };

function summarizeHomeData(data: HomeData, now: number): LoadState {
  try {
    return { status: 'ok', data, summary: calculateHomeSummary({ ...data, now }) };
  } catch {
    // 不正なデータは通信失敗と同じ再試行表示(requirements 4-8)にする。
    return { status: 'error' };
  }
}

/**
 * ホーム画面(6-1。requirements 4-6、2026-10-12 決定の画面構成)。
 * 上から: (編集ボタン。右上固定) → お知らせ(あるときだけ) → 大きな達成率とグリーンの進捗スライダー・
 * 積み上げ時間 → 「あと○日」「残り必要時間」カード(左右) → 最低/努力目標の達成日数カード(左右)。
 * 通知の操作やエラーで高さが増える場合は、iPhone SEでもスクロールで操作できるようにする。
 *
 * データの読み込みは画面から切り離した層(homeDataRepository)が行い、計算は
 * shared/homeSummary.ts の calculateHomeSummary を使う(重複実装しない)。
 *
 * 試験日当日以降は日数カードを「お疲れさまでした」に切り替え、既存の目標変更確認への
 * ボタンを表示する(6-3b。他の数値は通常どおり表示する)。
 * X通知は最新未読1件を表示し、閉じる操作は既読API成功後にだけ反映する。
 * 再連携の既読化はサーバーの確定transactionに任せ、ホーム復帰時に再取得する。
 */
export default function HomeScreen() {
  const router = useRouter();
  const { request: requestAccountAction, isReady } = useAccountActions();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState<{ goalId: string; goal: GoalDocument } | null>(null);
  const editRevision = useRef(0);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replacementConfirm, setReplacementConfirm] = useState<{ uid: string; goalId: string } | null>(null);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const replacementLock = useRef(false);
  const homeContext = useRef({ active: false, generation: 0, owner: null as string | null });
  const noticeLock = useRef<number | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeError, setNoticeError] = useState<{ id: string; message: string } | null>(null);

  const canOperateNotice = () => {
    const context = homeContext.current;
    return context.active && context.owner !== null && context.owner === getCurrentUid() && isReady();
  };

  const closeNotice = async () => {
    if (!canOperateNotice() || noticeLock.current !== null || state.status !== 'ok' || !state.data.notice) return;
    const noticeId = state.data.notice.id;
    const uid = homeContext.current.owner;
    const generation = homeContext.current.generation;
    const valid = () => homeContext.current.generation === generation
      && homeContext.current.owner === uid && canOperateNotice();
    noticeLock.current = generation;
    setNoticeBusy(true);
    setNoticeError(null);
    try {
      await xNoticeApi.ack(noticeId);
      if (!valid()) return;
      setState((current) => valid() && current.status === 'ok' && current.data.notice?.id === noticeId
        ? { ...current, data: { ...current.data, notice: null } }
        : current);
    } catch {
      if (valid()) {
        setNoticeError({ id: noticeId, message: '通信できませんでした。電波の良い場所で再度お試しください' });
      }
    } finally {
      if (noticeLock.current === generation) {
        noticeLock.current = null;
        setNoticeBusy(false);
      }
    }
  };

  const relinkNotice = () => {
    if (!canOperateNotice() || noticeLock.current !== null || state.status !== 'ok'
      || state.data.notice?.kind !== 'relink_required') return;
    router.push({ pathname: '/x-link', params: { mode: 'relink' } });
  };

  const openReplacement = async () => {
    if (!isReady() || replacementLock.current || state.status !== 'ok') return;
    const uid = getCurrentUid();
    const goalId = state.data.goalId;
    replacementLock.current = true; setReplacementBusy(true);
    try {
      await assertReplacementStopped();
      if (!isReady() || !uid || getCurrentUid() !== uid) throw new Error();
      setReplacementConfirm({ uid, goalId });
      setReplacementError(null); setEditMenuOpen(false);
    } catch (error) {
      setReplacementError(error instanceof ReplacementMeasuringError ? error.message : REPLACEMENT_COMMUNICATION_ERROR);
    } finally { replacementLock.current = false; setReplacementBusy(false); }
  };
  const confirmReplacement = async () => {
    if (!isReady() || !replacementConfirm || replacementLock.current) return;
    replacementLock.current = true; setReplacementBusy(true);
    try {
      const record = await beginGoalReplacement(replacementConfirm.goalId, replacementConfirm.uid);
      if (!isReady()) return;
      setReplacementConfirm(null); setReplacementError(null);
      router.replace(record.committedGoalId ? '/onboarding/pace' : resolveOnboardingResumeRoute(record.draft, Date.now()));
    } catch (error) {
      setReplacementError(error instanceof ReplacementMeasuringError ? error.message : REPLACEMENT_COMMUNICATION_ERROR);
    } finally { replacementLock.current = false; setReplacementBusy(false); }
  };

  useFocusEffect(useCallback(() => {
    let focused = true;
    let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    let requestId = reloadToken;
    let date = toJstDateKey(Date.now());
    homeContext.current.active = foreground;
    const invalidateNoticeOperation = () => {
      ++homeContext.current.generation;
      homeContext.current.owner = null;
      noticeLock.current = null;
      setNoticeBusy(false);
      setNoticeError(null);
    };
    invalidateNoticeOperation();

    const recalculate = () => {
      const now = Date.now();
      setState((current) => current.status === 'ok' ? summarizeHomeData(current.data, now) : current);
    };
    const refresh = async () => {
      const id = ++requestId;
      const revision = editRevision.current;
      const uid = getCurrentUid();
      invalidateNoticeOperation();
      const generation = homeContext.current.generation;
      const result = await fetchHomeData();
      // UID・取得世代・表示状態が変わった応答は反映しない。
      if (!focused || !foreground || id !== requestId || revision !== editRevision.current
        || generation !== homeContext.current.generation || getCurrentUid() !== uid) {
        return;
      }
      homeContext.current.owner = uid;
      setState(result.status === 'ok'
        ? summarizeHomeData(result.data, Date.now())
        : { status: result.status });
    };

    if (foreground) {
      void refresh();
    }
    const subscription = AppState.addEventListener('change', (appState) => {
      foreground = appState === 'active';
      homeContext.current.active = foreground;
      if (foreground) {
        date = toJstDateKey(Date.now());
        recalculate();
        void refresh();
      } else {
        ++requestId;
        invalidateNoticeOperation();
      }
    });
    const interval = setInterval(() => {
      if (!foreground) {
        return;
      }
      recalculate();
      const today = toJstDateKey(Date.now());
      if (date !== today) {
        date = today;
        void refresh();
      }
    }, 1_000); // 通常は取得済みセッションの再計算のみ。通信は日付変更時だけ。

    return () => {
      focused = false;
      homeContext.current.active = false;
      ++homeContext.current.generation;
      homeContext.current.owner = null;
      noticeLock.current = null;
      subscription.remove();
      clearInterval(interval);
    };
  }, [reloadToken]));

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <View testID="home-screen" style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          testID="home-edit-button"
          disabled={state.status !== 'ok' || !state.data.goalDocument}
          onPress={() => {
            if (state.status === 'ok' && state.data.goalDocument) {
              setEditMenuOpen(true);
            }
          }}
        >
          <Text style={styles.editText}>編集</Text>
        </Pressable>
      </View>

      {state.status === 'loading' ? (
        <View style={styles.centerArea}>
          <Text testID="home-loading-text" style={styles.statusText}>
            読み込み中...
          </Text>
        </View>
      ) : state.status === 'error' ? (
        <View style={styles.centerArea}>
          <ErrorText
            testID="home-error-text"
            message="通信できませんでした。電波の良い場所で再度お試しください"
          />
          <View style={styles.retryButtonArea}>
            <PrimaryButton title="再試行" onPress={retry} testID="home-retry-button" />
          </View>
        </View>
      ) : state.status === 'no_goal' ? (
        <View style={styles.centerArea}>
          <Text testID="home-goal-not-set-text" style={styles.statusText}>
            目標未設定
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.contentScroll} contentContainerStyle={styles.contentContainer}>
          <HomeContent
            summary={state.summary}
            notice={state.data.notice}
            noticeBusy={noticeBusy}
            noticeError={noticeError?.id === state.data.notice?.id ? noticeError?.message ?? null : null}
            onNoticeClose={() => { void closeNotice(); }}
            onNoticeRelink={relinkNotice}
            onReplacement={openReplacement}
            replacementBusy={replacementBusy}
            replacementError={!replacementConfirm && !editMenuOpen ? replacementError : null}
          />
        </ScrollView>
      )}
      {replacementConfirm ? <View testID="home-replace-dialog" style={settingsPopupStyles.backdrop}>
        <View style={settingsPopupStyles.popup} accessibilityViewIsModal>
          <Text style={settingsPopupStyles.title}>積み上げ時間は0からになります</Text>
          <View style={settingsPopupStyles.content}>
            <ErrorText message={replacementError} testID="home-replace-error" />
            <PrimaryButton title={replacementError ? '再試行' : '変更する'} testID="home-replace-confirm"
              disabled={replacementBusy} onPress={confirmReplacement} />
            <PrimaryButton title="キャンセル" variant="secondary" testID="home-replace-cancel"
              disabled={replacementBusy} onPress={() => { setReplacementConfirm(null); setReplacementError(null); }} />
          </View>
        </View>
      </View> : null}
      {editMenuOpen ? <View testID="home-edit-menu" style={settingsPopupStyles.backdrop}>
        <View style={settingsPopupStyles.popup} accessibilityViewIsModal>
          <Text style={settingsPopupStyles.title}>編集</Text>
          <View style={settingsPopupStyles.content}>
            <PrimaryButton title="目標の数値" testID="home-edit-numbers" onPress={() => {
              if (state.status === 'ok' && state.data.goalDocument) {
                setEditing({ goalId: state.data.goalId, goal: state.data.goalDocument });
                setEditMenuOpen(false);
              }
            }} />
            <PrimaryButton title="設定とリンク" testID="home-edit-settings" onPress={() => {
              setSettingsOpen(true);
              setEditMenuOpen(false);
            }} />
            <PrimaryButton title="目標そのものを変更" testID="home-replace-goal" disabled={replacementBusy} onPress={openReplacement} />
            <PrimaryButton title="ログアウト" testID="home-logout" onPress={() => {
              setEditMenuOpen(false);
              requestAccountAction('logout', getCurrentUid() ?? '');
            }} />
            <PrimaryButton title="アカウント削除" testID="home-delete-account" onPress={() => {
              setEditMenuOpen(false);
              requestAccountAction('delete', getCurrentUid() ?? '');
            }} />
            <ErrorText message={replacementError} testID="home-replace-start-error" />
            <PrimaryButton title="キャンセル" variant="secondary" testID="home-edit-menu-cancel"
              onPress={() => { setEditMenuOpen(false); setReplacementError(null); }} />
          </View>
        </View>
      </View> : null}
      {settingsOpen ? <SettingsPopup onCancel={() => setSettingsOpen(false)} onSaved={() => setSettingsOpen(false)}
        onRelink={() => {
          setSettingsOpen(false);
          router.push({ pathname: '/x-link', params: { mode: 'relink' } });
        }} /> : null}
      {editing ? <GoalEditPopup goalId={editing.goalId} goal={editing.goal} onCancel={() => setEditing(null)}
        onSaved={(patch) => {
          ++editRevision.current;
          setState((current) => current.status === 'ok' && current.data.goalId === editing.goalId
            ? summarizeHomeData({ ...current.data, goal: { ...current.data.goal, ...patch },
              goalDocument: { ...editing.goal, ...patch } as GoalDocument }, Date.now()) : current);
          setEditing(null);
        }} /> : null}
    </View>
  );
}

type HomeContentProps = {
  summary: HomeSummary;
  notice: HomeNotice;
  noticeBusy: boolean;
  noticeError: string | null;
  onNoticeClose: () => void;
  onNoticeRelink: () => void;
  onReplacement: () => void;
  replacementBusy: boolean;
  replacementError: string | null;
};

function HomeContent({
  summary,
  notice,
  noticeBusy,
  noticeError,
  onNoticeClose,
  onNoticeRelink,
  onReplacement,
  replacementBusy,
  replacementError,
}: HomeContentProps) {
  return (
    <>
      {notice ? (
        <View testID="home-notice-banner" style={styles.notice}>
          <Text testID="home-notice-date" style={styles.noticeText}>{notice.date}</Text>
          <Text testID="home-notice-text" style={styles.noticeText}>
            {notice.message}
          </Text>
          <View style={styles.noticeActions}>
            <View style={styles.noticeAction}>
              <PrimaryButton title="閉じる" variant="secondary" testID="home-notice-close"
                disabled={noticeBusy} onPress={onNoticeClose} />
            </View>
            {notice.kind === 'relink_required' ? (
              <View style={styles.noticeAction}>
                <PrimaryButton title="Xと再連携" testID="home-notice-relink"
                  disabled={noticeBusy} onPress={onNoticeRelink} />
              </View>
            ) : null}
          </View>
          <ErrorText message={noticeError} testID="home-notice-error" />
          {noticeError ? (
            <View style={styles.retryButtonArea}>
              <PrimaryButton title="再試行" testID="home-notice-retry"
                disabled={noticeBusy} onPress={onNoticeClose} />
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.centerArea}>
        <Text testID="home-percent-text" style={styles.percent}>
          {`${summary.achievementPercent.toFixed(1)}%`}
        </Text>
        <View style={styles.progressWrapper}>
          <ProgressBar testID="home-progress-bar" ratio={summary.sliderRatio} />
        </View>
        <Text testID="home-accumulated-text" style={styles.accumulated}>
          {formatHoursMinutesDisplay(summary.accumulatedMinutes)}
        </Text>
      </View>

      <View style={styles.cardRow}>
        <Card style={styles.cardHalf}>
          <Text testID="home-days-until-exam-text" style={styles.cardValue}>
            {summary.exam.status === 'before_exam'
              ? `あと${summary.exam.daysUntilExam}日`
              : 'お疲れさまでした'}
          </Text>
        </Card>
        <Card style={styles.cardHalf}>
          <Text testID="home-remaining-minutes-text" style={styles.cardValue}>
            {summary.targetReached
              ? '達成済み'
              : `残り必要時間 ${formatHoursMinutesDisplay(summary.remainingMinutes)}`}
          </Text>
        </Card>
      </View>

      <View style={styles.cardRow}>
        <Card style={styles.cardHalf}>
          <Text style={styles.cardLabel}>最低勉強時間の達成日数</Text>
          <Text testID="home-met-min-days-text" style={styles.cardValue}>
            {`${summary.metMinDays}日 / 経過${summary.elapsedDays}日`}
          </Text>
        </Card>
        <Card style={styles.cardHalf}>
          <Text style={styles.cardLabel}>努力目標勉強時間の達成日数</Text>
          <Text testID="home-met-goal-days-text" style={styles.cardValue}>
            {`${summary.metGoalDays}日 / 経過${summary.elapsedDays}日`}
          </Text>
        </Card>
      </View>
      {summary.exam.status === 'exam_date_reached' ? (
        <View style={styles.nextGoalArea}>
          <ErrorText message={replacementError} testID="home-next-goal-error" />
          <PrimaryButton
            title="次の目標を設定"
            testID="home-next-goal-button"
            disabled={replacementBusy}
            onPress={onReplacement}
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    justifyContent: 'space-between',
  },
  contentScroll: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  noticeActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  noticeAction: {
    flexGrow: 1,
    flexBasis: 120,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  editText: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
  },
  retryButtonArea: {
    marginTop: spacing.md,
    minWidth: 160,
  },
  notice: {
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  noticeText: {
    fontSize: typography.caption.fontSize,
    color: colors.text,
  },
  percent: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.text,
  },
  progressWrapper: {
    alignSelf: 'stretch',
    marginTop: spacing.md,
  },
  accumulated: {
    marginTop: spacing.sm,
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.textSecondary,
  },
  cardRow: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
  },
  nextGoalArea: {
    marginBottom: spacing.lg,
  },
  cardHalf: {
    flex: 1,
    marginHorizontal: spacing.xs,
  },
  cardLabel: {
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  cardValue: {
    marginTop: spacing.xs,
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
});
