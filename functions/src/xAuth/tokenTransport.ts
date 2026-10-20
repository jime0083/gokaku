/**
 * Server-only OAuth HTTP transport. Caller injects fetch and credentials.
 * No environment, persistence, logging, retries, or application policy.
 */
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { TextDecoder } from 'node:util';

const TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';
const FAILURE = 'X OAuth token request failed';
const REQUIRED_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
] as const;

export const TOKEN_TIMEOUT_MS = 10_000;
export const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

export interface TokenCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export type TokenGrant =
  | {
      readonly grantType: 'authorization_code';
      readonly code: string;
      readonly redirectUri: string;
      readonly codeVerifier: string;
    }
  | {
      readonly grantType: 'refresh_token';
      readonly refreshToken: string;
      /** Explicit previously granted scope; never inferred from required scopes. */
      readonly grantedScope: string;
    };

export interface TokenRequest {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: URLSearchParams;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

type TokenResponse = Pick<Response, 'status' | 'body'>;

/** Native server fetch is compatible; no global fetch fallback is provided. */
export type TokenFetch = (
  url: string,
  init: TokenRequest,
) => Promise<TokenResponse>;

export interface TokenResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly scope: string;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireText(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      Buffer.from(value, 'utf8').toString('utf8') === value,
  );
}

function requireScope(value: unknown): asserts value is string {
  requireText(value);
  // RFC6749 scope-token: visible ASCII excluding quote and backslash,
  // separated by a single SP. Match entire tokens, never substrings.
  requireValue(
    /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(value),
  );
  const granted = new Set(value.split(' '));
  requireValue(REQUIRED_SCOPES.every((scope) => granted.has(scope)));
}

/** RFC6749 2.3.1: form-encode each credential before joining with colon. */
function encodeCredential(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

function createBody(grant: TokenGrant): URLSearchParams {
  if (grant.grantType === 'authorization_code') {
    requireText(grant.code);
    requireText(grant.redirectUri);
    requireText(grant.codeVerifier);
    return new URLSearchParams({
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.codeVerifier,
    });
  }
  requireValue(grant.grantType === 'refresh_token');
  requireText(grant.refreshToken);
  requireScope(grant.grantedScope);
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
  });
}

function validateResponse(value: unknown, grant: TokenGrant): TokenResult {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const data = value as Record<string, unknown>;
  requireText(data.access_token);
  requireValue(
    typeof data.token_type === 'string' &&
      data.token_type.toLowerCase() === 'bearer',
  );
  requireValue(
    typeof data.expires_in === 'number' &&
      Number.isSafeInteger(data.expires_in) &&
      data.expires_in > 0,
  );

  const hasRefresh = Object.prototype.hasOwnProperty.call(data, 'refresh_token');
  const hasScope = Object.prototype.hasOwnProperty.call(data, 'scope');
  const refreshToken = !hasRefresh && grant.grantType === 'refresh_token'
    ? grant.refreshToken
    : data.refresh_token;
  const scope = !hasScope && grant.grantType === 'refresh_token'
    ? grant.grantedScope
    : data.scope;
  requireText(refreshToken);
  requireScope(scope);
  return {
    accessToken: data.access_token,
    tokenType: 'Bearer',
    expiresIn: data.expires_in,
    refreshToken,
    scope,
  };
}

/** Cleanup must neither leak a raw error nor extend the request deadline. */
function discard(operation: () => Promise<unknown>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Cleanup errors are intentionally discarded.
  }
}

export async function requestTokens(
  fetch: TokenFetch,
  credentials: TokenCredentials,
  grant: TokenGrant,
): Promise<TokenResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const controller = new AbortController();
  let completed = false;
  try {
    requireText(credentials.clientId);
    requireText(credentials.clientSecret);
    const body = createBody(grant);
    const authorization = Buffer.from(
      `${encodeCredential(credentials.clientId)}:${encodeCredential(credentials.clientSecret)}`,
      'utf8',
    ).toString('base64');

    // Race also bounds an injected fetch/reader that ignores AbortSignal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(FAILURE));
        controller.abort();
      }, TOKEN_TIMEOUT_MS);
    });
    const operation = async (): Promise<TokenResult> => {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
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
        requireValue(size <= TOKEN_RESPONSE_MAX_BYTES);
        chunks.push(chunk.value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size),
      );
      return validateResponse(JSON.parse(text) as unknown, grant);
    };

    const result = await Promise.race([operation(), deadline]);
    completed = true;
    return result;
  } catch {
    // Never attach the provider response, request, original error, or cause.
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
