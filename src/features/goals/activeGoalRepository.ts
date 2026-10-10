/**
 * 有効な目標(users/{uid}.activeGoalId が指す goal)を読む(5-1a・5-1b-2)。
 * タイマー画面(src/app/(tabs)/timer.tsx)・送信層(src/features/timer/studyEventSender.ts)は
 * このモジュールの関数だけを呼び、@react-native-firebase/firestore を直接呼ばない
 * (テストで jest.mock に差し替えられるようにする)。
 *
 * src/config/firebase.ts と同じ理由(expo-router が src/app/ 配下の全ファイルを起動時に読み込むため)で、
 * @react-native-firebase/* は実際に呼び出す関数の中でだけ require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';

export type ActiveGoalDailyTargets = {
  minDailyMinutes: number;
  goalDailyMinutes: number;
};

/**
 * ログインしていない・users/{uid}.activeGoalId が設定されていない場合は null を返す。
 * 送信層(studyEventSender.ts)が recordStudyEvent に渡す goalId を得るために使う
 * (実際のユーザーには起きない。未ログイン・目標なしのときは送信せず列に残す)
 */
export async function fetchActiveGoalId(): Promise<string | null> {
  const uid = getCurrentUid();
  if (!uid) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    const { getFirestore, doc, getDoc } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/firestore') as typeof RNFBFirestore;

    const firestore = getFirestore(getApp());
    const userSnapshot = await getDoc(doc(firestore, 'users', uid));
    const activeGoalId = userSnapshot.exists()
      ? (userSnapshot.data()?.activeGoalId as unknown)
      : null;
    if (typeof activeGoalId !== 'string' || activeGoalId.length === 0) {
      return null;
    }
    return activeGoalId;
  } catch {
    return null;
  }
}

/**
 * ログインしていない・有効な目標がない・目標ドキュメントが読めない(値の形が不正)・
 * 通信エラー等で読み込みに失敗した場合は null を返す。
 * 実際のユーザーには起きない(オンボーディングと課金の後にしかタイマー画面に来ないため)。
 * 開発用のフォールバックとして、呼び出し側(タイマー画面)は null のとき「目標未設定」と表示する
 * (未処理の Promise rejection でアプリの開発ビルドにエラー表示が出ないよう、ここで catch する)
 */
export async function fetchActiveGoalDailyTargets(): Promise<ActiveGoalDailyTargets | null> {
  const uid = getCurrentUid();
  if (!uid) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    const { getFirestore, doc, getDoc } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/firestore') as typeof RNFBFirestore;

    const firestore = getFirestore(getApp());

    const userSnapshot = await getDoc(doc(firestore, 'users', uid));
    const activeGoalId = userSnapshot.exists()
      ? (userSnapshot.data()?.activeGoalId as unknown)
      : null;
    if (typeof activeGoalId !== 'string' || activeGoalId.length === 0) {
      return null;
    }

    const goalSnapshot = await getDoc(doc(firestore, 'users', uid, 'goals', activeGoalId));
    if (!goalSnapshot.exists()) {
      return null;
    }
    const data = goalSnapshot.data();
    const minDailyMinutes = data?.minDailyMinutes;
    const goalDailyMinutes = data?.goalDailyMinutes;
    if (typeof minDailyMinutes !== 'number' || typeof goalDailyMinutes !== 'number') {
      return null;
    }
    return { minDailyMinutes, goalDailyMinutes };
  } catch {
    return null;
  }
}
