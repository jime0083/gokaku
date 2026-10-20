import * as Apple from 'expo-apple-authentication';
import * as Auth from '@react-native-firebase/auth';

import { createAppleNonce } from '../appleNonce';
import { appleAccountAdapter } from '../appleAccountAdapter';

jest.mock('expo-apple-authentication', () => ({
  signInAsync: jest.fn(),
}));
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: jest.fn(),
  AppleAuthProvider: { credential: jest.fn() },
  reauthenticateWithCredential: jest.fn(),
  revokeToken: jest.fn(),
}));
jest.mock('@/config/firebase', () => ({
  connectFirebaseEmulatorsIfNeeded: jest.fn(),
}));
jest.mock('../appleNonce', () => ({
  createAppleNonce: jest.fn(),
}));

const UID = 'account-owner';
const ERROR_MESSAGE = 'apple-account-action-failed';
const NONCE = { rawNonce: 'mock-raw-nonce', hashedNonce: 'mock-hashed-nonce' };
const APPLE_RESPONSE = {
  user: 'mock-apple-user',
  identityToken: 'mock-identity-token',
  authorizationCode: 'mock-authorization-code',
  email: null,
  fullName: null,
  state: null,
  realUserStatus: 1,
};
const FIREBASE_CREDENTIAL = { providerId: 'apple.com' };

type TestUser = { uid: string };
let initialUser: TestUser;
let auth: { currentUser: TestUser | null };
let logSpies: jest.SpyInstance[];

beforeEach(() => {
  jest.resetAllMocks();
  initialUser = { uid: UID };
  auth = { currentUser: initialUser };
  jest.mocked(Auth.getAuth).mockReturnValue(auth as never);
  jest.mocked(createAppleNonce).mockResolvedValue({ ...NONCE });
  jest.mocked(Apple.signInAsync).mockResolvedValue({ ...APPLE_RESPONSE } as never);
  jest.mocked(Auth.AppleAuthProvider.credential)
    .mockReturnValue(FIREBASE_CREDENTIAL as never);
  jest.mocked(Auth.reauthenticateWithCredential).mockImplementation(async () => {
    // RNFB _setUserCredential replaces currentUser on successful reauthentication.
    const refreshedUser = { uid: UID };
    auth.currentUser = refreshedUser;
    return { user: refreshedUser } as never;
  });
  jest.mocked(Auth.revokeToken).mockResolvedValue(undefined);
  logSpies = (['log', 'warn', 'error', 'debug', 'info'] as const)
    .map((method) => jest.spyOn(console, method).mockImplementation(() => undefined));
});

afterEach(() => {
  try {
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of logSpies) spy.mockRestore();
  }
});

it('reauthenticates the bound user then revokes on the same Auth instance', async () => {
  await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
    .resolves.toBeUndefined();

  expect(Auth.getAuth).toHaveBeenCalledTimes(1);
  expect(createAppleNonce).toHaveBeenCalledTimes(1);
  expect(Apple.signInAsync).toHaveBeenCalledWith({ nonce: NONCE.hashedNonce });
  expect(Auth.AppleAuthProvider.credential)
    .toHaveBeenCalledWith(APPLE_RESPONSE.identityToken, NONCE.rawNonce);
  expect(Auth.reauthenticateWithCredential)
    .toHaveBeenCalledWith(initialUser, FIREBASE_CREDENTIAL);
  expect(Auth.revokeToken).toHaveBeenCalledWith(auth, APPLE_RESPONSE.authorizationCode);
  expect(Auth.reauthenticateWithCredential).toHaveBeenCalledTimes(1);
  expect(Auth.revokeToken).toHaveBeenCalledTimes(1);
  expect(jest.mocked(Auth.reauthenticateWithCredential).mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(Auth.revokeToken).mock.invocationCallOrder[0]);
});

it.each([null, { uid: 'different-user' }])(
  'rejects an initially missing or different user: %j',
  async (user) => {
    auth.currentUser = user;
    await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
      .rejects.toThrow(ERROR_MESSAGE);
    expect(createAppleNonce).not.toHaveBeenCalled();
    expect(Apple.signInAsync).not.toHaveBeenCalled();
    expect(Auth.revokeToken).not.toHaveBeenCalled();
  },
);

it('rejects an empty expected UID before requesting Apple authentication', async () => {
  await expect(appleAccountAdapter.reauthenticateAndRevoke(''))
    .rejects.toThrow(ERROR_MESSAGE);
  expect(createAppleNonce).not.toHaveBeenCalled();
  expect(Apple.signInAsync).not.toHaveBeenCalled();
});

describe.each(['nonce', 'apple', 'reauthenticate', 'revoke'] as const)(
  'user changes while awaiting %s',
  (stage) => {
    it.each([null, { uid: 'different-user' }])(
      'rejects after await with currentUser %j',
      async (replacement) => {
        if (stage === 'nonce') {
          jest.mocked(createAppleNonce).mockImplementationOnce(async () => {
            auth.currentUser = replacement;
            return { ...NONCE };
          });
        } else if (stage === 'apple') {
          jest.mocked(Apple.signInAsync).mockImplementationOnce(async () => {
            auth.currentUser = replacement;
            return { ...APPLE_RESPONSE } as never;
          });
        } else if (stage === 'reauthenticate') {
          jest.mocked(Auth.reauthenticateWithCredential)
            .mockImplementationOnce(async () => {
              auth.currentUser = replacement;
              return { user: { uid: UID } } as never;
            });
        } else {
          jest.mocked(Auth.revokeToken).mockImplementationOnce(async () => {
            auth.currentUser = replacement;
          });
        }

        await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
          .rejects.toThrow(ERROR_MESSAGE);

        if (stage === 'nonce') expect(Apple.signInAsync).not.toHaveBeenCalled();
        if (stage === 'nonce' || stage === 'apple') {
          expect(Auth.AppleAuthProvider.credential).not.toHaveBeenCalled();
          expect(Auth.reauthenticateWithCredential).not.toHaveBeenCalled();
        }
        if (stage !== 'revoke') expect(Auth.revokeToken).not.toHaveBeenCalled();
      },
    );
  },
);

it('uses the current same-UID SDK user at the reauthentication boundary', async () => {
  const currentSameUidUser = { uid: UID };
  jest.mocked(Apple.signInAsync).mockImplementationOnce(async () => {
    auth.currentUser = currentSameUidUser;
    return { ...APPLE_RESPONSE } as never;
  });

  await appleAccountAdapter.reauthenticateAndRevoke(UID);

  expect(jest.mocked(Auth.reauthenticateWithCredential).mock.calls[0][0])
    .toBe(currentSameUidUser);
  expect(Auth.revokeToken).toHaveBeenCalledWith(auth, APPLE_RESPONSE.authorizationCode);
});

it('rejects a different UID in the reauthentication result', async () => {
  jest.mocked(Auth.reauthenticateWithCredential)
    .mockResolvedValueOnce({ user: { uid: 'different-user' } } as never);

  await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
    .rejects.toThrow(ERROR_MESSAGE);
  expect(Auth.revokeToken).not.toHaveBeenCalled();
});

it.each([
  { identityToken: null },
  { identityToken: '' },
  { authorizationCode: null },
  { authorizationCode: '' },
])('rejects missing Apple credentials: %j', async (missing) => {
  jest.mocked(Apple.signInAsync)
    .mockResolvedValueOnce({ ...APPLE_RESPONSE, ...missing } as never);

  await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
    .rejects.toThrow(ERROR_MESSAGE);
  expect(Auth.AppleAuthProvider.credential).not.toHaveBeenCalled();
  expect(Auth.reauthenticateWithCredential).not.toHaveBeenCalled();
  expect(Auth.revokeToken).not.toHaveBeenCalled();
});

it.each([
  'nonce',
  'cancel',
  'apple',
  'credential',
  'reauthenticate',
  'revoke',
] as const)('sanitizes %s failures and permits a fresh retry', async (stage) => {
  const sensitiveError = Object.assign(
    new Error(`${NONCE.rawNonce} ${APPLE_RESPONSE.identityToken} ${APPLE_RESPONSE.authorizationCode}`),
    { code: stage === 'cancel' ? 'ERR_REQUEST_CANCELED' : 'mock-sdk-failure' },
  );

  if (stage === 'nonce') {
    jest.mocked(createAppleNonce).mockRejectedValueOnce(sensitiveError);
  } else if (stage === 'cancel' || stage === 'apple') {
    jest.mocked(Apple.signInAsync).mockRejectedValueOnce(sensitiveError);
  } else if (stage === 'credential') {
    jest.mocked(Auth.AppleAuthProvider.credential)
      .mockImplementationOnce(() => { throw sensitiveError; });
  } else if (stage === 'reauthenticate') {
    jest.mocked(Auth.reauthenticateWithCredential).mockRejectedValueOnce(sensitiveError);
  } else {
    jest.mocked(Auth.revokeToken).mockRejectedValueOnce(sensitiveError);
  }

  const error = await appleAccountAdapter.reauthenticateAndRevoke(UID)
    .then(() => undefined, (reason: unknown) => reason);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBe(sensitiveError);
  expect((error as Error).message).toBe(ERROR_MESSAGE);
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('code');
  if (stage !== 'revoke') expect(Auth.revokeToken).not.toHaveBeenCalled();

  const freshNonce = {
    rawNonce: 'mock-fresh-raw-nonce',
    hashedNonce: 'mock-fresh-hashed-nonce',
  };
  jest.mocked(createAppleNonce).mockResolvedValueOnce(freshNonce);

  await expect(appleAccountAdapter.reauthenticateAndRevoke(UID))
    .resolves.toBeUndefined();

  expect(createAppleNonce).toHaveBeenCalledTimes(2);
  expect(Apple.signInAsync).toHaveBeenLastCalledWith({ nonce: freshNonce.hashedNonce });
  expect(Auth.AppleAuthProvider.credential)
    .toHaveBeenLastCalledWith(APPLE_RESPONSE.identityToken, freshNonce.rawNonce);
  expect(Auth.revokeToken).toHaveBeenLastCalledWith(auth, APPLE_RESPONSE.authorizationCode);
});
