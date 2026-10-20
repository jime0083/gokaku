import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { fetchCheckEnabled } from './checkEnabledRepository';

/**
 * 「勉強中？」確認のローカル通知(5-2c。requirements 3-2)。
 * expo-notifications を使う部分はこのファイルに閉じ込める(useTimerSession は、ここが export する
 * 関数だけを呼ぶ)。
 *
 * 5-2-0 の検証で分かった制約:
 * - 応答の受け取りは addNotificationResponseReceivedListener(起動中)と、起動時の
 *   getLastNotificationResponse(非推奨の Async 版は使わない)で行う
 * - アクションは opensAppToForeground: true にする(false だとアプリ終了中の応答を受け取れない)
 * - addNotificationReceivedListener は使わない(P-029: アプリが前面のとき一度も呼ばれなかった)
 * - アプリが前面のときは setNotificationHandler で通知を出さない
 *   (shouldShowBanner/List を false にする。この設定は iOS が前面表示中にだけ使われ、
 *   裏/終了中は OS が通常どおり通知を表示する)
 */

/** 通知のアクションのカテゴリ識別子 */
export const STUDY_CHECK_CATEGORY_IDENTIFIER = 'STUDY_CHECK';
/** 「勉強中」アクションの識別子 */
export const STUDY_CHECK_ACTION_IDENTIFIER = 'STUDY_CHECK_CONFIRM';
/**
 * 予約する通知の識別子。計測中、確認が ON の間は常に1件だけを予約するため固定値を使う
 * (同じ識別子で scheduleNotificationAsync を呼ぶと、先に予約していたものは置き換わる)
 */
export const STUDY_CHECK_NOTIFICATION_IDENTIFIER = 'study-check-notification';

const PERMISSION_REQUESTED_STORAGE_KEY = 'timer:notificationPermissionRequested:v1';

let configured = false;

/**
 * 通知ハンドラ(前面では出さない)とカテゴリ(「勉強中」アクション)を登録する。
 * 何度呼んでも1回だけ設定する(TimerSessionProvider のマウント時に呼ぶ想定)
 */
export function configureStudyCheckNotifications(): void {
  if (configured) {
    return;
  }
  configured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  void Notifications.setNotificationCategoryAsync(STUDY_CHECK_CATEGORY_IDENTIFIER, [
    {
      identifier: STUDY_CHECK_ACTION_IDENTIFIER,
      buttonTitle: '勉強中',
      options: { opensAppToForeground: true },
    },
  ]);
}

/** テスト専用: configureStudyCheckNotifications を再度実行できるようにする */
export function resetStudyCheckNotificationsConfiguredForTest(): void {
  configured = false;
}

/** 初めて計測を開始したときにだけ、通知の許可を求める(requirements 3-2) */
export async function requestNotificationPermissionOnce(): Promise<void> {
  const alreadyRequested = (await AsyncStorage.getItem(PERMISSION_REQUESTED_STORAGE_KEY)) === 'true';
  if (alreadyRequested) {
    return;
  }
  await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  await AsyncStorage.setItem(PERMISSION_REQUESTED_STORAGE_KEY, 'true');
}

/** 通知が許可されているか(タイマー画面の案内の表示判定に使う) */
export async function isNotificationPermissionGranted(): Promise<boolean> {
  const status = await Notifications.getPermissionsAsync();
  return status.granted;
}

/** 確認の時刻(checkAtMs)にローカル通知を1件予約する(既存の予約があれば置き換える) */
export async function scheduleStudyCheckNotification(checkAtMs: number, ownerUid?: string): Promise<void> {
  if (ownerUid !== undefined && (typeof ownerUid !== 'string' || ownerUid.trim().length === 0)) {
    throw new Error('study-check-notification-invalid-uid');
  }
  const seconds = Math.max(1, Math.round((checkAtMs - Date.now()) / 1000));
  await Notifications.scheduleNotificationAsync({
    identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
    content: {
      title: '勉強中？',
      categoryIdentifier: STUDY_CHECK_CATEGORY_IDENTIFIER,
      ...(ownerUid === undefined ? {} : { data: { uid: ownerUid } }),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  });
}

/** 予約中の確認の通知を取り消す(予約がなくても安全に呼べる) */
export async function cancelStudyCheckNotification(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(STUDY_CHECK_NOTIFICATION_IDENTIFIER);
}

/** 「勉強中」応答(今の受け取った時刻を応答時刻とする。requirements 3-2, 5-2c) */
export type StudyCheckConfirmResponse = {
  respondedAtMs: number;
};

/**
 * アプリが起動中(前面 or 裏で動作中)に、通知のアクション「勉強中」が押されたときに呼ばれる。
 * 既定のタップ(通知本文をタップ。DEFAULT_ACTION_IDENTIFIER)は確認への応答として扱わない
 */
export function addStudyCheckConfirmListener(
  onConfirm: (response: StudyCheckConfirmResponse) => void,
): { remove: () => void } {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    if (response.actionIdentifier !== STUDY_CHECK_ACTION_IDENTIFIER) {
      return;
    }
    onConfirm({ respondedAtMs: Date.now() });
  });
}

/**
 * アプリが終了していて、通知のアクション「勉強中」からアプリが起動された場合に呼ぶ
 * (addNotificationResponseReceivedListener は呼ばれないため)。
 * 直前に受けた応答を読み、同じ応答を二度と処理しないようにクリアしてから返す
 * (起動時に1回だけ呼ぶ想定。クリアは応答の有無・種類にかかわらず行う)
 */
export function consumeLastStudyCheckConfirmOnLaunch(): StudyCheckConfirmResponse | null {
  const response = Notifications.getLastNotificationResponse();
  Notifications.clearLastNotificationResponse();
  if (!response || response.actionIdentifier !== STUDY_CHECK_ACTION_IDENTIFIER) {
    return null;
  }
  return { respondedAtMs: Date.now() };
}

/**
 * タイマー画面の案内(requirements 3-2, 2026-10-10 追記)の表示判定。
 * 「確認が ON」かつ「通知が許可されていない」ときだけ true。
 * 画面を開いたとき・他のアプリから戻ったとき(AppState が active)に読み直す
 */
export function useStudyCheckNotificationNotice(): boolean {
  const [showNotice, setShowNotice] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function refresh(): Promise<void> {
      const [checkEnabled, granted] = await Promise.all([
        fetchCheckEnabled(),
        isNotificationPermissionGranted(),
      ]);
      if (mounted) {
        setShowNotice(checkEnabled && !granted);
      }
    }

    void refresh();
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void refresh();
      }
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return showNotice;
}
