import { ReadableStream } from 'node:stream/web';
import { requestPost } from '../postTransport';

type PostFetch = Parameters<typeof requestPost>[0];
type PostInput = Parameters<typeof requestPost>[2];
type FetchResponse = Awaited<ReturnType<PostFetch>>;

const ENDPOINT = 'https://api.x.com/2/tweets';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const FAILURE = 'X post request failed';
const PRIVATE = 'PRIVATE_DO_NOT_EXPOSE';
const ACCESS_TOKEN = 'SERVER_DECRYPTED_TEST_ACCESS_TOKEN';
const POST_ID = '12345678901234567890';
const INPUT = { text: '本日の最低目標学習時間を達成できませんでした\n#合格ウォッチ' };
const POSTED = { kind: 'posted', postId: POST_ID };

function response(payload: unknown = { data: { id: POST_ID } }): Response {
  return new Response(JSON.stringify(payload), { status: 201 });
}

function mockFetch(value: FetchResponse = response()): jest.MockedFunction<PostFetch> {
  return jest.fn().mockResolvedValue(value);
}

function streamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 201 });
}

function assertSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(PRIVATE);
  expect(serialized).not.toContain(ACCESS_TOKEN);
}

async function expectInputFailure(operation: Promise<unknown>): Promise<void> {
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

async function expectUnknown(
  fetch: PostFetch,
  reason: 'network' | 'timeout' | 'invalid_response',
): Promise<void> {
  const result = await requestPost(fetch, ACCESS_TOKEN, INPUT);
  expect(result).toEqual({ kind: 'unknown', reason });
  assertSafe(result);
}

let logs: jest.SpyInstance[];
let globalFetch: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined),
  );
  globalFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('Unexpected global fetch');
  });
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

describe('server-only X post HTTP transport (7-3b internal unit)', () => {
  it('sends one exact POST and returns only the post ID', async () => {
    const fetch = mockFetch(response({
      data: { id: POST_ID, text: PRIVATE, access_token: ACCESS_TOKEN },
      errors: [{ detail: PRIVATE }],
    }));
    const result = await requestPost(fetch, ACCESS_TOKEN, INPUT);
    expect(result).toEqual(POSTED);
    assertSafe(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init).toEqual({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(INPUT),
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(init.signal.aborted).toBe(false);
  });

  it('serializes one through four media IDs separately from text without mutating input', async () => {
    for (const mediaIds of [['1'], ['1', '22', '333', '4444']]) {
      const input = Object.freeze({
        text: INPUT.text,
        mediaIds: Object.freeze([...mediaIds]),
      });
      const fetch = mockFetch();
      expect(await requestPost(fetch, ACCESS_TOKEN, input as PostInput)).toEqual(POSTED);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
        text: INPUT.text,
        media: { media_ids: mediaIds },
      });
      expect(input.mediaIds).toEqual(mediaIds);
    }
  });

  it('omits media for absent, undefined, or empty mediaIds', async () => {
    for (const input of [INPUT, { ...INPUT, mediaIds: undefined }, { ...INPUT, mediaIds: [] }]) {
      const fetch = mockFetch();
      expect(await requestPost(fetch, ACCESS_TOKEN, input)).toEqual(POSTED);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(INPUT);
    }
  });

  it('accepts visible ASCII tokens and preserves valid text without a local weighted-280 rule', async () => {
    const token = Array.from({ length: 94 }, (_, offset) =>
      String.fromCharCode(0x21 + offset),
    ).join('');
    for (const text of ['a', ' ', '雪😀\n"\\', 'あ'.repeat(281)]) {
      const fetch = mockFetch();
      expect(await requestPost(fetch, token, { text })).toEqual(POSTED);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ text });
      expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds the serialized request in UTF-8 bytes, including JSON escaping', async () => {
    for (const seed of ['雪', '\n', '"', '\\']) {
      const overhead = Buffer.byteLength(JSON.stringify({ text: seed }), 'utf8');
      const text = seed + 'a'.repeat(MAX_BYTES - overhead);
      expect(Buffer.byteLength(JSON.stringify({ text }), 'utf8')).toBe(MAX_BYTES);
      const fetch = mockFetch();
      expect(await requestPost(fetch, ACCESS_TOKEN, { text })).toEqual(POSTED);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(fetch.mock.calls[0][1].body, 'utf8')).toBe(MAX_BYTES);
      const rejectedFetch = mockFetch();
      await expectInputFailure(requestPost(rejectedFetch, ACCESS_TOKEN, { text: text + 'a' }));
      expect(rejectedFetch).not.toHaveBeenCalled();
    }
  });

  it('includes media and its JSON envelope in the request byte bound', async () => {
    const mediaIds = ['12345678901234567890', '2', '3', '4'];
    const overhead = Buffer.byteLength(JSON.stringify({ text: '', media: { media_ids: mediaIds } }));
    const text = 'a'.repeat(MAX_BYTES - overhead);
    const fetch = mockFetch();
    expect(await requestPost(fetch, ACCESS_TOKEN, { text, mediaIds })).toEqual(POSTED);
    expect(Buffer.byteLength(fetch.mock.calls[0][1].body)).toBe(MAX_BYTES);
    const rejectedFetch = mockFetch();
    await expectInputFailure(requestPost(rejectedFetch, ACCESS_TOKEN, { text: text + 'a', mediaIds }));
    expect(rejectedFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens with a fixed Error before fetch', async () => {
    for (const token of [undefined, null, 1, '', ' ', '\t', '\n', 'x\r\nheader', '\u0000', '\u007f', '雪', '\ud800']) {
      const fetch = mockFetch();
      await expectInputFailure(requestPost(fetch, token as string, INPUT));
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed input and invalid text with a fixed Error before fetch', async () => {
    for (const input of [
      undefined, null, [], PRIVATE, 1, {},
      { text: undefined }, { text: null }, { text: 1 }, { text: [] },
      { text: '' }, { text: '\ud800' }, { text: '\udc00' },
      { text: `safe${PRIVATE}\ud800` }, { text: 'a'.repeat(MAX_BYTES) },
    ]) {
      const fetch = mockFetch();
      await expectInputFailure(requestPost(fetch, ACCESS_TOKEN, input as PostInput));
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid media IDs and more than four IDs before fetch', async () => {
    const sparse = new Array<string>(1);
    for (const mediaIds of [
      null, 1, '123', {}, sparse,
      ['1', '2', '3', '4', '5'],
      [''], [1], [null], [undefined], ['-1'], ['1e3'], ['１２３'],
      ['1\n'], [' 1'], ['1 '], [PRIVATE], ['\ud800'],
    ]) {
      const fetch = mockFetch();
      await expectInputFailure(requestPost(fetch, ACCESS_TOKEN, {
        ...INPUT, mediaIds,
      } as unknown as PostInput));
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('returns neutral non-201 statuses without reading bodies, retrying, or refreshing', async () => {
    for (const status of [200, 202, 204, 301, 302, 307, 308, 400, 401, 403, 409, 429, 500, 503]) {
      const body = new ReadableStream<Uint8Array>();
      const read = jest.spyOn(body, 'getReader');
      const cancel = jest.spyOn(body, 'cancel');
      const fetch = mockFetch({ status, body: body as Response['body'], headers: new Headers() });
      const result = await requestPost(fetch, ACCESS_TOKEN, INPUT);
      expect(result).toEqual({ kind: 'http_error', status });
      assertSafe(result);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('returns valid Retry-After integer seconds unchanged without scheduling retries', async () => {
    for (const value of ['0', '1', '60', '86400']) {
      const fetch = mockFetch({
        status: 429, body: null, headers: new Headers({ 'Retry-After': value }),
      });
      expect(await requestPost(fetch, ACCESS_TOKEN, INPUT)).toEqual({
        kind: 'http_error', status: 429, retryAfterSeconds: Number(value),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it('omits invalid Retry-After rather than rounding, clamping, or parsing HTTP dates', async () => {
    for (const value of [
      '', '-1', '+1', '1.5', '1e3', '0x10', 'Infinity', 'NaN',
      '1, 2', '120junk', 'Wed, 21 Oct 2015 07:28:00 GMT',
      '9007199254740992', '9'.repeat(100), PRIVATE,
    ]) {
      const fetch = mockFetch({
        status: 503, body: null, headers: new Headers({ 'Retry-After': value }),
      });
      const result = await requestPost(fetch, ACCESS_TOKEN, INPUT);
      expect(result).toEqual({ kind: 'http_error', status: 503 });
      expect(Object.prototype.hasOwnProperty.call(result, 'retryAfterSeconds')).toBe(false);
      assertSafe(result);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('safely tolerates absent or throwing optional header getters', async () => {
    const headersWithThrowingProperty = Object.defineProperty({}, 'get', {
      get() { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); },
    });
    for (const headers of [
      undefined, null, {}, { get: undefined },
      { get() { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); } },
      { get() { return null; } }, { get() { return 1; } },
      headersWithThrowingProperty,
    ]) {
      const fetch = mockFetch({ status: 429, body: null, headers } as unknown as FetchResponse);
      expect(await requestPost(fetch, ACCESS_TOKEN, INPUT)).toEqual({ kind: 'http_error', status: 429 });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes synchronous and asynchronous fetch failures as network unknown', async () => {
    const synchronous: PostFetch = () => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); };
    const asynchronous: PostFetch = async () => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); };
    for (const implementation of [synchronous, asynchronous]) {
      const fetch: jest.MockedFunction<PostFetch> = jest.fn<
        ReturnType<PostFetch>, Parameters<PostFetch>
      >(implementation);
      await expectUnknown(fetch, 'network');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('returns invalid_response unknown for missing body, bad JSON, or malformed envelopes', async () => {
    for (const value of [
      new Response(null, { status: 201 }),
      new Response('', { status: 201 }),
      new Response(`<html>${PRIVATE}${ACCESS_TOKEN}</html>`, { status: 201 }),
      new Response('{"data":', { status: 201 }),
      ...[null, [], PRIVATE, 1, {}, { data: null }, { data: [] }, { data: PRIVATE },
        { errors: [{ detail: PRIVATE }] }].map((payload) => response(payload)),
    ]) {
      const fetch = mockFetch(value);
      await expectUnknown(fetch, 'invalid_response');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('accepts only nonempty ASCII digit strings as post IDs', async () => {
    for (const id of [undefined, null, 123, '', ' ', '-1', '1e3', '１２３', '123\n', [], {}, PRIVATE, ACCESS_TOKEN]) {
      const fetch = mockFetch(response({ data: { id } }));
      await expectUnknown(fetch, 'invalid_response');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    for (const id of ['0', '0001', POST_ID]) {
      expect(await requestPost(mockFetch(response({ data: { id } })), ACCESS_TOKEN, INPUT)).toEqual({
        kind: 'posted', postId: id,
      });
    }
  });

  it('returns network unknown on a body communication failure and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(`${PRIVATE}${ACCESS_TOKEN}`)); },
    });
    const fetch = mockFetch(streamResponse(body));
    await expectUnknown(fetch, 'network');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('settles at exactly ten seconds even when fetch ignores abort, without retrying', async () => {
    const fetch: jest.MockedFunction<PostFetch> = jest.fn<
      ReturnType<PostFetch>, Parameters<PostFetch>
    >(() => new Promise<FetchResponse>(() => undefined));
    let settled = false;
    const result = requestPost(fetch, ACCESS_TOKEN, INPUT).then((value) => {
      settled = true;
      return value;
    });
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discards late response bodies after timeout, including rejected cleanup', async () => {
    for (const cleanup of ['resolve', 'reject', 'throw'] as const) {
      let resolve!: (value: FetchResponse) => void;
      const fetch: jest.MockedFunction<PostFetch> = jest.fn<
        ReturnType<PostFetch>, Parameters<PostFetch>
      >(() => new Promise<FetchResponse>((done) => { resolve = done; }));
      const result = requestPost(fetch, ACCESS_TOKEN, INPUT);
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(await result).toEqual({ kind: 'unknown', reason: 'timeout' });
      const cancel = jest.fn(() => {
        if (cleanup === 'throw') throw new Error(PRIVATE);
        return cleanup === 'reject' ? Promise.reject(new Error(PRIVATE)) : Promise.resolve();
      });
      const getReader = jest.fn();
      resolve({
        status: 201, headers: new Headers(),
        body: { cancel, getReader } as unknown as Response['body'],
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(getReader).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('uses one deadline across headers and stalled reads even if cancellation never settles', async () => {
    let resolve!: (value: FetchResponse) => void;
    const fetch: jest.MockedFunction<PostFetch> = jest.fn<
      ReturnType<PostFetch>, Parameters<PostFetch>
    >(() => new Promise<FetchResponse>((done) => { resolve = done; }));
    const result = requestPost(fetch, ACCESS_TOKEN, INPUT);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    resolve(streamResponse(body));
    await jest.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 64 KiB and split multibyte UTF-8, then releases the successful reader', async () => {
    const json = JSON.stringify({ data: { id: POST_ID, text: '雪' } });
    const bytes = Buffer.from(json + ' '.repeat(MAX_BYTES - Buffer.byteLength(json)));
    expect(bytes.byteLength).toBe(MAX_BYTES);
    const offset = bytes.indexOf(Buffer.from('雪'));
    expect(offset).toBeGreaterThanOrEqual(0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, offset + 1));
        controller.enqueue(bytes.subarray(offset + 1, offset + 2));
        controller.enqueue(bytes.subarray(offset + 2));
        controller.close();
      },
    });
    const fetch = mockFetch(streamResponse(body));
    expect(await requestPost(fetch, ACCESS_TOKEN, INPUT)).toEqual(POSTED);
    expect(body.locked).toBe(false);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized single and accumulated response chunks without waiting for cleanup', async () => {
    for (const mode of ['single', 'streamed'] as const) {
      const cancel = jest.fn(() => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'single') {
            controller.enqueue(new Uint8Array(MAX_BYTES + 1));
          } else {
            controller.enqueue(new Uint8Array(MAX_BYTES));
            controller.enqueue(Uint8Array.of(1));
          }
        },
        cancel,
      });
      const fetch = mockFetch(streamResponse(body));
      await expectUnknown(fetch, 'invalid_response');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('decodes UTF-8 fatally even when invalid bytes are in otherwise ignored fields', async () => {
    const bytes = Buffer.concat([
      Buffer.from(`{"data":{"id":"${POST_ID}","text":"`),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const fetch = mockFetch(streamResponse(body));
    await expectUnknown(fetch, 'invalid_response');
    expect(body.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not let cancel failures or release failures replace sanitized results', async () => {
    for (const mode of ['posted', 'invalid', 'http'] as const) {
      const read = jest.fn().mockResolvedValueOnce({
        done: false,
        value: Buffer.from(mode === 'posted'
          ? JSON.stringify({ data: { id: POST_ID } })
          : PRIVATE),
      }).mockResolvedValue({ done: true, value: undefined });
      const cancel = jest.fn(() => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); });
      const releaseLock = jest.fn(() => { throw new Error(`${PRIVATE}${ACCESS_TOKEN}`); });
      const getReader = jest.fn(() => ({ read, cancel, releaseLock }));
      const fetch = mockFetch({
        status: mode === 'http' ? 500 : 201,
        headers: new Headers(),
        body: { getReader, cancel } as unknown as Response['body'],
      });
      const result = await requestPost(fetch, ACCESS_TOKEN, INPUT);
      expect(result).toEqual(mode === 'posted'
        ? POSTED
        : mode === 'http'
          ? { kind: 'http_error', status: 500 }
          : { kind: 'unknown', reason: 'invalid_response' });
      assertSafe(result);
      if (mode === 'http') {
        expect(read).not.toHaveBeenCalled();
      } else {
        expect(releaseLock).toHaveBeenCalledTimes(1);
      }
      if (mode !== 'posted') expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps timeout unknown when an abort-ignoring read resolves late', async () => {
    let resolveRead!: (value: { done: boolean; value: Uint8Array }) => void;
    const read = jest.fn(() => new Promise<{ done: boolean; value: Uint8Array }>((resolve) => {
      resolveRead = resolve;
    }));
    const cancel = jest.fn(() => Promise.resolve());
    const releaseLock = jest.fn();
    const fetch = mockFetch({
      status: 201,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) } as unknown as Response['body'],
    });
    const result = requestPost(fetch, ACCESS_TOKEN, INPUT);
    await jest.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await result).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    resolveRead({ done: false, value: Buffer.from(JSON.stringify({ data: { id: POST_ID } })) });
    await jest.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
