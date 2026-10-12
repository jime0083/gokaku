import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBAuth from '@react-native-firebase/auth';
import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { connectFirebaseEmulatorsIfNeeded } from '../config/firebase';
import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';
import { callIssueDeviceToken } from '../features/deviceToken/deviceTokenApi';
import { saveDeviceTokenToKeychain } from '../features/deviceToken/studySyncAuthContext';
import { generateLocalId } from '../features/timer/id';
// study-sync は Phase 1-4 専用の検証用ローカル Expo Module(modules/study-sync)
import StudySync from '../../modules/study-sync/src/StudySyncModule';

/**
 * Phase 1-4 技術検証専用の画面。
 * ロック画面・通知アクションからのサーバー同期を手動で確かめるための画面で、
 * タブ・ナビゲーションには含めない(Phase 5 で正式なタイマー画面に置き換える)。
 * 本番ビルド(Emulator に接続しない)では「開発ビルドでのみ使えます」の表示になる
 *
 * 5-3a-2: デバイストークンの発行は devIssueDeviceToken(検証専用。削除済み)ではなく、
 * 正式な issueDeviceToken(Callable。5-3a)を使う。issueDeviceToken は Firebase Auth の
 * 現在のユーザー(request.auth.uid)向けにしか発行できないため、入力欄の uid を
 * Auth Emulator 専用のテストユーザーのメールアドレスの一部として使ってサインインし、
 * 実際に発行された uid で Keychain への保存・以後の開始/停止を行う(uid の入力欄の値を上書きする)
 *
 * 5-3c-3: 計測中の状態(App Group に 1 件だけ置く値)・確認 ON/OFF の設定の読み・書き・消去を
 * 手動で確かめるボタンもこの画面に足す(画面(タイマー)や Intent にはまだつながない)
 */

export default function DevLockscreenSpikeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [uid, setUid] = useState('spike-user-1');
  const [goalId, setGoalId] = useState('spike-goal-1');
  const [log, setLog] = useState<string[]>([]);
  // 5-3c-4: startMeasurement/stopMeasurement は sessionId を呼び出し側(JS)から渡す形になった。
  // 開始時に作った sessionId を停止まで覚えておく
  const [sessionId, setSessionId] = useState<string | null>(null);

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

  // Auth Emulator 専用のテストユーザー(本番の Firebase には存在しない・接続しない。dev-firebase-probe.tsx と同じ方式)
  async function signInDevTestUser(label: string): Promise<string | null> {
    const email = `dev-lockscreen-spike-${label}@example.com`;
    const password = 'dev-lockscreen-spike-password';
    connectFirebaseEmulatorsIfNeeded();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    const { createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/auth') as typeof RNFBAuth;
    const auth = getAuth(getApp());
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return credential.user.uid;
    } catch {
      try {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        return credential.user.uid;
      } catch (error) {
        appendLog(`サインインに失敗: ${String(error)}`);
        return null;
      }
    }
  }

  async function handleIssueToken() {
    try {
      const signedInUid = await signInDevTestUser(uid);
      if (!signedInUid) {
        return;
      }
      const result = await callIssueDeviceToken();
      if (!result) {
        appendLog('issueDeviceToken 失敗');
        return;
      }
      const saved = saveDeviceTokenToKeychain(signedInUid, result.deviceToken);
      if (!saved) {
        appendLog('Keychain への保存に失敗');
        return;
      }
      setUid(signedInUid);
      StudySync.setCurrentGoalId(goalId);
      appendLog(`デバイストークンを Keychain(App Group)に保存した(uid=${signedInUid})`);
    } catch (error) {
      appendLog(`issueDeviceToken エラー: ${String(error)}`);
    }
  }

  async function handleRequestPermission() {
    const granted = await StudySync.requestNotificationPermission();
    appendLog(`通知許可: ${granted}`);
  }

  async function handleStart() {
    const newSessionId = generateLocalId();
    setSessionId(newSessionId);
    const sent = await StudySync.startMeasurement(uid, goalId, newSessionId, true);
    appendLog(`開始(ライブアクティビティ表示)。sessionId=${newSessionId} 送信: ${sent}${failureReasonSuffix(sent)}`);
  }

  async function handleStop() {
    if (!sessionId) {
      appendLog('停止: 開始していないため sessionId が無い');
      return;
    }
    const sent = await StudySync.stopMeasurement(uid, goalId, sessionId);
    appendLog(`停止。送信: ${sent}${failureReasonSuffix(sent)}`);
    setSessionId(null);
  }

  /** 送信に失敗した場合、直前の失敗理由(problem P-012: 401・通信不可等)を併記する */
  function failureReasonSuffix(sent: boolean): string {
    if (sent) {
      return '';
    }
    const reason = StudySync.getLastSyncErrorReason();
    return reason ? `(理由: ${reason})` : '';
  }

  async function handleFlushQueue() {
    const count = await StudySync.flushQueue();
    appendLog(`キューを再送: ${count}件`);
  }

  function handleShowQueueCount() {
    appendLog(`未送信キュー: ${StudySync.getPendingQueueCount()}件`);
  }

  // 5-3c-3: 計測中の状態(App Group)の読み・書き・消去を手動で確かめる
  function handleWriteActiveSession() {
    const written = StudySync.setActiveSession({
      sessionId: 'spike-active-session-1',
      uid,
      goalId,
      startAt: Date.now(),
      checkEnabled: true,
      confirmations: [],
    });
    appendLog(`計測中の状態を書いた: ${written}`);
  }

  function handleWriteInvalidActiveSession() {
    const written = StudySync.setActiveSession({
      // sessionId が空文字(不正な形)。書き込みが断られることを確かめる
      sessionId: '',
      uid,
      goalId,
      startAt: Date.now(),
      checkEnabled: true,
      confirmations: [],
    });
    appendLog(`不正な形の書き込み結果(false になるはず): ${written}`);
  }

  function handleReadActiveSession() {
    const session = StudySync.getActiveSession();
    appendLog(`計測中の状態: ${session === null ? 'なし' : JSON.stringify(session)}`);
  }

  function handleClearActiveSession() {
    StudySync.clearActiveSession();
    appendLog('計測中の状態を消した');
  }

  function handleWriteCheckEnabledSetting(enabled: boolean) {
    StudySync.setCheckEnabledSetting(enabled);
    appendLog(`確認ON/OFFの設定を書いた: ${enabled}`);
  }

  function handleReadCheckEnabledSetting() {
    appendLog(`確認ON/OFFの設定: ${StudySync.getCheckEnabledSetting()}`);
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
      <Button title="キューを再送" onPress={handleFlushQueue} />
      <Button title="未送信キュー件数を表示" onPress={handleShowQueueCount} />
      <Text style={styles.title}>5-3c-3 計測中の状態(App Group)</Text>
      <Button title="計測中の状態を書く" onPress={handleWriteActiveSession} />
      <Button title="不正な形で書く(断られる確認)" onPress={handleWriteInvalidActiveSession} />
      <Button title="計測中の状態を読む" onPress={handleReadActiveSession} />
      <Button title="計測中の状態を消す" onPress={handleClearActiveSession} />
      <Button title="確認設定を書く(ON)" onPress={() => handleWriteCheckEnabledSetting(true)} />
      <Button title="確認設定を書く(OFF)" onPress={() => handleWriteCheckEnabledSetting(false)} />
      <Button title="確認設定を読む" onPress={handleReadCheckEnabledSetting} />
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
