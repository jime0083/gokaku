/**
 * Pure browser driver. OAuth state/PKCE validation and token exchange remain
 * server responsibilities. The injected signature accepts Expo 57's
 * openAuthSessionAsync without importing its native module.
 */
export interface SessionResult {
  readonly type: string;
  readonly url?: string;
}

export type OpenSession = (
  url: string,
  redirectUrl: string,
  options: { preferEphemeralSession: boolean },
) => Promise<SessionResult>;

export type AuthBrowserResult =
  | { type: 'success'; state: string; code: string }
  | { type: 'cancel' };

export interface AuthBrowserOptions {
  readonly differentAccount?: boolean;
}

const FAILURE = 'x-auth-browser-failed';
// Defensive parser limits, independent of provider/product expiry policies.
const MAX_URL_LENGTH = 16384;
const MAX_VALUE_LENGTH = 4096;
const AUTHORIZE_BASE = 'https://x.com/i/oauth2/authorize';
const REDIRECT_PROTOCOL = 'gokaku:';
const RESERVED = new Set(['code', 'state', 'error']);
const RESPONSE_KEYS = new Set([
  'code', 'state', 'error', 'error_description', 'error_uri',
]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireText(value: unknown, limit: number): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= limit);
  requireValue(value.trim().length > 0 && !CONTROL.test(value));
  // encodeURIComponent rejects unpaired UTF-16 surrogates.
  encodeURIComponent(value);
}

interface ParsedUrl {
  readonly url: URL;
  readonly base: string;
  readonly query: Map<string, string>;
}

function parseUrl(value: unknown): ParsedUrl {
  requireText(value, MAX_URL_LENGTH);
  requireValue(value.trim() === value && !/\s/.test(value) && !value.includes('#'));
  // Reject malformed percent escapes, invalid UTF-8 and encoded controls before
  // URLSearchParams can silently replace invalid sequences.
  requireValue(!CONTROL.test(decodeURIComponent(value)));
  const url = new URL(value);
  requireValue(url.username === '' && url.password === '' && url.port === '');
  const base = value.split('?')[0];
  // Refuse URL-parser normalization (dot segments, case changes, backslashes).
  requireValue(base === `${url.protocol}//${url.host}${url.pathname}`);
  const query = new Map<string, string>();
  url.searchParams.forEach((entry, key) => {
    requireText(key, MAX_VALUE_LENGTH);
    requireText(entry, MAX_VALUE_LENGTH);
    requireValue(!query.has(key));
    query.set(key, entry);
  });
  return { url, base, query };
}

function required(query: Map<string, string>, key: string): string {
  const value = query.get(key);
  requireText(value, MAX_VALUE_LENGTH);
  return value;
}

function parseRequest(authorizationUrl: string): {
  state: string;
  redirectUrl: string;
  redirect: ParsedUrl;
} {
  const request = parseUrl(authorizationUrl);
  requireValue(request.base === AUTHORIZE_BASE);
  const state = required(request.query, 'state');
  const redirectUrl = required(request.query, 'redirect_uri');
  const redirect = parseUrl(redirectUrl);
  requireValue(redirect.url.protocol === REDIRECT_PROTOCOL);
  redirect.query.forEach((_value, key) => {
    requireValue(!RESERVED.has(key));
  });
  return { state, redirectUrl, redirect };
}

function parseCallback(
  callbackUrl: unknown,
  expectedState: string,
  redirect: ParsedUrl,
): AuthBrowserResult {
  const callback = parseUrl(callbackUrl);
  requireValue(
    callback.base === redirect.base &&
    callback.url.protocol === redirect.url.protocol &&
    callback.url.host === redirect.url.host &&
    callback.url.pathname === redirect.url.pathname,
  );
  redirect.query.forEach((value, key) => {
    requireValue(callback.query.get(key) === value);
  });
  callback.query.forEach((_value, key) => {
    requireValue(redirect.query.has(key) || RESPONSE_KEYS.has(key));
  });
  const state = required(callback.query, 'state');
  requireValue(state === expectedState);
  if (callback.query.has('error')) {
    requireValue(!callback.query.has('code'));
    requireValue(required(callback.query, 'error') === 'access_denied');
    return { type: 'cancel' };
  }
  // Static query values must not be mistaken for OAuth response fields.
  requireValue(
    !['error_description', 'error_uri'].some(
      (key) => callback.query.has(key) && !redirect.query.has(key),
    ),
  );
  return { type: 'success', state, code: required(callback.query, 'code') };
}

export function createAuthBrowser(openSession: OpenSession): {
  open(
    authorizationUrl: string,
    options?: AuthBrowserOptions,
  ): Promise<AuthBrowserResult>;
} {
  let inFlight = false;
  return {
    async open(authorizationUrl, options = {}) {
      // A rejected second call must not release the first call's gate.
      if (inFlight) throw new Error(FAILURE);
      inFlight = true;
      try {
        const { state, redirectUrl, redirect } = parseRequest(authorizationUrl);
        const result = await openSession(authorizationUrl, redirectUrl, {
          preferEphemeralSession: options.differentAccount === true,
        });
        if (result.type === 'cancel' || result.type === 'dismiss') {
          return { type: 'cancel' };
        }
        requireValue(result.type === 'success');
        return parseCallback(result.url, state, redirect);
      } catch {
        // Do not retain native errors, URLs, codes or causes.
        throw new Error(FAILURE);
      } finally {
        inFlight = false;
      }
    },
  };
}
