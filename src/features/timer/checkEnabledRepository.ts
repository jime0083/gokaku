/**
 * 「勉強中？」確認の ON/OFF(users/{uid}.checkEnabled)を読む(5-2b。requirements 3-2)。
 * activeGoalRepository.ts と同じ理由(expo-router が src/app/ 配下の全ファイルを起動時に読み込むため)で、
 * @react-native-firebase/* は実際に呼び出す関数の中でだけ require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';

/**
 * 値がない(未設定)・読めない(未ログイン・通信エラー等)場合は初期値の ON(true)を返す
 * (requirements 3-2「勉強中？」確認(初期値ON)。useTimerSession の start が計測開始時に呼ぶ
 */
export async function fetchCheckEnabled(): Promise<boolean> {
  const uid = getCurrentUid();
  if (!uid) {
    return true;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    const { getFirestore, doc, getDoc } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/firestore') as typeof RNFBFirestore;

    const firestore = getFirestore(getApp());
    const snapshot = await getDoc(doc(firestore, 'users', uid));
    const checkEnabled = snapshot.exists() ? (snapshot.data()?.checkEnabled as unknown) : undefined;
    return typeof checkEnabled === 'boolean' ? checkEnabled : true;
  } catch {
    return true;
  }
}
