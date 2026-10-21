import { ReadableStream } from 'node:stream/web';
import {
  requestProfile,
  PROFILE_TIMEOUT_MS,
  PROFILE_RESPONSE_MAX_BYTES,
  type ProfileFetch,
} from '../profileTransport';

const FAILURE = 'X profile request failed';
const PRIVATE = 'PRIVATE_DO_NOT_EXPOSE';
const ACCESS_TOKEN = 'SERVER_DECRYPTED_TEST_ACCESS_TOKEN';
const IMAGE = 'https://pbs.twimg.com/profile_images/example/avatar.jpg';

function valid(): Record<string, unknown> {
  return { id: '12345678901234567890', username: 'Example_1' };
}

function response(data: unknown = valid(), status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function mockFetch(value = response()): jest.MockedFunction<ProfileFetch> {
  return jest.fn().mockResolvedValue(value);
}

async function expectFailure(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message).toBe(FAILURE);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
  expect(error.stack).not.toContain(PRIVATE);
  expect(error.stack).not.toContain(ACCESS_TOKEN);
}

let logs: jest.SpyInstance[];

beforeEach(() => {
  jest.useFakeTimers();
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined),
  );
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

describe('server-only X profile transport', () => {
  it('sends one exact GET with caller token and returns only minimal fields', async () => {
    const fetch = mockFetch(response({
      ...valid(),
      profile_image_url: IMAGE,
      name: PRIVATE,
      access_token: ACCESS_TOKEN,
      description: PRIVATE,
    }));
    expect(await requestProfile(fetch, ACCESS_TOKEN)).toEqual({
      id: valid().id,
      username: 'Example_1',
      profileImageUrl: IMAGE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/users/me?user.fields=profile_image_url');
    expect(init).toEqual({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(init.signal.aborted).toBe(false);
  });

  it.each([
    ['a', 1],
    ['A_1234567890123', 15],
  ] as const)('accepts safe handle %s without name or image', async (username, expectedLength) => {
    expect(username).toHaveLength(expectedLength);
    expect(await requestProfile(
      mockFetch(response({ ...valid(), username })), ACCESS_TOKEN,
    )).toEqual({ id: valid().id, username, profileImageUrl: null });
  });

  it.each([
    undefined, null, '', ' ', 'x\nheader', '\t', '雪', 1,
  ])('rejects invalid token before fetching: %j', async (token) => {
    const fetch = mockFetch();
    await expectFailure(requestProfile(fetch, token as string));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    null, [], PRIVATE, 1, {},
    { id: '', username: 'safe' },
    { id: 123, username: 'safe' },
    { id: '123\n', username: 'safe' },
    { id: '1e3', username: 'safe' },
    { id: '-1', username: 'safe' },
    { id: '１２３', username: 'safe' },
    { id: '123' },
    { id: '123', username: '' },
    { id: '123', username: null },
    { id: '123', username: '@safe' },
    { id: '123', username: 'unsafe-name' },
    { id: '123', username: 'unsafe name' },
    { id: '123', username: 'safe\n' },
    { id: '123', username: 'a'.repeat(16) },
    { id: '123', username: '日本語' },
  ])('rejects malformed data: %j', async (data) => {
    await expectFailure(requestProfile(mockFetch(response(data)), ACCESS_TOKEN));
  });

  it.each([null, [], PRIVATE, 1, {}, { errors: [{ detail: PRIVATE }] }])(
    'rejects malformed response envelope: %j', async (payload) => {
      await expectFailure(requestProfile(
        mockFetch(new Response(JSON.stringify(payload))), ACCESS_TOKEN,
      ));
    },
  );

  it.each([
    null, '', 1, {},
    'http://example.test/avatar.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AA',
    '//example.test/avatar.jpg',
    'https://user:password@example.test/avatar.jpg',
    'https://@example.test/avatar.jpg',
    'https://example.test/avatar.jpg#fragment',
    'https://example.test/avatar.jpg#',
    'https://example.test/a\nb.jpg',
    'https://example.test/a\u007fb.jpg',
    'https://example.test/a\u0085b.jpg',
    'https://example.test/a b.jpg',
    'https://example.test/a\\b.jpg',
    'https://example.test/\ud800',
    'https://',
  ])('rejects supplied unsafe image: %j', async (image) => {
    await expectFailure(requestProfile(mockFetch(response({
      ...valid(), profile_image_url: image,
    })), ACCESS_TOKEN));
  });

  it('accepts secure image URLs without fetching the image', async () => {
    const image = 'https://images.example.test/avatar.jpg?size=normal';
    const fetch = mockFetch(response({ ...valid(), profile_image_url: image }));
    expect((await requestProfile(fetch, ACCESS_TOKEN)).profileImageUrl).toBe(image);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([201, 204, 301, 302, 400, 401, 403, 429, 500])(
    'rejects HTTP %s without reading provider text', async (status) => {
      const read = jest.fn();
      const cancel = jest.fn();
      const releaseLock = jest.fn();
      const fetch: ProfileFetch = async () => ({
        status,
        body: {
          getReader: () => ({ read, cancel, releaseLock }),
        } as unknown as NonNullable<Response['body']>,
      });
      await expectFailure(requestProfile(fetch, ACCESS_TOKEN));
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['', '<html>PRIVATE_DO_NOT_EXPOSE</html>', '{"data":'])(
    'sanitizes invalid JSON: %s', async (text) => {
      await expectFailure(requestProfile(
        mockFetch(new Response(text)), ACCESS_TOKEN,
      ));
    },
  );

  it('rejects missing body', async () => {
    await expectFailure(requestProfile(mockFetch(new Response(null)), ACCESS_TOKEN));
  });

  it('sanitizes synchronous and asynchronous fetch errors without logging', async () => {
    const sync: ProfileFetch = () => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); };
    const asyncFetch: ProfileFetch = async () => {
      throw new Error(`${PRIVATE}${ACCESS_TOKEN}`);
    };
    for (const fetch of [sync, asyncFetch]) {
      await expectFailure(requestProfile(fetch, ACCESS_TOKEN));
    }
  });

  it('sanitizes stream errors and releases the lock', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(PRIVATE)); },
    });
    await expectFailure(requestProfile(mockFetch(new Response(body)), ACCESS_TOKEN));
    expect(body.locked).toBe(false);
  });

  it('bounds fetch that ignores AbortSignal to exactly ten seconds', async () => {
    expect(PROFILE_TIMEOUT_MS).toBe(10_000);
    const fetch: jest.MockedFunction<ProfileFetch> = jest.fn<
      ReturnType<ProfileFetch>, Parameters<ProfileFetch>
    >(() => new Promise<Response>(() => undefined));
    const failure = expectFailure(requestProfile(fetch, ACCESS_TOKEN));
    await jest.advanceTimersByTimeAsync(PROFILE_TIMEOUT_MS - 1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await failure;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('cancels a response arriving after the deadline', async () => {
    let resolve!: (value: Response) => void;
    const fetch: ProfileFetch = () => new Promise<Response>((done) => { resolve = done; });
    const failure = expectFailure(requestProfile(fetch, ACCESS_TOKEN));
    await jest.advanceTimersByTimeAsync(PROFILE_TIMEOUT_MS);
    await failure;
    const cancel = jest.fn();
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('uses one deadline for headers and body, even when cancel never settles', async () => {
    let resolve!: (value: Response) => void;
    const fetch: ProfileFetch = () => new Promise<Response>((done) => { resolve = done; });
    const failure = expectFailure(requestProfile(fetch, ACCESS_TOKEN));
    await jest.advanceTimersByTimeAsync(PROFILE_TIMEOUT_MS - 1);
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    resolve(new Response(body));
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1);
    await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('accepts exactly 64 KiB with split UTF-8 and releases the successful stream', async () => {
    expect(PROFILE_RESPONSE_MAX_BYTES).toBe(64 * 1024);
    const json = JSON.stringify({ data: { ...valid(), name: '雪' } });
    const bytes = Buffer.from(
      json + ' '.repeat(PROFILE_RESPONSE_MAX_BYTES - Buffer.byteLength(json)),
    );
    expect(bytes.byteLength).toBe(PROFILE_RESPONSE_MAX_BYTES);
    const snow = Buffer.from('雪');
    expect(snow.byteLength).toBe(3);
    const snowOffset = bytes.indexOf(snow);
    expect(snowOffset).toBeGreaterThanOrEqual(0);
    const chunks = [
      bytes.subarray(0, snowOffset + 1),
      bytes.subarray(snowOffset + 1, snowOffset + 2),
      bytes.subarray(snowOffset + 2),
    ];
    expect(chunks[0][chunks[0].length - 1]).toBe(snow[0]);
    expect(chunks[1]).toEqual(snow.subarray(1, 2));
    expect(chunks[2][0]).toBe(snow[2]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await requestProfile(mockFetch(new Response(body)), ACCESS_TOKEN)).toEqual({
      ...valid(), profileImageUrl: null,
    });
    expect(body.locked).toBe(false);
  });

  it.each(['single', 'streamed'])(
    'rejects oversized %s body and sanitizes cancellation failure', async (mode) => {
      const cancel = jest.fn(() => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'single') {
            controller.enqueue(new Uint8Array(PROFILE_RESPONSE_MAX_BYTES + 1));
          } else {
            controller.enqueue(new Uint8Array(PROFILE_RESPONSE_MAX_BYTES));
            controller.enqueue(Uint8Array.of(1));
          }
        },
        cancel,
      });
      await expectFailure(requestProfile(mockFetch(new Response(body)), ACCESS_TOKEN));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it('rejects invalid UTF-8 instead of replacing bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"data":{"id":"123","username":"safe","name":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    await expectFailure(requestProfile(
      mockFetch(new Response(bytes)), ACCESS_TOKEN,
    ));
  });
});
