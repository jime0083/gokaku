const mockNativeLoad = jest.fn();
const mockGetApp = jest.fn(() => ({}));
const mockGetFunctions = jest.fn(() => ({}));
const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn(() => mockCallable);
const mockConnect = jest.fn();
const mockGetUid = jest.fn<string | null, []>(() => 'user-a');

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

// Require after mock initialization, matching the existing billing tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createXLinkApi, xLinkApi } = require('../xLinkApi') as typeof import('../xLinkApi');
type Api = ReturnType<typeof createXLinkApi>;
const FAILURE = 'x-link-api-failed';
const candidate = {
  candidateId: 'candidate-1',
  profile: { id: '123', username: 'student', profileImageUrl: null },
  expiresAt: 1800000000000,
};
const cases: {
  request: import('../xLinkApi').XLinkRequest;
  response: object;
  run: (api: Api) => Promise<unknown>;
}[] = [
  { request: { action: 'begin' }, response: { authorizationUrl: 'browser-validates-url' }, run: (api) => api.begin() },
  { request: { action: 'complete', state: 'state', code: 'code' }, response: { candidateId: 'candidate-1' }, run: (api) => api.complete('state', 'code') },
  { request: { action: 'pending' }, response: { pending: candidate }, run: (api) => api.getPending() },
  { request: { action: 'confirm', candidateId: 'candidate-1', postEnabled: false }, response: { ok: true }, run: (api) => api.confirm('candidate-1', false) },
  { request: { action: 'discard', candidateId: 'candidate-1' }, response: { ok: true }, run: (api) => api.discard('candidate-1') },
];

describe('xLinkApi', () => {
  it('imports and constructs without loading native modules or reading auth', () => {
    createXLinkApi({ call: jest.fn(), getUid: jest.fn() });
    expect(mockNativeLoad).not.toHaveBeenCalled();
    expect(mockGetUid).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('sends exact requests and returns only contracted fields for every action', async () => {
    for (const { request, response, run } of cases) {
      const call = jest.fn().mockResolvedValue({ ...response, accessToken: 'secret' });
      const getUid = jest.fn(() => 'user-a');
      await expect(run(createXLinkApi({ call, getUid }))).resolves.toEqual(response);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(request);
      expect(getUid).toHaveBeenCalledTimes(2);
    }
    const call = jest.fn().mockResolvedValue({ ok: true });
    await createXLinkApi({ call, getUid: () => 'user-a' }).confirm('candidate-1', true);
    expect(call).toHaveBeenCalledWith({ action: 'confirm', candidateId: 'candidate-1', postEnabled: true });
  });

  it('blocks every action when unauthenticated', async () => {
    for (const { run } of cases) {
      const call = jest.fn();
      await expect(run(createXLinkApi({ call, getUid: () => null }))).rejects.toThrow(FAILURE);
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('rejects account changes and logout during every action', async () => {
    for (const { run, response } of cases) {
      for (const nextUid of ['user-b', null]) {
        let uid: string | null = 'user-a';
        const call = async () => { uid = nextUid; return response; };
        await expect(run(createXLinkApi({ call, getUid: () => uid }))).rejects.toThrow(FAILURE);
      }
    }
  });

  it('captures a fresh UID on each call', async () => {
    let uid = 'user-a';
    const api = createXLinkApi({ call: async () => ({ pending: null }), getUid: () => uid });
    await expect(api.getPending()).resolves.toEqual({ pending: null });
    uid = 'user-b';
    await expect(api.getPending()).resolves.toEqual({ pending: null });
  });

  it('copies the minimal profile, permits null images, and drops token fields', async () => {
    for (const profileImageUrl of [null, 'https://images.example/avatar.png']) {
      const profile = { ...candidate.profile, profileImageUrl, accessToken: 'secret' };
      const value = { ...candidate, profile, refreshToken: 'secret' };
      const api = createXLinkApi({ call: async () => ({ pending: value }), getUid: () => 'user-a' });
      const result = await api.getPending();
      expect(result).toEqual({ pending: { ...candidate, profile: { ...candidate.profile, profileImageUrl } } });
      profile.username = 'changed';
      expect(result.pending?.profile.username).toBe('student');
    }
  });

  it('rejects malformed JSON response envelopes and success fields', async () => {
    for (const value of [null, undefined, [], true, 'response', {}]) {
      for (const { run } of cases) {
        await expect(run(createXLinkApi({ call: async () => value, getUid: () => 'user-a' }))).rejects.toThrow(FAILURE);
      }
    }
    for (const ok of [false, 1, 'true', null]) {
      const api = createXLinkApi({ call: async () => ({ ok }), getUid: () => 'user-a' });
      await expect(api.confirm('candidate-1', true)).rejects.toThrow(FAILURE);
      await expect(api.discard('candidate-1')).rejects.toThrow(FAILURE);
    }
    for (const authorizationUrl of ['', ' ', 42, null]) {
      const api = createXLinkApi({ call: async () => ({ authorizationUrl }), getUid: () => 'user-a' });
      await expect(api.begin()).rejects.toThrow(FAILURE);
    }
  });

  it('rejects malformed pending profiles and unsafe expiry values', async () => {
    const values: unknown[] = [
      undefined, [], {},
      ...[NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 8640000000000001, '1800000000000']
        .map((expiresAt) => ({ ...candidate, expiresAt })),
      ...[null, {}, { ...candidate.profile, id: 123 }, { ...candidate.profile, id: '' },
        { ...candidate.profile, username: false }, { ...candidate.profile, username: '' },
        { ...candidate.profile, profileImageUrl: undefined }, { ...candidate.profile, profileImageUrl: 123 }]
        .map((profile) => ({ ...candidate, profile })),
    ];
    for (const pending of values) {
      const api = createXLinkApi({ call: async () => ({ pending }), getUid: () => 'user-a' });
      await expect(api.getPending()).rejects.toThrow(FAILURE);
    }
  });

  it('rejects unsafe candidate IDs in responses and outgoing requests', async () => {
    for (const id of ['', ' ', '../id', '__reserved__', 'a/b', 'a\n', 'a'.repeat(1501)]) {
      const call = jest.fn().mockResolvedValue({ candidateId: id });
      const api = createXLinkApi({ call, getUid: () => 'user-a' });
      await expect(api.complete('state', 'code')).rejects.toThrow(FAILURE);
      call.mockResolvedValue({ pending: { ...candidate, candidateId: id } });
      await expect(api.getPending()).rejects.toThrow(FAILURE);
      call.mockClear();
      await expect(api.confirm(id, true)).rejects.toThrow(FAILURE);
      await expect(api.discard(id)).rejects.toThrow(FAILURE);
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid callback inputs and nonboolean permission before transport', async () => {
    const call = jest.fn();
    const api = createXLinkApi({ call, getUid: () => 'user-a' });
    await expect(api.complete('', 'code')).rejects.toThrow(FAILURE);
    await expect(api.complete('state', '')).rejects.toThrow(FAILURE);
    await expect(api.complete('state', 'x'.repeat(4097))).rejects.toThrow(FAILURE);
    await expect(api.confirm('candidate-1', 'true' as unknown as boolean)).rejects.toThrow(FAILURE);
    expect(call).not.toHaveBeenCalled();
  });

  it('redacts transport/auth errors without logging callback or token data', async () => {
    const logs = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    try {
      for (const { run } of cases) {
        const secret = new Error('code=private state=private access_token=private');
        const api = createXLinkApi({ call: jest.fn().mockRejectedValue(secret), getUid: () => 'user-a' });
        await expect(run(api)).rejects.toEqual(new Error(FAILURE));
        try { await run(api); } catch (error) {
          expect(error).not.toBe(secret);
          expect(error).not.toHaveProperty('cause');
        }
      }
      const api = createXLinkApi({ call: jest.fn(), getUid: () => { throw new Error('private'); } });
      await expect(api.begin()).rejects.toEqual(new Error(FAILURE));
      logs.forEach((log) => expect(log).not.toHaveBeenCalled());
    } finally {
      logs.forEach((log) => log.mockRestore());
    }
  });

  it('lazily uses regional RNFB xAuthorization and guards the native session', async () => {
    jest.clearAllMocks();
    mockGetUid.mockReturnValue('user-a');
    for (const { run, request, response } of cases) {
      mockCallable.mockResolvedValue({ data: response });
      await expect(run(xLinkApi)).resolves.toEqual(response);
      expect(mockCallable).toHaveBeenLastCalledWith(request);
    }
    expect(mockConnect).toHaveBeenCalled();
    expect(mockGetFunctions).toHaveBeenCalledWith({}, 'asia-northeast1');
    expect(mockHttpsCallable).toHaveBeenCalledWith({}, 'xAuthorization');
    mockGetUid.mockReturnValueOnce('user-a').mockReturnValueOnce('user-b');
    mockCallable.mockResolvedValue({ data: { authorizationUrl: 'url' } });
    await expect(xLinkApi.begin()).rejects.toThrow(FAILURE);
    mockGetUid.mockReturnValue('user-a');
    mockCallable.mockResolvedValue(null);
    await expect(xLinkApi.begin()).rejects.toThrow(FAILURE);
    mockCallable.mockClear();
    mockGetUid.mockReturnValue(null);
    await expect(xLinkApi.begin()).rejects.toThrow(FAILURE);
    expect(mockCallable).not.toHaveBeenCalled();
  });
});
