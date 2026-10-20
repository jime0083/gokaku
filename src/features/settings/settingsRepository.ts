import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';
import { rememberCheckEnabledSetting } from '@/features/timer/lockscreenSync';

import { parseSettings, saveSettings, type LoadedSettings, type SettingsDraft } from './settings';

function sdk() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const firestore = require('@react-native-firebase/firestore') as typeof RNFBFirestore;
  return { ...firestore, db: firestore.getFirestore(getApp()) };
}

export async function loadSettings(): Promise<LoadedSettings> {
  const uid = getCurrentUid();
  if (!uid) throw new Error('ログインしていません');
  const { db, doc, getDoc } = sdk();
  const snapshot = await getDoc(doc(db, 'users', uid));
  if (!snapshot.exists()) throw new Error('ユーザーが存在しません');
  return { uid, ...parseSettings(snapshot.data() ?? {}) };
}

export async function updateSettings(expectedUid: string, draft: SettingsDraft): Promise<void> {
  return saveSettings({
    update: async (uid, patch) => {
      const { db, doc, updateDoc } = sdk();
      await updateDoc(doc(db, 'users', uid), patch);
    },
    remember: rememberCheckEnabledSetting,
  }, expectedUid, getCurrentUid, draft);
}
