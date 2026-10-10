import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * Phase 5-2-0 技術検証専用の画面。
 * expo-notifications で「勉強中?」確認(requirements.md 3-2)に必要な次のことを確かめる:
 *   - 通知の許可を求める・許可の状態を読む
 *   - アクション付きのカテゴリを登録し、ローカル通知を予約・取り消す
 *   - アプリが前面/裏/終了のそれぞれでアクションの応答をどう受け取れるか
 *   - 前面表示中の通知バナー表示の有無を切り替えられるか
 * タブ・ナビゲーションには含めない(本番の画面遷移から到達できない)。本番ビルド(__DEV__ が false)では空の画面にする
 */

const STUDY_CHECK_CATEGORY = 'STUDY_CHECK';
const STUDY_CHECK_ACTION = 'STUDY_CHECK_YES';

export default function DevNotificationProbeScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [showBannerInForeground, setShowBannerInForeground] = useState(true);
  const lastScheduledIdRef = useRef<string | null>(null);
  const showBannerRef = useRef(showBannerInForeground);

  useEffect(() => {
    showBannerRef.current = showBannerInForeground;
  }, [showBannerInForeground]);

  function appendLog(message: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${message}`, ...prev].slice(0, 40));
  }

  useEffect(() => {
    if (!__DEV__) {
      return;
    }

    // 前面表示中に通知が来たときの扱いを決めるハンドラ。
    // shouldShowBanner/shouldShowList を false にすると前面ではバナー・通知センター一覧に出さない
    // (= アプリ内ダイアログに任せる想定)。addNotificationReceivedListener はこの設定に関係なく呼ばれる
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: showBannerRef.current,
        shouldShowList: showBannerRef.current,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    // アプリが起動中(前面 or 裏で動作中)に通知を受信したとき
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      try {
        appendLog(`受信(addNotificationReceivedListener): id=${notification.request.identifier}`);
      } catch (error) {
        appendLog(`受信リスナーでエラー: ${String(error)}`);
      }
    });

    // アプリが起動中にアクション応答(タップ・ボタン押下)があったとき
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        appendLog(
          `応答(addNotificationResponseReceivedListener): actionIdentifier=${response.actionIdentifier} ` +
            `notificationId=${response.notification.request.identifier}`,
        );
      } catch (error) {
        appendLog(`応答リスナーでエラー: ${String(error)}`);
      }
    });

    // アプリが終了していて通知のアクションから起動された場合、上のリスナーは呼ばれない。
    // 起動直後に getLastNotificationResponseAsync で「直前に受けた応答」を取りに行く必要がある
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        appendLog(
          `起動時の最後の応答(getLastNotificationResponseAsync): actionIdentifier=${response.actionIdentifier} ` +
            `notificationId=${response.notification.request.identifier}`,
        );
      } else {
        appendLog('起動時の最後の応答(getLastNotificationResponseAsync): なし');
      }
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, []);

  async function checkPermission() {
    const status = await Notifications.getPermissionsAsync();
    appendLog(`許可状態: status=${status.status} granted=${status.granted} ios=${JSON.stringify(status.ios)}`);
  }

  async function requestPermission() {
    const status = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    appendLog(`許可を要求: status=${status.status} granted=${status.granted}`);
  }

  async function registerCategory() {
    const category = await Notifications.setNotificationCategoryAsync(STUDY_CHECK_CATEGORY, [
      {
        identifier: STUDY_CHECK_ACTION,
        buttonTitle: '勉強中',
        options: { opensAppToForeground: true },
      },
    ]);
    appendLog(`カテゴリ登録: ${JSON.stringify(category)}`);
  }

  async function scheduleCheckNotification() {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: '勉強中?',
        categoryIdentifier: STUDY_CHECK_CATEGORY,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 20 },
    });
    lastScheduledIdRef.current = id;
    appendLog(`予約(20秒後): id=${id}`);
  }

  async function listScheduled() {
    const list = await Notifications.getAllScheduledNotificationsAsync();
    appendLog(`予約一覧: ${list.length}件 ids=${list.map((n) => n.identifier).join(',')}`);
  }

  async function cancelScheduled() {
    const id = lastScheduledIdRef.current;
    if (!id) {
      appendLog('取り消し: 直前に予約したIDがありません');
      return;
    }
    await Notifications.cancelScheduledNotificationAsync(id);
    appendLog(`取り消し: id=${id}`);
    lastScheduledIdRef.current = null;
  }

  async function checkLastResponse() {
    const response = await Notifications.getLastNotificationResponseAsync();
    appendLog(
      response
        ? `最後の応答: actionIdentifier=${response.actionIdentifier} notificationId=${response.notification.request.identifier}`
        : '最後の応答: なし',
    );
  }

  if (!__DEV__) {
    return <View style={styles.container} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>5-2-0 技術検証: expo-notifications</Text>
      <Button title="許可状態を確認(getPermissionsAsync)" onPress={() => void checkPermission()} />
      <Button title="許可を求める(requestPermissionsAsync)" onPress={() => void requestPermission()} />
      <Button title="カテゴリ登録(勉強中アクション)" onPress={() => void registerCategory()} />
      <Button title="20秒後に通知を予約" onPress={() => void scheduleCheckNotification()} />
      <Button title="予約一覧を確認" onPress={() => void listScheduled()} />
      <Button title="直前の予約を取り消す" onPress={() => void cancelScheduled()} />
      <Button title="最後の応答を確認" onPress={() => void checkLastResponse()} />
      <Button
        title={`前面でのバナー表示: ${showBannerInForeground ? 'ON' : 'OFF'}(切替)`}
        onPress={() => setShowBannerInForeground((prev) => !prev)}
      />
      {log.map((line, index) => (
        <Text key={`${index}-${line}`} style={styles.log} testID="dev-notification-probe-log-line">
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'stretch',
    gap: 8,
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  log: {
    fontSize: 12,
    color: '#333333',
  },
});
