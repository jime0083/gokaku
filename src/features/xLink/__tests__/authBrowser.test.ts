import {
  createAuthBrowser,
  type OpenSession,
  type SessionResult,
} from '../authBrowser';

const FAILURE = 'x-auth-browser-failed';
const REDIRECT = 'gokaku://x-auth/callback?source=onboarding';
const STATE = 'mock-state';
const CODE = 'mock-code';

function authorization(redirect = REDIRECT, state = STATE): string {
  const url = new URL('https://x.com/i/oauth2/authorize');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', redirect);
  return url.toString();
}

function callback(
  fields: Record<string, string> = { state: STATE, code: CODE },
): string {
  const url = new URL(REDIRECT);
  Object.entries(fields).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function fixture() {
  const session = jest.fn<ReturnType<OpenSession>, Parameters<OpenSession>>();
  session.mockResolvedValue({ type: 'success', url: callback() });
  return { session, browser: createAuthBrowser(session) };
}

it('returns validated code/state and passes the exact redirect with default options', async () => {
  const { session, browser } = fixture();
  const url = authorization();
  await expect(browser.open(url)).resolves.toEqual({
    type: 'success', state: STATE, code: CODE,
  });
  expect(session).toHaveBeenCalledWith(url, REDIRECT, {
    preferEphemeralSession: false,
  });
});

it.each([true, false])('passes differentAccount=%s as an ephemeral request', async (value) => {
  const { session, browser } = fixture();
  await browser.open(authorization(), { differentAccount: value });
  expect(session).toHaveBeenCalledWith(authorization(), REDIRECT, {
    preferEphemeralSession: value,
  });
});

it.each(['cancel', 'dismiss'])('maps native %s to cancel', async (type) => {
  const { session, browser } = fixture();
  session.mockResolvedValue({ type });
  await expect(browser.open(authorization())).resolves.toEqual({ type: 'cancel' });
});

it('maps access_denied with matching state to cancel', async () => {
  const { session, browser } = fixture();
  session.mockResolvedValue({
    type: 'success',
    url: callback({
      state: STATE,
      error: 'access_denied',
      error_description: 'Mock denial',
    }),
  });
  await expect(browser.open(authorization())).resolves.toEqual({ type: 'cancel' });
});

it.each([
  'http://x.com/i/oauth2/authorize',
  'https://other.example/i/oauth2/authorize',
  'https://x.com/other',
  'https://user:password@x.com/i/oauth2/authorize',
  'https://x.com:444/i/oauth2/authorize',
  'https://x.com/i/oauth2/authorize#',
  'https://x.com/a/../i/oauth2/authorize',
])('rejects an invalid authorization endpoint: %s', async (endpoint) => {
  const { session, browser } = fixture();
  const separator = endpoint.includes('#') ? '' : '?';
  const url = endpoint + separator +
    new URLSearchParams({ state: STATE, redirect_uri: REDIRECT });
  await expect(browser.open(url)).rejects.toThrow(FAILURE);
  expect(session).not.toHaveBeenCalled();
});

it.each([
  '',
  authorization() + '&state=other',
  authorization() + '&st%61te=other',
  authorization() + '&redirect_uri=gokaku%3A%2F%2Fother',
  'https://x.com/i/oauth2/authorize?state=mock-state',
  'https://x.com/i/oauth2/authorize?redirect_uri=gokaku%3A%2F%2Fx-auth',
  authorization(REDIRECT, ''),
  authorization(REDIRECT, '\u0000'),
  authorization(REDIRECT, '\u007f'),
  authorization(REDIRECT, '\u0085'),
  authorization() + '&extra=%FF',
  authorization() + '&extra=%',
  authorization() + '&extra=\ud800',
  authorization() + '&extra=' + 'a'.repeat(16385),
])('rejects malformed authorization input %# before opening', async (url) => {
  const { session, browser } = fixture();
  await expect(browser.open(url)).rejects.toThrow(FAILURE);
  expect(session).not.toHaveBeenCalled();
});

it.each([
  'https://x-auth/callback',
  'gokaku://user:password@x-auth/callback',
  'gokaku://x-auth:444/callback',
  'gokaku://x-auth/callback#',
  'gokaku://x-auth/a/../callback',
  REDIRECT + '&source=other',
  REDIRECT + '&code=reserved',
  REDIRECT + '&state=reserved',
  REDIRECT + '&error=reserved',
  REDIRECT + '&st%61te=reserved',
  REDIRECT + '&extra=%00',
  REDIRECT + '&extra=%FF',
  REDIRECT + '&extra=%ED%A0%80',
  REDIRECT + '&extra=' + 'a'.repeat(4097),
])('rejects unsafe configured redirect %#', async (redirect) => {
  const { session, browser } = fixture();
  await expect(browser.open(authorization(redirect))).rejects.toThrow(FAILURE);
  expect(session).not.toHaveBeenCalled();
});

it.each([
  callback().replace('gokaku:', 'other:'),
  callback().replace('x-auth', 'other'),
  callback().replace('/callback', '/other'),
  callback().replace('/callback', '/a/../callback'),
  callback().replace('gokaku://', 'gokaku://user@'),
  callback().replace('source=onboarding', 'source=other'),
  callback().replace('source=onboarding&', ''),
  callback() + '&source=onboarding',
  callback() + '&unexpected=value',
  callback() + '&code=other',
  callback() + '&co%64e=other',
  callback() + '&state=other',
  callback() + '#',
  callback({ state: 'other', code: CODE }),
  callback({ state: STATE }),
  callback({ state: STATE, code: '' }),
  callback({ state: STATE, code: '\u0001' }),
  callback({ state: STATE, code: '\u0085' }),
  callback({ state: STATE, code: 'a'.repeat(4097) }),
  callback() + '&error=access_denied',
  callback() + '&error_description=unexpected',
  callback({ state: 'other', error: 'access_denied' }),
  callback({ error: 'access_denied' }),
  callback({ state: STATE, error: 'server_error' }),
  callback({ state: STATE, error: 'access_denied' }) + '&error=access_denied',
  callback() + '&extra=%FF',
  callback() + '&extra=\udfff',
  callback() + '&extra=' + 'a'.repeat(16385),
])('rejects an unsafe callback %# with a fixed failure', async (url) => {
  const { session, browser } = fixture();
  session.mockResolvedValue({ type: 'success', url });
  await expect(browser.open(authorization())).rejects.toThrow(
    new Error(FAILURE),
  );
});

it.each([
  { type: 'success' },
  { type: 'opened' },
  { type: 'locked' },
  null,
  undefined,
])('rejects invalid native results %#', async (result) => {
  const { session, browser } = fixture();
  session.mockResolvedValue(result as SessionResult);
  await expect(browser.open(authorization())).rejects.toThrow(FAILURE);
});

it('sanitizes thrown values without retaining a cause or logging', async () => {
  const { session, browser } = fixture();
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const sensitive = new Error('https://example.invalid/?code=private-code');
    session.mockRejectedValueOnce(sensitive);
    const caught = await browser.open(authorization()).catch((value: unknown) => value);
    expect(caught).toEqual(new Error(FAILURE));
    expect(caught).not.toBe(sensitive);
    expect(Object.prototype.hasOwnProperty.call(caught, 'cause')).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
});

it('rejects concurrent opens without releasing the original gate', async () => {
  const { session, browser } = fixture();
  let finish!: (result: SessionResult) => void;
  session.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve;
  }));
  const first = browser.open(authorization());
  await expect(browser.open(authorization())).rejects.toThrow(FAILURE);
  await expect(browser.open(authorization())).rejects.toThrow(FAILURE);
  expect(session).toHaveBeenCalledTimes(1);
  finish({ type: 'success', url: callback() });
  await expect(first).resolves.toEqual({
    type: 'success', state: STATE, code: CODE,
  });
  await expect(browser.open(authorization())).resolves.toEqual({
    type: 'success', state: STATE, code: CODE,
  });
});

it.each(['cancel', 'dismiss', 'reject', 'invalid-callback', 'sync-throw'])(
  'releases the gate after %s',
  async (outcome) => {
    const { session, browser } = fixture();
    if (outcome === 'reject') {
      session.mockRejectedValueOnce(new Error('native-private-detail'));
    } else if (outcome === 'sync-throw') {
      session.mockImplementationOnce(() => {
        throw new Error('native-private-detail');
      });
    } else if (outcome === 'invalid-callback') {
      session.mockResolvedValueOnce({ type: 'success', url: 'gokaku://other' });
    } else {
      session.mockResolvedValueOnce({ type: outcome });
    }
    await browser.open(authorization()).catch(() => undefined);
    await expect(browser.open(authorization())).resolves.toEqual({
      type: 'success', state: STATE, code: CODE,
    });
  },
);

it('releases the gate after invalid input and keeps gates instance-local', async () => {
  const { session, browser } = fixture();
  await expect(browser.open('invalid')).rejects.toThrow(FAILURE);
  await expect(browser.open(authorization())).resolves.toMatchObject({
    type: 'success',
  });
  const other = createAuthBrowser(session);
  await expect(Promise.all([
    browser.open(authorization()),
    other.open(authorization()),
  ])).resolves.toHaveLength(2);
});
