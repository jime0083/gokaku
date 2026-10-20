/**
 * Server-only internal orchestration. Caller supplies authenticated UID,
 * explicit state TTL, clock, credentials, persistence and HTTP transport.
 * Candidate staging does not confirm linkage or enable posting.
 */
import { randomUUID } from 'node:crypto';

import { createPkce, createPkceChallenge, createState } from './crypto';
import type { StateStore } from './stateStore';
import {
  requestTokens,
  type TokenCredentials,
  type TokenFetch,
  type TokenResult,
} from './tokenTransport';

const FAILURE = 'X authorization flow failed';
const AUTHORIZE_ENDPOINT = 'https://x.com/i/oauth2/authorize';
const REQUIRED_SCOPE = 'tweet.read tweet.write users.read offline.access';
// Defensive input limits, independent of product TTL or UI policy.
const MAX_CALLBACK_LENGTH = 4096;
const MAX_CONFIG_LENGTH = 4096;
const MAX_UID_LENGTH = 128;

export interface StageAuthorizationInput {
  readonly uid: string;
  readonly candidateId: string;
  readonly tokens: TokenResult;
}

export interface AuthorizationFlowDeps {
  readonly stateStore: StateStore;
  readonly fetch: TokenFetch;
  readonly credentials: TokenCredentials;
  readonly redirectUri: string;
  /** Required caller-selected duration. No default TTL policy. */
  readonly stateTtlMs: number;
  /** Epoch milliseconds; required for deterministic expiry. */
  readonly now: () => number;
  readonly stage: (input: StageAuthorizationInput) => Promise<void>;
}

export interface CompleteAuthorizationInput {
  readonly state: string;
  readonly code: string;
}

export interface AuthorizationFlow {
  begin(uid: string): Promise<string>;
  complete(
    uid: string,
    input: CompleteAuthorizationInput,
  ): Promise<{ candidateId: string }>;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

/** Validate without trimming, normalizing or replacing caller input. */
function requireText(value: unknown, limit: number): asserts value is string {
  requireValue(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= limit &&
      value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      Buffer.from(value, 'utf8').toString('utf8') === value,
  );
}

function requireUid(uid: unknown): asserts uid is string {
  requireText(uid, MAX_UID_LENGTH);
  requireValue(
    !uid.includes('/') &&
      uid !== '.' &&
      uid !== '..' &&
      !/^__.*__$/.test(uid),
  );
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Never expose provider errors, input, token data, verifier or cause.
    throw new Error(FAILURE);
  }
}

export function createAuthorizationFlow(
  deps: AuthorizationFlowDeps,
): AuthorizationFlow {
  try {
    requireText(deps.redirectUri, MAX_CONFIG_LENGTH);
    requireValue(deps.redirectUri.trim() === deps.redirectUri);
    requireValue(!/\s/.test(deps.redirectUri));
    const parsedRedirect = new URL(deps.redirectUri);
    requireValue(
      parsedRedirect.username === '' &&
        parsedRedirect.password === '' &&
        !deps.redirectUri.includes('#'),
    );
    requireText(deps.credentials.clientId, MAX_CONFIG_LENGTH);
    requireValue(deps.credentials.clientId.trim() === deps.credentials.clientId);
    requireText(deps.credentials.clientSecret, MAX_CONFIG_LENGTH);
    requireValue(
      Number.isSafeInteger(deps.stateTtlMs) && deps.stateTtlMs > 0,
    );

    // Preserve exact configured strings and prevent later config mutation
    // from changing the redirect/client binding between begin and complete.
    const redirectUri = deps.redirectUri;
    const credentials: TokenCredentials = {
      clientId: deps.credentials.clientId,
      clientSecret: deps.credentials.clientSecret,
    };
    const stateTtlMs = deps.stateTtlMs;
    const { stateStore, fetch, stage, now } = deps;

    return {
      begin: (uid) => guarded(async () => {
        requireUid(uid);
        const createdAt = now();
        requireValue(Number.isSafeInteger(createdAt) && createdAt >= 0);
        const expiresAt = createdAt + stateTtlMs;
        requireValue(
          Number.isSafeInteger(expiresAt) && expiresAt > createdAt,
        );
        const state = createState();
        const pkce = createPkce();
        await stateStore.start({
          uid,
          state,
          pkceVerifier: pkce.verifier,
          redirectUri,
          expiresAt,
        });
        const url = new URL(AUTHORIZE_ENDPOINT);
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: credentials.clientId,
          redirect_uri: redirectUri,
          scope: REQUIRED_SCOPE,
          state,
          code_challenge: pkce.challenge,
          code_challenge_method: pkce.challengeMethod,
        }).toString();
        return url.toString();
      }),

      complete: (uid, input) => guarded(async () => {
        requireUid(uid);
        requireText(input.state, MAX_CALLBACK_LENGTH);
        requireText(input.code, MAX_CALLBACK_LENGTH);
        // Store must commit the UID/redirect-bound, single-use consumption
        // before any token HTTP is attempted.
        const verifier = await stateStore.consume({
          uid,
          state: input.state,
          expectedRedirectUri: redirectUri,
        });
        createPkceChallenge(verifier);
        const tokens = await requestTokens(fetch, credentials, {
          grantType: 'authorization_code',
          code: input.code,
          redirectUri,
          codeVerifier: verifier,
        });
        const candidateId = randomUUID();
        await stage({ uid, candidateId, tokens });
        return { candidateId };
      }),
    };
  } catch {
    throw new Error(FAILURE);
  }
}
