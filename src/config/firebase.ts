/**
 * React Native Firebase(ネイティブ SDK)の Emulator 接続(3-5a 技術検証)。
 * 開発ビルド(__DEV__)のときだけ Auth/Firestore を Emulator(demo-gokaku)につなぐ。
 * 本番ビルドでは getFirebaseEmulatorConfig が null を返すため何もしない。
 *
 * 注意(3-5a で確認): expo-router はルート一覧を作るために src/app/ 配下の全ファイルを
 * 起動時・Fast Refresh 時に読み込む(route のモジュールを評価する)。
 * @react-native-firebase/* をモジュールの先頭で import すると、ネイティブモジュール未搭載の
 * ビルド(このファイルを使う画面を一度も開いていない端末・まだ RNFB 未搭載の既存インストール)でも
 * 「Native module NativeRNFBTurboApp is not registered」で即クラッシュする。
 * そのため @react-native-firebase/* は実際に呼び出す関数の中でだけ require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBAuth from '@react-native-firebase/auth';
import type * as RNFBFirestore from '@react-native-firebase/firestore';
import type * as RNFBFunctions from '@react-native-firebase/functions';

import { getFirebaseEmulatorConfig } from './firebase-emulator';

let connected = false;

/**
 * 開発ビルドでのみ Auth/Firestore を Emulator に接続する。
 * 複数回呼んでも2回目以降は何もしない(SDK は同じ Emulator への再接続を許容しないため)。
 */
export function connectFirebaseEmulatorsIfNeeded(): void {
  const emulator = getFirebaseEmulatorConfig();
  if (!emulator || connected) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  const { connectAuthEmulator, getAuth } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/auth') as typeof RNFBAuth;
  const { connectFirestoreEmulator, getFirestore } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/firestore') as typeof RNFBFirestore;

  const { connectFunctionsEmulator, getFunctions } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/functions') as typeof RNFBFunctions;

  connectAuthEmulator(getAuth(getApp()), `http://${emulator.host}:${emulator.authPort}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(getFirestore(getApp()), emulator.host, emulator.firestorePort);
  connectFunctionsEmulator(
    getFunctions(getApp(), emulator.functionsRegion),
    emulator.host,
    emulator.functionsPort,
  );
  connected = true;
}

/**
 * 現在ログイン中のユーザーの uid を返す(ログインしていない場合は null)。
 * 購入時に appAccountToken(uid から決まる値)を渡すために使う(4-2c)。
 * @react-native-firebase/* はこのファイル先頭の注意と同じ理由で関数の中でだけ require する
 */
export function getCurrentUid(): string | null {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAuth } = require('@react-native-firebase/auth') as typeof RNFBAuth;
  return getAuth(getApp()).currentUser?.uid ?? null;
}
