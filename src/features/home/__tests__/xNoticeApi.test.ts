import { FUNCTIONS_REGION } from '@shared/index';

const mockNativeLoad = jest.fn();
const mockGetApp = jest.fn(() => ({}));
const mockGetFunctions = jest.fn(() => ({}));
const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn(() => mockCallable);
const mockConnect = jest.fn();
const mockGetUid = jest.fn<string | null, []>(() => 'owner');

jest.mock('@react-native-firebase/app', () => {
  mockNativeLoad();
  return { getApp: mockGetApp };
});
jest.mock('@react-native-firebase/functions', () => {
  mockNativeLoad();
  return { getFunctions: mockGetFunctions, httpsCallable: mockHttpsCallable };
});
jest.mock('@/config/firebase', () => ({
  connectFirebaseEmulatorsIfNeeded: mockConnect,
  getCurrentUid: mockGetUid,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createXNoticeApi, xNoticeApi } = require('../xNoticeApi') as typeof import('../xNoticeApi');
const ID = 'a'.repeat(64);
const FAILURE = 'x-notice-api-failed';

it('constructs without loading native modules, connecting emulators or reading auth', () => {
  createXNoticeApi({ call: jest.fn(), getUid: jest.fn() });
  expect(mockNativeLoad).not.toHaveBeenCalled();
  expect(mockGetUid).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
});

it.each(['acknowledged', 'unchanged'] as const)('sends only noticeId and returns %s without extra response data', async (status) => {
  const call = jest.fn().mockResolvedValue({ status, privateDetail: 'do-not-return' });
  const api = createXNoticeApi({ call, getUid: () => 'owner' });
  await expect(api.ack(ID)).resolves.toEqual({ status });
  expect(call.mock.calls).toEqual([[{ noticeId: ID }]]);
});

it('rejects invalid notice IDs before transport', async () => {
  const call = jest.fn();
  const api = createXNoticeApi({ call, getUid: () => 'owner' });
  const invalid: unknown[] = [undefined, null, {}, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ID + '\n'];
  for (const id of invalid) {
    await expect(api.ack(id as string)).rejects.toThrow(FAILURE);
  }
  expect(call).not.toHaveBeenCalled();
});

it.each([null, '', ' '])('blocks unauthenticated or empty identity %s', async (uid) => {
  const call = jest.fn();
  await expect(createXNoticeApi({ call, getUid: () => uid }).ack(ID)).rejects.toThrow(FAILURE);
  expect(call).not.toHaveBeenCalled();
});

it.each(['other-owner', null])('rejects an identity change to %s while awaiting the callable', async (nextUid) => {
  let uid: string | null = 'owner';
  const call = jest.fn(async () => {
    uid = nextUid;
    return { status: 'acknowledged' };
  });
  await expect(createXNoticeApi({ call, getUid: () => uid }).ack(ID)).rejects.toThrow(FAILURE);
  expect(call).toHaveBeenCalledTimes(1);
});

it('rejects malformed response envelopes and unknown status values', async () => {
  const invalid: unknown[] = [undefined, null, [], true, 'acknowledged', {}, { status: true }, { status: 'pending' }];
  for (const response of invalid) {
    const api = createXNoticeApi({ call: async () => response, getUid: () => 'owner' });
    await expect(api.ack(ID)).rejects.toThrow(FAILURE);
  }
});

it('replaces transport and identity exceptions with a generic error without cause', async () => {
  const privateError = new Error('private-sdk-detail');
  const apis = [
    createXNoticeApi({ call: jest.fn().mockRejectedValue(privateError), getUid: () => 'owner' }),
    createXNoticeApi({ call: jest.fn(), getUid: () => { throw privateError; } }),
  ];
  for (const api of apis) {
    const error: unknown = await api.ack(ID).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error(FAILURE));
    expect(error).not.toBe(privateError);
    expect(error).not.toHaveProperty('cause');
  }
});

it('lazily calls regional RNFB ackXNotice after emulator connection and unwraps data', async () => {
  jest.clearAllMocks();
  mockGetUid.mockReturnValue('owner');
  mockCallable.mockResolvedValue({ data: { status: 'acknowledged' } });
  await expect(xNoticeApi.ack(ID)).resolves.toEqual({ status: 'acknowledged' });
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockGetFunctions).toHaveBeenCalledWith({}, FUNCTIONS_REGION);
  expect(mockHttpsCallable).toHaveBeenCalledWith({}, 'ackXNotice');
  expect(mockCallable).toHaveBeenCalledWith({ noticeId: ID });
  expect(mockConnect.mock.invocationCallOrder[0]).toBeLessThan(mockCallable.mock.invocationCallOrder[0]);
  mockGetUid.mockReturnValueOnce('owner').mockReturnValueOnce('other-owner');
  await expect(xNoticeApi.ack(ID)).rejects.toThrow(FAILURE);
});
