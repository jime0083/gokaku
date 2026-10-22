import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';
import { getCurrentUid } from '@/config/firebase';
import { GoalReplacementAuthError, replaceGoal as persistReplacement, type ReplaceGoalDeps, type ReplaceGoalResult } from './replaceGoal';
import type { OnboardingDraft } from '../onboarding/types';

type Ref = RNFBFirestore.DocumentReference<RNFBFirestore.DocumentData, RNFBFirestore.DocumentData>;

/** Lazy native adapter; auth is checked before SDK loading and every transaction attempt. */
export async function replaceGoal(
  expectedUid: string, expectedGoalId: string, draft: OnboardingDraft, now: number,
): Promise<ReplaceGoalResult> {
  if (!expectedUid || getCurrentUid() !== expectedUid) throw new GoalReplacementAuthError();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  const { getFirestore, doc, collection, runTransaction, serverTimestamp, Timestamp } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/firestore') as typeof RNFBFirestore;
  const db = getFirestore(getApp());
  const deps: ReplaceGoalDeps<Ref> = {
    history: {
      isTimestamp: (value) => value instanceof Timestamp,
      getEntryDocRef: (uid, revision) => doc(
        db, 'users', uid, 'judgementHistory', 'goal', 'entries', String(revision),
      ),
      serverTimestamp,
    },
    getCurrentUid,
    getUserDocRef: (uid) => doc(db, 'users', uid),
    getGoalDocRef: (uid, id) => doc(db, 'users', uid, 'goals', id),
    createGoalDocRef: (uid) => {
      const ref = doc(collection(db, 'users', uid, 'goals'));
      return { ref, id: ref.id };
    },
    runTransaction: (body) => runTransaction(db, (tx) => body({
      get: (ref) => tx.get(ref),
      set: (ref, data, options) => options ? tx.set(ref, data, options) : tx.set(ref, data),
      update: (ref, data) => tx.update(ref, data),
    })),
  };
  return persistReplacement(deps, { expectedUid, expectedGoalId, draft, now });
}
