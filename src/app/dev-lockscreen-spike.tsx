import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBAuth from '@react-native-firebase/auth';
import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { connectFirebaseEmulatorsIfNeeded } from '../config/firebase';
import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';
import { callIssueDeviceToken } from '../features/deviceToken/deviceTokenApi';
import { saveDeviceTokenToKeychain } from '../features/deviceToken/studySyncAuthContext';
import { generateLocalId } from '../features/timer/id';
import {
  DEV_STUDY_CHECK_INTERVAL_MS,
  DEV_STUDY_CHECK_RESPONSE_WINDOW_MS,
  getStudyCheckTiming,
  isStudyCheckDevOverrideEnabled,
  setStudyCheckDevOverrideEnabled,
} from '../features/timer/studyCheckDevOverride';
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
 *
 * 5-3c-5a: 「開始」「停止」ボタン(StudySync.startMeasurement/stopMeasurement)は nativeSync に
 * 送らなくなった(アプリの記録は recordStudyEvent(source=app)。5-3c-5b で JS からつなぐ)。
 * そのため、この画面での「送信: true/false」の確認ボタンは削除した(確認すべきことが無くなったため)。
 * 代わりに、計測中の状態(App Group)が書かれる・消えることをログで確かめられるようにし、
 * 「最後にロック画面で止めた計測」(5-3c-5a で追加)を読む・消すボタンを足した
 *
 * 5-3c-5b(problem P-034): 「デバイストークンを発行」を押すと、サインインできた実際の uid を
 * uid の入力欄に上書きする(上の 5-3a-2 の説明のとおり)。2回目以降に同じボタンを押したとき、
 * サインインに使うメールアドレスの元になる「ラベル」を、上書きされた後の uid 入力欄の値から
 * 作ってしまうと、毎回別のテストユーザー(=別の uid)になってしまう。
 * そのため、最初に押したときの入力欄の値を authLabel に覚えておき、2回目以降はそれを使う
 * (同じテストユーザー・同じ uid で発行し直す)
 *
 * 5-3c-6: nativeSync の応答(200・400・401・通信エラー等)に応じて、送り直す・捨てる・
 * トークンを待つを振り分ける StudySyncAPI の動きを確かめるボタンを足した。
 * ロック画面コントロール・通知アクション(StartStudyIntent/StopStudyIntent)からの送信は
 * システムの操作でしか起動できず自動化できないため、代わりに debugSendStudySyncEvent で
 * 同じ送信処理を直接試す(「デバイストークンを発行」で Keychain に保存した uid・token を使う)。
 * 401 を試すには Emulator UI で deviceTokens/{uid} を削除し、通信エラーを試すには Emulator を
 * 止める(手動の手順。5-3c-6 の確認手順)
 *
 * 5-3e-2(problem P-011 (3)): 「勉強中？」確認の間隔・応答期限(本番60分・10分)を、開発ビルドだけ
 * 短い値(2分・1分。DEV_STUDY_CHECK_INTERVAL_MS 等)に切り替えるボタンを足す。この画面自体が
 * 開発ビルド(emulatorConfig がある)でしか表示されないため、ここでは isDev の判定をせずに
 * src/features/timer/studyCheckDevOverride.ts の関数をそのまま呼ぶ(既定で __DEV__ を見る)。
 * 切り替えた設定は App Group に保存され、アプリのタイマー(useTimerSession)・ロック画面から
 * 開始したときの通知の予約(StudySyncCheckNotification)の両方に効く
 */

export default function DevLockscreenSpikeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [uid, setUid] = useState('spike-user-1');
  const [goalId, setGoalId] = useState('spike-goal-1');
  const [log, setLog] = useState<string[]>([]);
  // 5-3c-5b(P-034): 「デバイストークンを発行」のサインインに使うラベル。最初に押したときの
  // uid 入力欄の値を覚えておき、2回目以降は(uid が signedInUid に上書きされていても)これを使う
  const [authLabel, setAuthLabel] = useState<string | null>(null);
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
      // 2回目以降は、uid 入力欄がすでに signedInUid に上書きされていても、最初に押したときの
      // ラベルでサインインし直す(同じテストユーザー・同じ uid になる。problem P-034)
      const label = authLabel ?? uid;
      const signedInUid = await signInDevTestUser(label);
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
      setAuthLabel(label);
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

  // 5-3c-5a: startMeasurement/stopMeasurement は nativeSync に送らなくなった。
  // 戻り値は、計測中の状態(App Group)の書き込み・消去の結果を表す(送信結果ではない)
  async function handleStart() {
    const newSessionId = generateLocalId();
    setSessionId(newSessionId);
    const written = await StudySync.startMeasurement(uid, goalId, newSessionId, Date.now(), true);
    appendLog(`開始(ライブアクティビティ表示)。sessionId=${newSessionId} 計測中の状態を書いた: ${written}`);
  }

  async function handleStop() {
    if (!sessionId) {
      appendLog('停止: 開始していないため sessionId が無い');
      return;
    }
    const hadActiveSession = await StudySync.stopMeasurement(uid, goalId, sessionId);
    appendLog(`停止。計測中の状態があった: ${hadActiveSession}`);
    setSessionId(null);
  }

  // 5-3c-5a: nativeSync に実際に送るのは、ロック画面(StartStudyIntent/StopStudyIntent。5-3c-4)が
  // 送れなかったときにキューへ積んだ分の再送(flushQueue)だけになった。失敗理由(problem P-012:
  // 401・通信不可等)は直前の送信結果として getLastSyncErrorReason に残る
  async function handleFlushQueue() {
    const count = await StudySync.flushQueue();
    const reason = StudySync.getLastSyncErrorReason();
    appendLog(`キューを再送: ${count}件${reason ? `(直前の失敗理由: ${reason})` : ''}`);
  }

  function handleShowQueueCount() {
    appendLog(
      `未送信キュー: ${StudySync.getPendingQueueCount()}件(トークン待ち: ${StudySync.getPendingQueueWaitingForTokenCount()}件)`,
    );
  }

  // 5-3c-6: StudySyncAPI.send を直接試す(ロック画面の Intent は自動化できないため代わりに使う)。
  // goalId を架空の値に変えると 400(goal_not_found)、デバイストークンを Emulator UI で消すと 401、
  // Emulator を止めると通信エラー(送り直す対象)になることを確かめられる
  async function handleDebugSend(action: 'start' | 'confirm', targetGoalId: string) {
    const sessionIdForSend = generateLocalId();
    const sent = await StudySync.debugSendStudySyncEvent(
      uid,
      sessionIdForSend,
      targetGoalId,
      action,
      Date.now(),
      generateLocalId(),
      action === 'start' ? true : null,
    );
    const reason = StudySync.getLastSyncErrorReason();
    appendLog(
      `debugSend(${action}, goalId=${targetGoalId}): 送信=${sent}${reason ? `(理由: ${reason})` : ''}`,
    );
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

  // 5-3c-5a: 「最後にロック画面で止めた計測」(StopStudyIntent が残す sessionId・stopAt)を
  // 読む・消すボタン。実際にロック画面で止める操作は自動化できないため(5-3e で確認)、
  // ここでは読み・消しの動きだけを確かめる
  function handleReadLastLockscreenStop() {
    const stop = StudySync.getLastLockscreenStop();
    appendLog(`最後にロック画面で止めた計測: ${stop === null ? 'なし' : JSON.stringify(stop)}`);
  }

  function handleClearLastLockscreenStop() {
    StudySync.clearLastLockscreenStop();
    appendLog('最後にロック画面で止めた計測を消した');
  }

  // 5-3e-2: 「勉強中？」確認の間隔・応答期限を開発用の短い値(2分・1分)に切り替える・戻す・今の設定を見る
  function handleEnableShortStudyCheckInterval() {
    setStudyCheckDevOverrideEnabled(true);
    appendLog(
      `開発用の短い間隔に切り替えた(${DEV_STUDY_CHECK_INTERVAL_MS / 1000}秒・応答期限${DEV_STUDY_CHECK_RESPONSE_WINDOW_MS / 1000}秒)`,
    );
  }

  function handleDisableShortStudyCheckInterval() {
    setStudyCheckDevOverrideEnabled(false);
    appendLog('本番の間隔(60分・応答期限10分)に戻した');
  }

  function handleShowStudyCheckTiming() {
    const timing = getStudyCheckTiming();
    appendLog(
      `今の設定: 短い間隔=${isStudyCheckDevOverrideEnabled()}, 間隔=${timing.intervalMs / 1000}秒, 応答期限=${timing.responseWindowMs / 1000}秒`,
    );
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
      <Text style={styles.title}>5-3c-6 nativeSync の応答の扱い</Text>
      <Button title="送る: start(正常。200の見込み)" onPress={() => handleDebugSend('start', goalId)} />
      <Button
        title="送る: start(架空のgoalId。400の見込み)"
        onPress={() => handleDebugSend('start', 'nonexistent-goal-00000000')}
      />
      <Button title="送る: confirm(正常。200の見込み)" onPress={() => handleDebugSend('confirm', goalId)} />
      <Text style={styles.title}>5-3c-3 計測中の状態(App Group)</Text>
      <Button title="計測中の状態を書く" onPress={handleWriteActiveSession} />
      <Button title="不正な形で書く(断られる確認)" onPress={handleWriteInvalidActiveSession} />
      <Button title="計測中の状態を読む" onPress={handleReadActiveSession} />
      <Button title="計測中の状態を消す" onPress={handleClearActiveSession} />
      <Button title="確認設定を書く(ON)" onPress={() => handleWriteCheckEnabledSetting(true)} />
      <Button title="確認設定を書く(OFF)" onPress={() => handleWriteCheckEnabledSetting(false)} />
      <Button title="確認設定を読む" onPress={handleReadCheckEnabledSetting} />
      <Text style={styles.title}>5-3c-5a 最後にロック画面で止めた計測</Text>
      <Button title="最後にロック画面で止めた計測を読む" onPress={handleReadLastLockscreenStop} />
      <Button title="最後にロック画面で止めた計測を消す" onPress={handleClearLastLockscreenStop} />
      <Text style={styles.title}>5-3e-2 「勉強中？」確認の間隔(開発ビルド専用)</Text>
      <Button title="短い間隔(2分・応答期限1分)にする" onPress={handleEnableShortStudyCheckInterval} />
      <Button title="本番の間隔(60分・応答期限10分)に戻す" onPress={handleDisableShortStudyCheckInterval} />
      <Button title="今の設定を表示" onPress={handleShowStudyCheckTiming} />
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
