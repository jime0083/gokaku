import type { CallableRequest } from 'firebase-functions/v2/https';

import { handleAuthAccountActionRequest } from '../authAccountAction';
import type { AccountAction, AccountActionDeps } from '../accountAction';

const UID = 'bound-account';
const NOW = Date.UTC(2026, 9, 19);
let deps: AccountActionDeps;

beforeEach(() => {
  deps = {
    now: jest.fn(() => NOW),
    beginDeletion: jest.fn(async () => undefined),
    revokeDeviceToken: jest.fn(async () => undefined),
    deleteRelatedData: jest.fn(async () => undefined),
    deleteAuthUser: jest.fn(async () => undefined),
  };
});

function request(data: unknown): Pick<CallableRequest<unknown>, 'auth' | 'data'> {
  return {
    auth: {
      uid: UID, rawToken: '',
      token: { auth_time: NOW / 1000, firebase: { sign_in_provider: 'apple.com' } } as never,
    },
    data,
  };
}

function expectNoEffects() {
  expect(deps.beginDeletion).not.toHaveBeenCalled();
  expect(deps.revokeDeviceToken).not.toHaveBeenCalled();
  expect(deps.deleteRelatedData).not.toHaveBeenCalled();
  expect(deps.deleteAuthUser).not.toHaveBeenCalled();
}

it.each(['logout', 'delete'] as AccountAction[])(
  'accepts bound and legacy %s calls and always targets auth.uid', async (action) => {
    for (const data of [{ action }, { action, expectedUid: UID }]) {
      await expect(handleAuthAccountActionRequest(request(data), deps))
        .resolves.toEqual({ action, success: true });
    }
    expect(deps.revokeDeviceToken).toHaveBeenCalledTimes(2);
    expect(deps.revokeDeviceToken).toHaveBeenCalledWith(UID);
    if (action === 'delete') {
      for (const fn of [deps.beginDeletion, deps.deleteRelatedData, deps.deleteAuthUser]) {
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenCalledWith(UID);
      }
    } else {
      expect(deps.beginDeletion).not.toHaveBeenCalled();
      expect(deps.deleteRelatedData).not.toHaveBeenCalled();
      expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    }
  },
);

it.each(['logout', 'delete'] as AccountAction[])(
  'rejects invalid binding before any %s side effect', async (action) => {
    for (const expectedUid of [undefined, null, 123, true, {}, [], '', 'other-account']) {
      await expect(handleAuthAccountActionRequest(request({ action, expectedUid }), deps))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      expectNoEffects();
    }
  },
);

it.each([
  null, [], {}, { action: 'other' },
  { action: 'logout', uid: UID },
  { action: 'delete', expectedUid: UID, uid: UID },
  { action: 'delete', expectedUid: UID, appleCode: 'mock-secret' },
])('retains unknown-key and shape rejection: %j', async (data) => {
  await expect(handleAuthAccountActionRequest(request(data), deps))
    .rejects.toMatchObject({ code: 'invalid-argument' });
  expectNoEffects();
});

it('rejects unauthenticated bound calls', async () => {
  await expect(handleAuthAccountActionRequest({
    auth: undefined, data: { action: 'delete', expectedUid: UID },
  }, deps)).rejects.toMatchObject({ code: 'unauthenticated' });
  expectNoEffects();
});

it.each([
  { auth_time: NOW / 1000 - 300 },
  { auth_time: NOW / 1000 + 1 },
  { firebase: { sign_in_provider: 'custom' } },
])('retains recent Apple auth enforcement with binding: %j', async (claims) => {
  const req = request({ action: 'delete', expectedUid: UID });
  Object.assign(req.auth!.token, claims);
  await expect(handleAuthAccountActionRequest(req, deps)).rejects.toBeInstanceOf(Error);
  expectNoEffects();
});

it('sanitizes dependency errors for bound calls', async () => {
  jest.mocked(deps.revokeDeviceToken).mockRejectedValueOnce(new Error('mock-secret'));
  const error = await handleAuthAccountActionRequest(request({
    action: 'logout', expectedUid: UID,
  }), deps).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'internal' });
  expect((error as Error).message).not.toContain('mock-secret');
});
