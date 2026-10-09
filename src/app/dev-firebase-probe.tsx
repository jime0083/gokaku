import type * as RNFBAuth from '@react-native-firebase/auth';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { useEffect, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { connectFirebaseEmulatorsIfNeeded } from '../config/firebase';
import { getFirebaseEmulatorConfig } from '../config/firebase-emulator';

/**
 * Phase 3-5a 技術検証専用の画面。
 * React Native Firebase(ネイティブ SDK)が Auth/Firestore の Emulator に接続でき、
 * テスト用ユーザーでのサインインと devProbe コレクションへの読み書きが1回できることを確かめる。
 * タブ・ナビゲーションには含めない(本番の画面遷移から到達できない)。
 * 画面を開くと自動で サインイン→書き込み→読み取り を1回実行する(ボタンでの再実行も可能)。
 *
 * 注意(3-5a で確認): expo-router は src/app/ 配下の全ファイルをルート一覧作成のために読み込むため、
 * @react-native-firebase/* はこのファイルの先頭では import しない(他の端末・ビルドで
 * ネイティブモジュール未登録のクラッシュを招く。src/config/firebase.ts と同じ理由)。
 * 型だけ import type で取り、実際の呼び出しは関数の中で require する
 */

// Auth Emulator 専用のテストユーザー(本番の Firebase には存在しない・接続しない)
const TEST_EMAIL = 'dev-firebase-probe@example.com';
const TEST_PASSWORD = 'dev-firebase-probe-password';

type ProbeUser = RNFBAuth.User;

export default function DevFirebaseProbeScreen() {
  const emulatorConfig = getFirebaseEmulatorConfig();
  const [log, setLog] = useState<string[]>([]);

  function appendLog(message: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${message}`, ...prev].slice(0, 20));
  }

  async function signIn(): Promise<ProbeUser | null> {
    try {
      connectFirebaseEmulatorsIfNeeded();
      const { getApp } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
      const { createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/auth') as typeof RNFBAuth;
      const auth = getAuth(getApp());
      try {
        const credential = await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
        appendLog(`サインイン成功(既存ユーザー): uid=${credential.user.uid}`);
        return credential.user;
      } catch {
        const credential = await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
        appendLog(`テストユーザーを新規作成してサインイン: uid=${credential.user.uid}`);
        return credential.user;
      }
    } catch (error) {
      appendLog(`サインイン失敗: ${String(error)}`);
      return null;
    }
  }

  async function write(uid: string) {
    try {
      const { getApp } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
      const { doc, getFirestore, setDoc } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/firestore') as typeof import('@react-native-firebase/firestore');
      const db = getFirestore(getApp());
      await setDoc(doc(db, 'devProbe', uid), { checkedAt: Date.now() });
      appendLog('Firestore(Emulator)へ書き込み成功');
    } catch (error) {
      appendLog(`書き込み失敗: ${String(error)}`);
    }
  }

  async function read(uid: string) {
    try {
      const { getApp } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
      const { doc, getDoc, getFirestore } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@react-native-firebase/firestore') as typeof import('@react-native-firebase/firestore');
      const db = getFirestore(getApp());
      const snapshot = await getDoc(doc(db, 'devProbe', uid));
      appendLog(`Firestore(Emulator)から読み取り: ${JSON.stringify(snapshot.data())}`);
    } catch (error) {
      appendLog(`読み取り失敗: ${String(error)}`);
    }
  }

  async function runAll() {
    const user = await signIn();
    if (!user) {
      return;
    }
    await write(user.uid);
    await read(user.uid);
  }

  /** 呼び出した Callable の結果・エラーの中身をログに残す共通処理(4-2c-0 技術検証) */
  async function callAndLog(label: string, call: () => Promise<unknown>) {
    try {
      const result = await call();
      appendLog(`${label} 成功: ${JSON.stringify(result)}`);
    } catch (error) {
      const httpsError = error as { code?: unknown; message?: unknown; details?: unknown };
      appendLog(
        `${label} 失敗: code=${String(httpsError.code)} message=${String(httpsError.message)} details=${JSON.stringify(httpsError.details)}`,
      );
    }
  }

  function getFunctionsInstance() {
    connectFirebaseEmulatorsIfNeeded();
    const { getApp } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
    const { getFunctions } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/functions') as typeof RNFBFunctions;
    return getFunctions(getApp(), emulatorConfig?.functionsRegion);
  }

  /** ログイン済み・不正な transactionId で呼ぶ(4-2c-0: invalid-argument が返ることの確認) */
  async function callVerifyApplePurchaseInvalidArgument() {
    const user = await signIn();
    if (!user) {
      return;
    }
    const { httpsCallable } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/functions') as typeof RNFBFunctions;
    await callAndLog('verifyApplePurchase(不正なtransactionId)', async () => {
      const result = await httpsCallable(getFunctionsInstance(), 'verifyApplePurchase')({
        transactionId: 'not-a-number',
      });
      return result.data;
    });
  }

  /** 未ログインの状態で呼ぶ(4-2c-0: unauthenticated が返ることの確認) */
  async function callVerifyApplePurchaseUnauthenticated() {
    const { getAuth, signOut } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/auth') as typeof RNFBAuth;
    const { getApp } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
    connectFirebaseEmulatorsIfNeeded();
    await signOut(getAuth(getApp()));

    const { httpsCallable } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/functions') as typeof RNFBFunctions;
    await callAndLog('verifyApplePurchase(未ログイン)', async () => {
      const result = await httpsCallable(getFunctionsInstance(), 'verifyApplePurchase')({
        transactionId: '123',
      });
      return result.data;
    });
  }

  useEffect(() => {
    if (!emulatorConfig) {
      return;
    }
    // setState を直接呼ぶ runAll() を effect 本体で同期的に呼ばないよう、setTimeout で1拍ずらす
    const timer = setTimeout(() => {
      void runAll();
    }, 0);
    return () => clearTimeout(timer);
    // 画面を開いた時に1回だけ自動実行する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!emulatorConfig) {
    return (
      <View style={styles.container}>
        <Text>開発ビルドでのみ使えます</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>3-5a 技術検証: React Native Firebase + Emulator</Text>
      <Button title="もう一度実行(サインイン→書き込み→読み取り)" onPress={() => void runAll()} />
      <Text style={styles.title}>4-2c-0 技術検証: @react-native-firebase/functions</Text>
      <Button
        testID="dev-callable-verify-invalid-argument-button"
        title="Callable: verifyApplePurchase(ログイン済み・不正なtransactionId → invalid-argument)"
        onPress={() => void callVerifyApplePurchaseInvalidArgument()}
      />
      <Button
        testID="dev-callable-verify-unauthenticated-button"
        title="Callable: verifyApplePurchase(未ログイン → unauthenticated)"
        onPress={() => void callVerifyApplePurchaseUnauthenticated()}
      />
      {log.map((line) => (
        <Text key={line} style={styles.log} testID="dev-firebase-probe-log-line">
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
