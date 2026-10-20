import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBAuth from '@react-native-firebase/auth';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';

import type { AccountAction } from './accountActionFlow';

const ACCOUNT_ACTION_API_ERROR = 'account-action-api-failed';

/** The delete caller must finish Apple reauthentication/revocation before this call. */
export async function callAccountAction(expectedUid: string, action: AccountAction): Promise<void> {
  try {
    if (typeof expectedUid !== 'string' || expectedUid.length === 0 ||
      (action !== 'logout' && action !== 'delete')) {
      throw new Error(ACCOUNT_ACTION_API_ERROR);
    }
    connectFirebaseEmulatorsIfNeeded();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuth, getIdToken } = require('@react-native-firebase/auth') as typeof RNFBAuth;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;
    const app = getApp();
    const auth = getAuth(app);

    function boundUser() {
      const user = auth.currentUser;
      if (!user || user.uid !== expectedUid) throw new Error(ACCOUNT_ACTION_API_ERROR);
      return user;
    }

    boundUser();
    const callable = httpsCallable(getFunctions(app, FUNCTIONS_REGION), 'authAccountAction');
    if (action === 'delete') {
      // Refresh only after the caller's Apple reauthentication, never reuse a cached ID token.
      const token = await getIdToken(boundUser(), true);
      boundUser();
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error(ACCOUNT_ACTION_API_ERROR);
      }
    }
    boundUser();
    // Native SDK auth can change after JS checks; the server validates this captured UID.
    const result = await callable({ action, expectedUid });
    const data: unknown = result?.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data) ||
      !('action' in data) || data.action !== action ||
      !('success' in data) || data.success !== true) {
      throw new Error(ACCOUNT_ACTION_API_ERROR);
    }
    // Verified server success permits auth disappearance, never a different account.
    const user = auth.currentUser;
    if (user !== null && user.uid !== expectedUid) {
      throw new Error(ACCOUNT_ACTION_API_ERROR);
    }
  } catch {
    // Do not propagate SDK error messages, details, tokens or causes.
    throw new Error(ACCOUNT_ACTION_API_ERROR);
  }
}
