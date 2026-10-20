import type * as RNFBAuth from '@react-native-firebase/auth';
import type * as ExpoApple from 'expo-apple-authentication';

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';

import { createAppleNonce } from './appleNonce';

const APPLE_ACCOUNT_ACTION_ERROR = 'apple-account-action-failed';

export type AppleAccountAdapter = Readonly<{
  reauthenticateAndRevoke: (expectedUid: string) => Promise<void>;
}>;

async function reauthenticateAndRevoke(expectedUid: string): Promise<void> {
  try {
    if (!expectedUid) throw new Error(APPLE_ACCOUNT_ACTION_ERROR);

    connectFirebaseEmulatorsIfNeeded();
    // Load native SDKs only when the adapter is invoked.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const authSdk = require('@react-native-firebase/auth') as typeof RNFBAuth;
    const auth = authSdk.getAuth();

    function boundUser() {
      const user = auth.currentUser;
      if (!user || user.uid !== expectedUid) {
        throw new Error(APPLE_ACCOUNT_ACTION_ERROR);
      }
      return user;
    }

    boundUser();
    const { rawNonce, hashedNonce } = await createAppleNonce();
    boundUser();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apple = require('expo-apple-authentication') as typeof ExpoApple;
    const { identityToken, authorizationCode } = await apple.signInAsync({
      nonce: hashedNonce,
    });
    boundUser();

    if (
      typeof identityToken !== 'string' ||
      identityToken.trim().length === 0 ||
      typeof authorizationCode !== 'string' ||
      authorizationCode.trim().length === 0
    ) {
      throw new Error(APPLE_ACCOUNT_ACTION_ERROR);
    }

    const credential = authSdk.AppleAuthProvider.credential(identityToken, rawNonce);
    // Use the current SDK User for this UID. RNFB may replace User objects.
    const result = await authSdk.reauthenticateWithCredential(boundUser(), credential);
    boundUser();
    if (result.user.uid !== expectedUid) {
      throw new Error(APPLE_ACCOUNT_ACTION_ERROR);
    }

    await authSdk.revokeToken(auth, authorizationCode);
    boundUser();
  } catch {
    // Never expose SDK errors, credentials, or cancellation details to callers.
    throw new Error(APPLE_ACCOUNT_ACTION_ERROR);
  }
}

export const appleAccountAdapter: AppleAccountAdapter = Object.freeze({
  reauthenticateAndRevoke,
});
