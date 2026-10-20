import { defineSecret } from 'firebase-functions/params';

export const X_OAUTH_CLIENT_ID = defineSecret('X_OAUTH_CLIENT_ID');
export const X_OAUTH_CLIENT_SECRET = defineSecret('X_OAUTH_CLIENT_SECRET');
export const X_TOKEN_ENCRYPTION_KEY = defineSecret('X_TOKEN_ENCRYPTION_KEY');
type RuntimeEnvironmentReader = (name: string) => string | undefined;

// Defining these closures must not read the environment or register SDK params.
const readRuntimeEnvironment: RuntimeEnvironmentReader = (name) => process.env[name];

export const X_OAUTH_REDIRECT_URI = {
  value(read: RuntimeEnvironmentReader = readRuntimeEnvironment): string {
    const value = read('X_OAUTH_REDIRECT_URI');
    if (typeof value !== 'string') throw new AuthorizationConfigError();
    return value;
  },
};

export const X_OAUTH_STATE_TTL_SECONDS = {
  value(read: RuntimeEnvironmentReader = readRuntimeEnvironment): number {
    const raw = read('X_OAUTH_STATE_TTL_SECONDS');
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
      throw new AuthorizationConfigError();
    }
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new AuthorizationConfigError();
    }
    return seconds;
  },
};

export class AuthorizationConfigError extends Error {
  constructor() {
    super('X authorization is not configured');
  }
}

function text(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
    value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  ) throw new AuthorizationConfigError();
}

/** Invocation only. No defaults, normalization or secret reads at import time. */
export function readAuthorizationConfig() {
  try {
    const clientId = X_OAUTH_CLIENT_ID.value();
    const clientSecret = X_OAUTH_CLIENT_SECRET.value();
    const encryptionKey = X_TOKEN_ENCRYPTION_KEY.value();
    const redirectUri = X_OAUTH_REDIRECT_URI.value();
    const seconds = X_OAUTH_STATE_TTL_SECONDS.value();
    text(clientId);
    text(clientSecret);
    text(redirectUri);
    if (clientId.trim() !== clientId || /\s/.test(redirectUri)) {
      throw new AuthorizationConfigError();
    }
    const redirect = new URL(redirectUri);
    if (redirect.username || redirect.password || redirectUri.includes('#')) {
      throw new AuthorizationConfigError();
    }
    if (
      typeof encryptionKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)
    ) throw new AuthorizationConfigError();
    const key = Buffer.from(encryptionKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encryptionKey) {
      throw new AuthorizationConfigError();
    }
    const stateTtlMs = seconds * 1000;
    if (
      !Number.isSafeInteger(seconds) || seconds <= 0 ||
      !Number.isSafeInteger(stateTtlMs)
    ) throw new AuthorizationConfigError();
    return {
      credentials: { clientId, clientSecret },
      encryptionKey,
      redirectUri,
      stateTtlMs,
    };
  } catch {
    throw new AuthorizationConfigError();
  }
}
