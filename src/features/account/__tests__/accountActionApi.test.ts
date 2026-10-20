import * as App from '@react-native-firebase/app';
import * as Auth from '@react-native-firebase/auth';
import * as Functions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded } from '@/config/firebase';

import { callAccountAction } from '../accountActionApi';

jest.mock('@react-native-firebase/app', () => ({ getApp: jest.fn() }));
jest.mock('@react-native-firebase/auth', () => ({ getAuth: jest.fn(), getIdToken: jest.fn() }));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: jest.fn(), httpsCallable: jest.fn(),
}));
jest.mock('@/config/firebase', () => ({ connectFirebaseEmulatorsIfNeeded: jest.fn() }));

const UID = 'account-owner';
const ERROR = 'account-action-api-failed';
const app = { name: 'same-app' };
const functions = { app };
const callable = Object.assign(jest.fn(), { stream: jest.fn() });
let auth: { currentUser: { uid: string } | null };

beforeEach(() => {
  jest.resetAllMocks();
  auth = { currentUser: { uid: UID } };
  jest.mocked(App.getApp).mockReturnValue(app as never);
  jest.mocked(Auth.getAuth).mockReturnValue(auth as never);
  jest.mocked(Auth.getIdToken).mockResolvedValue('fresh-mock-id-token');
  jest.mocked(Functions.getFunctions).mockReturnValue(functions as never);
  jest.mocked(Functions.httpsCallable).mockReturnValue(callable);
  callable.mockImplementation(async ({ action }) => ({ data: { action, success: true } }));
});

it.each(['logout', 'delete'] as const)('binds %s to the same app and captured UID', async (action) => {
  await expect(callAccountAction(UID, action)).resolves.toBeUndefined();
  expect(connectFirebaseEmulatorsIfNeeded).toHaveBeenCalledTimes(1);
  expect(Auth.getAuth).toHaveBeenCalledWith(app);
  expect(Functions.getFunctions).toHaveBeenCalledWith(app, FUNCTIONS_REGION);
  expect(Functions.httpsCallable).toHaveBeenCalledWith(functions, 'authAccountAction');
  expect(callable).toHaveBeenCalledTimes(1);
  expect(callable).toHaveBeenCalledWith({ action, expectedUid: UID });
  if (action === 'delete') {
    expect(Auth.getIdToken).toHaveBeenCalledWith(auth.currentUser, true);
    expect(jest.mocked(Auth.getIdToken).mock.invocationCallOrder[0])
      .toBeLessThan(callable.mock.invocationCallOrder[0]);
  } else {
    expect(Auth.getIdToken).not.toHaveBeenCalled();
  }
});

it.each([null, { uid: 'other' }])('rejects an initial UID mismatch: %j', async (user) => {
  auth.currentUser = user;
  await expect(callAccountAction(UID, 'delete')).rejects.toThrow(ERROR);
  expect(Auth.getIdToken).not.toHaveBeenCalled();
  expect(callable).not.toHaveBeenCalled();
});

it.each(['', null, 123])('rejects invalid expectedUid %j', async (uid) => {
  await expect(callAccountAction(uid as string, 'logout')).rejects.toThrow(ERROR);
  expect(App.getApp).not.toHaveBeenCalled();
  expect(callable).not.toHaveBeenCalled();
});

it('rejects an invalid action before loading SDKs', async () => {
  await expect(callAccountAction(UID, 'other' as 'logout')).rejects.toThrow(ERROR);
  expect(App.getApp).not.toHaveBeenCalled();
});

it.each([null, { uid: 'other' }])('checks immediately before token refresh: %j', async (user) => {
  jest.mocked(Functions.httpsCallable).mockImplementationOnce(() => {
    auth.currentUser = user;
    return callable;
  });
  await expect(callAccountAction(UID, 'delete')).rejects.toThrow(ERROR);
  expect(Auth.getIdToken).not.toHaveBeenCalled();
  expect(callable).not.toHaveBeenCalled();
});

it.each([null, { uid: 'other' }])('checks immediately before logout send: %j', async (user) => {
  jest.mocked(Functions.httpsCallable).mockImplementationOnce(() => {
    auth.currentUser = user;
    return callable;
  });
  await expect(callAccountAction(UID, 'logout')).rejects.toThrow(ERROR);
  expect(callable).not.toHaveBeenCalled();
});

it.each([null, { uid: 'other' }])('rejects UID changes during refresh: %j', async (user) => {
  jest.mocked(Auth.getIdToken).mockImplementationOnce(async () => {
    auth.currentUser = user;
    return 'fresh-mock-id-token';
  });
  await expect(callAccountAction(UID, 'delete')).rejects.toThrow(ERROR);
  expect(callable).not.toHaveBeenCalled();
});

it('accepts a replaced same-UID SDK user after refresh', async () => {
  jest.mocked(Auth.getIdToken).mockImplementationOnce(async () => {
    auth.currentUser = { uid: UID };
    return 'fresh-mock-id-token';
  });
  await expect(callAccountAction(UID, 'delete')).resolves.toBeUndefined();
});

it.each(['logout', 'delete'] as const)('rejects UID changes during %s response', async (action) => {
  callable.mockImplementationOnce(async () => {
    auth.currentUser = { uid: 'other' };
    return { data: { action, success: true } };
  });
  await expect(callAccountAction(UID, action)).rejects.toThrow(ERROR);
});

it.each(['logout', 'delete'] as const)(
  'accepts verified %s success after auth disappears', async (action) => {
    callable.mockImplementationOnce(async () => {
      auth.currentUser = null;
      return { data: { action, success: true } };
    });
    await expect(callAccountAction(UID, action)).resolves.toBeUndefined();
    expect(callable).toHaveBeenCalledWith({ action, expectedUid: UID });
  },
);

it.each(['logout', 'delete'] as const)(
  'does not infer %s success from auth disappearing with an invalid response', async (action) => {
    const wrongAction = action === 'logout' ? 'delete' : 'logout';
    for (const data of [undefined, null, [], {}, { action },
      { action, success: false }, { action, success: 1 },
      { action, success: 'true' }, { action: wrongAction, success: true }]) {
      auth.currentUser = { uid: UID };
      callable.mockImplementationOnce(async () => {
        auth.currentUser = null;
        return { data };
      });
      await expect(callAccountAction(UID, action)).rejects.toThrow(ERROR);
    }
  },
);

it.each(['logout', 'delete'] as const)(
  'does not infer %s success from auth disappearing on HTTP failure', async (action) => {
    callable.mockImplementationOnce(async () => {
      auth.currentUser = null;
      throw new Error('mock-http-failure');
    });
    await expect(callAccountAction(UID, action)).rejects.toThrow(ERROR);
  },
);

it.each([undefined, null, [], {}, { action: 'logout' },
  { action: 'logout', success: false }, { action: 'logout', success: 1 },
  { action: 'logout', success: 'true' }, { action: 'delete', success: true },
])('strictly rejects malformed or wrong-action result: %j', async (data) => {
  callable.mockResolvedValueOnce({ data });
  await expect(callAccountAction(UID, 'logout')).rejects.toThrow(ERROR);
});

it.each(['', ' ', null])('rejects an invalid refreshed token %j', async (token) => {
  jest.mocked(Auth.getIdToken).mockResolvedValueOnce(token as string);
  await expect(callAccountAction(UID, 'delete')).rejects.toThrow(ERROR);
  expect(callable).not.toHaveBeenCalled();
});

it.each(['connect', 'auth', 'functions', 'factory', 'token', 'call'] as const)(
  'sanitizes %s errors without logging or returning secrets', async (stage) => {
    const secret = Object.assign(new Error('mock-secret-id-token'), { details: 'secret', code: 'secret' });
    const fail = () => { throw secret; };
    if (stage === 'connect') jest.mocked(connectFirebaseEmulatorsIfNeeded).mockImplementationOnce(fail);
    if (stage === 'auth') jest.mocked(Auth.getAuth).mockImplementationOnce(fail);
    if (stage === 'functions') jest.mocked(Functions.getFunctions).mockImplementationOnce(fail);
    if (stage === 'factory') jest.mocked(Functions.httpsCallable).mockImplementationOnce(fail);
    if (stage === 'token') jest.mocked(Auth.getIdToken).mockRejectedValueOnce(secret);
    if (stage === 'call') callable.mockRejectedValueOnce(secret);
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const)
      .map((method) => jest.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const error = await callAccountAction(UID, 'delete').catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(ERROR);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('code');
      expect(error).not.toHaveProperty('details');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  },
);

it('does not load native SDKs when importing the module', () => {
  jest.isolateModules(() => {
    for (const name of ['@react-native-firebase/app', '@react-native-firebase/auth',
      '@react-native-firebase/functions']) {
      jest.doMock(name, () => { throw new Error('eager native SDK load'); });
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(require('../accountActionApi').callAccountAction).toEqual(expect.any(Function));
    } finally {
      jest.dontMock('@react-native-firebase/app');
      jest.dontMock('@react-native-firebase/auth');
      jest.dontMock('@react-native-firebase/functions');
    }
  });
});
