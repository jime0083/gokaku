/**
 * Server-only profile HTTP transport. Caller injects fetch and the decrypted
 * user access token. No environment, persistence, logging, or global fetch.
 */
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { TextDecoder } from 'node:util';

const PROFILE_ENDPOINT = 'https://api.x.com/2/users/me?user.fields=profile_image_url';
const FAILURE = 'X profile request failed';

export const PROFILE_TIMEOUT_MS = 10_000;
export const PROFILE_RESPONSE_MAX_BYTES = 64 * 1024;

export interface ProfileRequest {
  readonly method: 'GET';
  readonly headers: Record<string, string>;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

export type ProfileFetch = (
  url: string,
  init: ProfileRequest,
) => Promise<Pick<Response, 'status' | 'body'>>;

export interface ProfileResult {
  readonly id: string;
  readonly username: string;
  readonly profileImageUrl: string | null;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireObject(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
}

function validateImage(value: unknown): string {
  requireValue(typeof value === 'string');
  const image = value as string;
  requireValue(
    /^https:\/\//i.test(image) &&
      Buffer.from(image, 'utf8').toString('utf8') === image &&
      !image.includes('#') &&
      !image.includes('\\') &&
      Array.from(image).every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x20 && (code < 0x7f || code > 0x9f);
      }),
  );
  const url = new URL(image);
  const authority = image.slice('https://'.length).split(/[/?#]/, 1)[0];
  requireValue(
    url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      !authority.includes('@'),
  );
  return image;
}

function validateResponse(value: unknown): ProfileResult {
  requireObject(value);
  const data = value.data;
  requireObject(data);
  const id = data.id;
  const username = data.username;
  requireValue(typeof id === 'string' && id.length > 0 && !/[^0-9]/.test(id));
  requireValue(
    typeof username === 'string' &&
      username.length > 0 &&
      username.length <= 15 &&
      !/[^A-Za-z0-9_]/.test(username),
  );
  const profileImageUrl = Object.prototype.hasOwnProperty.call(data, 'profile_image_url')
    ? validateImage(data.profile_image_url)
    : null;
  return { id: id as string, username: username as string, profileImageUrl };
}

/** Cleanup must neither leak a raw error nor extend the request deadline. */
function discard(operation: () => Promise<unknown>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Cleanup errors are intentionally discarded.
  }
}

export async function requestProfile(
  fetch: ProfileFetch,
  accessToken: string,
): Promise<ProfileResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const controller = new AbortController();
  let completed = false;
  try {
    requireValue(
      typeof accessToken === 'string' &&
        accessToken.length > 0 &&
        Array.from(accessToken).every((character) => {
          const code = character.charCodeAt(0);
          return code >= 0x21 && code <= 0x7e;
        }),
    );
    // Also bounds injected fetch/readers that ignore AbortSignal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(FAILURE));
        controller.abort();
      }, PROFILE_TIMEOUT_MS);
    });
    const operation = async (): Promise<ProfileResult> => {
      const response = await fetch(PROFILE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        const lateBody = response.body;
        if (lateBody) discard(() => lateBody.cancel());
        throw new Error(FAILURE);
      }
      reader = response.body?.getReader();
      requireValue(response.status === 200 && reader !== undefined);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        requireValue(!controller.signal.aborted);
        if (chunk.done) break;
        requireValue(chunk.value instanceof Uint8Array);
        size += chunk.value.byteLength;
        requireValue(size <= PROFILE_RESPONSE_MAX_BYTES);
        chunks.push(chunk.value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size),
      );
      return validateResponse(JSON.parse(text) as unknown);
    };
    const result = await Promise.race([operation(), deadline]);
    completed = true;
    return result;
  } catch {
    // Never expose the provider response, request, original error, or cause.
    throw new Error(FAILURE);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) controller.abort();
    const activeReader = reader;
    if (activeReader) {
      if (!completed) discard(() => activeReader.cancel());
      try {
        activeReader.releaseLock();
      } catch {
        // Cleanup cannot change the sanitized result.
      }
    }
  }
}
