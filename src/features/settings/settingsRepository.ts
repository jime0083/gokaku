import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';
import { isTimestampLike } from '@shared/judgementHistory';

import { getCurrentUid } from '@/config/firebase';
import { rememberCheckEnabledSetting } from '@/features/timer/lockscreenSync';

import { parseSettings, saveSettings, type LoadedSettings, type SettingsDraft } from './settings';

const JUDGEMENT_STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

function sdk() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const firestore = require('@react-native-firebase/firestore') as typeof RNFBFirestore;
  return { ...firestore, db: firestore.getFirestore(getApp()) };
}

function assertSettingsUid(uid: string): void {
  if (getCurrentUid() !== uid) throw new Error('ログイン状態が変わりました');
}

/** 両metadata absentだけがlegacy。部分metadataや不正counterは拒否する。 */
function settingsRevisions(
  user: Record<string, unknown>,
  isTimestamp: (value: unknown) => boolean,
): (Record<string, unknown> & { settings: number }) | null {
  const hasStartedAt = Object.prototype.hasOwnProperty.call(user, 'judgementHistoryStartedAt');
  const hasRevisions = Object.prototype.hasOwnProperty.call(user, 'judgementRevisions');
  if (!hasStartedAt && !hasRevisions) return null;

  const revisions = user.judgementRevisions;
  if (
    !hasStartedAt || !hasRevisions
    || !isTimestamp(user.judgementHistoryStartedAt)
    || !isTimestampLike(user.judgementHistoryStartedAt)
    || typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)
  ) {
    throw new Error('判定履歴のmetadataが不正です');
  }
  const counters = revisions as Record<string, unknown>;
  for (const stream of JUDGEMENT_STREAMS) {
    const revision = counters[stream];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error('判定履歴のrevisionが不正です');
    }
  }
  if (!Number.isSafeInteger((counters.settings as number) + 1)) {
    throw new Error('判定履歴のrevisionが上限に達しています');
  }
  return counters as Record<string, unknown> & { settings: number };
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
      assertSettingsUid(uid);
      const { db, doc, runTransaction, serverTimestamp, Timestamp } = sdk();
      const userRef = doc(db, 'users', uid);

      await runTransaction(db, async (tx) => {
        // SDK retryごとにUID・現在設定・counterを読み直す。
        assertSettingsUid(uid);
        const snapshot = await tx.get(userRef);
        assertSettingsUid(uid);
        const user = snapshot.exists() ? snapshot.data() : undefined;
        if (!user) throw new Error('ユーザーが存在しません');
        if (user.deletionInProgress === true) throw new Error('アカウントを削除中です');

        const revisions = settingsRevisions(user, (value) => value instanceof Timestamp);
        if (!revisions) {
          assertSettingsUid(uid);
          tx.update(userRef, patch);
          return;
        }
        // 初期化済みの履歴には、load時のdefaultでなく保存時の実値を使う。
        if (typeof user.xPostEnabled !== 'boolean') {
          throw new Error('判定履歴の設定snapshotが不正です');
        }
        const revision = revisions.settings + 1;
        const entry = {
          schemaVersion: 1,
          revision,
          committedAt: serverTimestamp(),
          before: { xPostEnabled: user.xPostEnabled },
          after: { xPostEnabled: patch.xPostEnabled },
        };

        assertSettingsUid(uid);
        tx.update(userRef, {
          ...patch,
          judgementRevisions: { ...revisions, settings: revision },
        });
        tx.set(doc(
          db, 'users', uid, 'judgementHistory', 'settings', 'entries', String(revision),
        ), entry);
      });
    },
    remember: rememberCheckEnabledSetting,
  }, expectedUid, getCurrentUid, draft);
}
