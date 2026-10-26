/**
 * Server-only, single-attempt post HTTP transport. The caller supplies fetch
 * and a user access token. Results carry no retry or application policy.
 */
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { TextDecoder } from 'node:util';

const POST_ENDPOINT = 'https://api.x.com/2/tweets';
const FAILURE = 'X post request failed';
const MEDIA_MAX_COUNT = 4;

export const POST_TIMEOUT_MS = 10_000;
export const POST_REQUEST_MAX_BYTES = 64 * 1024;
export const POST_RESPONSE_MAX_BYTES = 64 * 1024;

export interface PostInput {
  readonly text: string;
  readonly mediaIds?: readonly string[];
}

export interface PostRequest {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

export type FetchResponse = Pick<Response, 'status' | 'body' | 'headers'>;

export type PostFetch = (
  url: string,
  init: PostRequest,
) => Promise<FetchResponse>;

export type PostResult =
  | { readonly kind: 'posted'; readonly postId: string }
  | {
      readonly kind: 'http_error';
      readonly status: number;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: 'network' | 'timeout' | 'invalid_response';
    };

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireObject(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
}

function requireDigits(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value));
}

/** Validate and snapshot inputs before entering the transport error boundary. */
function createBody(accessToken: string, input: PostInput): string {
  try {
    requireValue(
      typeof accessToken === 'string' &&
        accessToken.length > 0 &&
        Array.from(accessToken).every((character) => {
          const code = character.charCodeAt(0);
          return code >= 0x21 && code <= 0x7e;
        }),
    );
    requireObject(input);
    const text = input.text;
    requireValue(
      typeof text === 'string' &&
        text.length > 0 &&
        text.length <= POST_REQUEST_MAX_BYTES &&
        Buffer.from(text, 'utf8').toString('utf8') === text,
    );
    const suppliedMedia = input.mediaIds;
    const mediaIds: string[] = [];
    if (suppliedMedia !== undefined) {
      requireValue(Array.isArray(suppliedMedia) && suppliedMedia.length <= MEDIA_MAX_COUNT);
      for (const id of suppliedMedia) {
        requireDigits(id);
        mediaIds.push(id);
      }
    }
    const body = JSON.stringify(mediaIds.length === 0
      ? { text }
      : { text, media: { media_ids: mediaIds } });
    requireValue(Buffer.byteLength(body, 'utf8') <= POST_REQUEST_MAX_BYTES);
    return body;
  } catch {
    // Input errors remain Errors, without raw values or an original cause.
    throw new Error(FAILURE);
  }
}

function validateResponse(value: unknown): PostResult {
  requireObject(value);
  const data = value.data;
  requireObject(data);
  const id = data.id;
  requireDigits(id);
  return { kind: 'posted', postId: id };
}

/** Invalid or unavailable metadata must not change the HTTP status result. */
function retryAfterSeconds(response: FetchResponse): number | undefined {
  try {
    const value: unknown = response.headers?.get?.('Retry-After');
    if (typeof value !== 'string' || value.length === 0 || /[^0-9]/.test(value)) {
      return undefined;
    }
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** Cleanup must neither leak an error nor extend the request deadline. */
function discard(operation: () => Promise<unknown>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Cleanup errors are intentionally discarded.
  }
}

export async function requestPost(
  fetch: PostFetch,
  accessToken: string,
  input: PostInput,
): Promise<PostResult> {
  const body = createBody(accessToken, input);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let timedOut = false;
  let failureReason: 'network' | 'invalid_response' = 'invalid_response';

  try {
    // One deadline covers fetch and all reads, including injected operations
    // that ignore AbortSignal. Cleanup is never awaited.
    const deadline = new Promise<PostResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ kind: 'unknown', reason: 'timeout' });
        controller.abort();
      }, POST_TIMEOUT_MS);
    });

    const operation = async (): Promise<PostResult> => {
      failureReason = 'network';
      const response = await fetch(POST_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      failureReason = 'invalid_response';
      if (timedOut) {
        const lateBody = response.body;
        if (lateBody) discard(() => lateBody.cancel());
        return { kind: 'unknown', reason: 'timeout' };
      }

      const status = response.status;
      requireValue(Number.isInteger(status) && status >= 100 && status <= 599);
      if (status !== 201) {
        const errorBody = response.body;
        if (errorBody) discard(() => errorBody.cancel());
        const seconds = retryAfterSeconds(response);
        return seconds === undefined
          ? { kind: 'http_error', status }
          : { kind: 'http_error', status, retryAfterSeconds: seconds };
      }

      reader = response.body?.getReader();
      requireValue(reader !== undefined);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        failureReason = 'network';
        const chunk = await reader.read();
        failureReason = 'invalid_response';
        if (timedOut) return { kind: 'unknown', reason: 'timeout' };
        if (chunk.done) break;
        requireValue(chunk.value instanceof Uint8Array);
        size += chunk.value.byteLength;
        requireValue(size <= POST_RESPONSE_MAX_BYTES);
        chunks.push(chunk.value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size),
      );
      return validateResponse(JSON.parse(text) as unknown);
    };

    const result = await Promise.race([operation(), deadline]);
    completed = result.kind !== 'unknown';
    return result;
  } catch {
    // Never expose the provider body, token, original error, or cause.
    return { kind: 'unknown', reason: timedOut ? 'timeout' : failureReason };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) controller.abort();
    const activeReader = reader;
    if (activeReader) {
      if (!completed) discard(() => activeReader.cancel());
      try {
        activeReader.releaseLock();
      } catch {
        // Cleanup cannot replace the sanitized result.
      }
    }
  }
}
