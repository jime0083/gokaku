import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBAuth from '@react-native-firebase/auth';
import type * as RNFBFirestore from '@react-native-firebase/firestore';

import { connectFirebaseEmulatorsIfNeeded, getCurrentUid } from '@/config/firebase';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';

import { normalizeSubscription, resolveSubscriptionAccess } from './subscriptionAccess';
import {
  parseSubscriptionCache, subscriptionCacheKey, type SubscriptionSnapshot,
} from './subscriptionCache';

export type SubscriptionSession = Readonly<{
  uid: string;
  registered: boolean;
  xLinked: boolean;
  access: 'allowed' | 'locked';
}>;

const generations = new Map<string, number>();
const cacheWrites = new Map<string, Promise<void>>();

function readServer(uid: string): Promise<RNFBFirestore.DocumentSnapshot> {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  const { getFirestore, doc, getDocFromServer } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/firestore') as typeof RNFBFirestore;
  return getDocFromServer(doc(getFirestore(getApp()), 'users', uid));
}

export async function loadSubscriptionSession(
  expectedUid: string,
  now: number,
): Promise<SubscriptionSession> {
  const key = subscriptionCacheKey(expectedUid);
  const generation = (generations.get(expectedUid) ?? 0) + 1;
  generations.set(expectedUid, generation);
  const session = await accountOperationGate.runNormal<SubscriptionSession>(expectedUid, async (lease) => {
    const assertCurrent = () => {
      lease.assertCurrentUid();
      if (getCurrentUid() !== expectedUid) throw new Error('subscription-uid-changed');
    };
    // Keep the admitted root alive through the queue and the actual storage await.
    const updateCache = async (write: () => Promise<void>): Promise<void> => {
      assertCurrent();
      const pending = (cacheWrites.get(expectedUid) ?? Promise.resolve()).then(async () => {
        assertCurrent();
        if (generations.get(expectedUid) !== generation) return;
        try {
          await write();
        } catch {
          // Storage failure never replaces the fresh server decision with old cache.
        } finally {
          assertCurrent();
        }
      });
      cacheWrites.set(expectedUid, pending.catch(() => undefined));
      try {
        await pending;
      } finally {
        assertCurrent();
      }
    };

    let raw: string | null = null;
    assertCurrent();
    try {
      raw = await AsyncStorage.getItem(key);
    } catch {
      // An unreadable cache is unknown; still attempt the server.
    } finally {
      assertCurrent();
    }
    const cached = raw === null ? null : parseSubscriptionCache(key, raw);
    let remote: RNFBFirestore.DocumentSnapshot | null = null;
    assertCurrent();
    try {
      remote = await readServer(expectedUid);
    } catch {
      // Only a failed server read permits fallback to the validated own-UID cache.
    } finally {
      assertCurrent();
    }
    if (remote === null) {
      const result = resolveSubscriptionAccess({
        uid: expectedUid, read: { kind: 'unavailable' }, cache: cached, now,
      });
      return {
        uid: expectedUid,
        registered: cached?.registered ?? true,
        xLinked: cached?.xLinked ?? false,
        access: result.access,
      };
    }
    if (!remote.exists()) {
      await updateCache(() => AsyncStorage.removeItem(key));
      assertCurrent();
      return { uid: expectedUid, registered: false, xLinked: false, access: 'locked' };
    }
    const user = remote.data() ?? {};
    const snapshot: SubscriptionSnapshot = {
      version: 1,
      uid: expectedUid,
      registered: typeof user.activeGoalId === 'string' && user.activeGoalId.trim().length > 0,
      xLinked: user.xLinked === true,
      subscription: normalizeSubscription(user.subscription),
    };
    const result = resolveSubscriptionAccess({
      uid: expectedUid,
      read: { kind: 'success', uid: expectedUid, subscription: snapshot.subscription },
      cache: cached,
      now,
    });
    await updateCache(() => AsyncStorage.setItem(key, JSON.stringify(snapshot)));
    assertCurrent();
    return {
      uid: expectedUid, registered: snapshot.registered,
      xLinked: snapshot.xLinked, access: result.access,
    };
  });
  if (getCurrentUid() !== expectedUid) throw new Error('subscription-uid-changed');
  return session;
}

/** Return the SDK unsubscribe itself; native initialization occurs only on invocation. */
export function subscribeSubscriptionAuth(callback: (uid: string | null) => void): () => void {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  const { getAuth, onAuthStateChanged } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-firebase/auth') as typeof RNFBAuth;
  return onAuthStateChanged(getAuth(getApp()), (user) => callback(user?.uid ?? null));
}
