import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';
// study-sync は Phase 1-4 専用の検証用ローカル Expo Module(modules/study-sync)
import StudySync from '../../modules/study-sync/src/StudySyncModule';

/**
 * Phase 1-4 技術検証専用の画面。
 * ロック画面・通知アクションからのサーバー同期を手動で確かめるための画面で、
 * タブ・ナビゲーションには含めない(Phase 5 で正式なタイマー画面に置き換える)。
 * 本番ビルド(Emulator に接続しない)では「開発ビルドでのみ使えます」の表示になる
 */

// functions/src/config.ts・.firebaserc と同じ値(アプリ側にはまだ共有定数がないため、
// この検証用画面でだけ最小限のコピーを持つ)
const FUNCTIONS_PROJECT_ID = 'demo-gokaku';
const FUNCTIONS_REGION = 'asia-northeast1';

export default function DevLockscreenSpikeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [uid, setUid] = useState('spike-user-1');
  const [goalId, setGoalId] = useState('spike-goal-1');
  const [log, setLog] = useState<string[]>([]);

  function appendLog(message: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${message}`, ...prev].slice(0, 20));
  }

  if (!emulatorConfig) {
    return (
      <View style={styles.container}>
        <Text>開発ビルドでのみ使えます</Text>
      </View>
    );
  }

  const emulator = emulatorConfig;

  function functionUrl(name: string): string {
    return `http://${emulator.host}:${emulator.functionsPort}/${FUNCTIONS_PROJECT_ID}/${FUNCTIONS_REGION}/${name}`;
  }

  async function handleIssueToken() {
    try {
      const res = await fetch(functionUrl('devIssueDeviceToken'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid }),
      });
      const body = (await res.json()) as { deviceToken?: string; error?: string };
      if (!res.ok || !body.deviceToken) {
        appendLog(`devIssueDeviceToken 失敗: ${body.error ?? res.status}`);
        return;
      }
      try {
        StudySync.setAuthContext(uid, body.deviceToken);
      } catch (error) {
        appendLog(`Keychain への保存に失敗: ${String(error)}`);
        return;
      }
      StudySync.setCurrentGoalId(goalId);
      appendLog('デバイストークンを Keychain(App Group)に保存した');
    } catch (error) {
      appendLog(`devIssueDeviceToken エラー: ${String(error)}`);
    }
  }

  async function handleRequestPermission() {
    const granted = await StudySync.requestNotificationPermission();
    appendLog(`通知許可: ${granted}`);
  }

  async function handleStart() {
    const sent = await StudySync.startMeasurement(uid, goalId);
    appendLog(`開始(ライブアクティビティ表示)。送信: ${sent}${failureReasonSuffix(sent)}`);
  }

  async function handleStop() {
    const sent = await StudySync.stopMeasurement(uid, goalId);
    appendLog(`停止。送信: ${sent}${failureReasonSuffix(sent)}`);
  }

  /** 送信に失敗した場合、直前の失敗理由(problem P-012: 401・通信不可等)を併記する */
  function failureReasonSuffix(sent: boolean): string {
    if (sent) {
      return '';
    }
    const reason = StudySync.getLastSyncErrorReason();
    return reason ? `(理由: ${reason})` : '';
  }

  async function handleScheduleCheck() {
    await StudySync.scheduleCheckNotification(10, goalId);
    appendLog('10秒後に「勉強中?」通知を予約した');
  }

  async function handleFlushQueue() {
    const count = await StudySync.flushQueue();
    appendLog(`キューを再送: ${count}件`);
  }

  function handleShowQueueCount() {
    appendLog(`未送信キュー: ${StudySync.getPendingQueueCount()}件`);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>1-4 技術検証</Text>
      <TextInput style={styles.input} value={uid} onChangeText={setUid} placeholder="uid" />
      <TextInput style={styles.input} value={goalId} onChangeText={setGoalId} placeholder="goalId" />
      <Button title="通知の許可を要求" onPress={handleRequestPermission} />
      <Button title="デバイストークンを発行" onPress={handleIssueToken} />
      <Button title="開始" onPress={handleStart} />
      <Button title="停止" onPress={handleStop} />
      <Button title="確認通知を10秒後に予約" onPress={handleScheduleCheck} />
      <Button title="キューを再送" onPress={handleFlushQueue} />
      <Button title="未送信キュー件数を表示" onPress={handleShowQueueCount} />
      {log.map((line) => (
        <Text key={line} style={styles.log}>
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
    fontSize: 18,
    fontWeight: 'bold',
  },
  input: {
    borderWidth: 1,
    borderColor: '#CCCCCC',
    borderRadius: 4,
    padding: 8,
  },
  log: {
    fontSize: 12,
    color: '#333333',
  },
});
