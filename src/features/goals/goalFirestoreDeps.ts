/**
 * saveGoal(saveGoal.ts)が必要とする Firestore 操作を、実機で使う
 * @react-native-firebase/firestore(ネイティブ SDK)で満たすアダプタ(3-5c-2 で画面から呼ぶ)。
 *
 * firebase.ts と同じ理由で、@react-native-firebase/* はこの関数の内側でだけ require する
 * (モジュールの先頭で import すると、ネイティブモジュール未搭載のビルドでも
 * 「Native module ... is not registered」で即クラッシュするため)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import type { SaveGoalFirestoreDeps, SaveGoalHistoryDeps } from './saveGoal';

type Ref = RNFBFirestore.DocumentReference<RNFBFirestore.DocumentData, RNFBFirestore.DocumentData>;

/** 本番・開発ビルドで使う SaveGoalFirestoreDeps(Emulator 接続は firebase.ts が別途行う) */
export function createGoalFirestoreDeps(): SaveGoalFirestoreDeps<Ref> & {
  history: SaveGoalHistoryDeps<Ref>;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  const { getFirestore, doc, collection, runTransaction, serverTimestamp, Timestamp } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/firestore') as typeof RNFBFirestore;

  const firestore = getFirestore(getApp());

  return {
    history: {
      isTimestamp: (value) => value instanceof Timestamp,
      getEntryDocRef: (uid, revision) =>
        doc(firestore, 'users', uid, 'judgementHistory', 'goal', 'entries', String(revision)),
      serverTimestamp,
    },
    getUserDocRef: (uid) => doc(firestore, 'users', uid),
    createGoalDocRef: (uid) => {
      const ref = doc(collection(firestore, 'users', uid, 'goals'));
      return { ref, id: ref.id };
    },
    runTransaction: (updateFunction) =>
      runTransaction(firestore, (transaction) =>
        updateFunction({
          get: (ref) => transaction.get(ref),
          set: (ref, data, options) =>
            options ? transaction.set(ref, data, options) : transaction.set(ref, data),
        }),
      ),
  };
}
