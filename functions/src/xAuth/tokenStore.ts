/**
 * Server-only pending-link persistence.
 * Caller supplies authenticated uid and a trusted server-generated candidateId.
 * No activation, configuration access, provider calls or confirmation policy.
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import { getWritableAccount } from '../account/accountWriteGuard';
import { encrypt } from './crypto';
import type { TokenResult } from './tokenTransport';

const FAILURE = 'X auth token storage failed';
const REQUIRED_SCOPES = [
  'tweet.read', 'tweet.write', 'users.read', 'offline.access',
] as const;

export interface TokenStoreDeps {
  readonly firestore: Firestore;
  /** Epoch milliseconds; provider expiry is captured once per stage call. */
  readonly now: () => number;
  readonly encryptionKey: string;
}

export interface StageTokenInput {
  readonly uid: string;
  /** Trusted server input, never a client-selected candidate identity. */
  readonly candidateId: string;
  readonly tokens: TokenResult;
}

export interface TokenStore {
  stage(input: StageTokenInput): Promise<void>;
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

function requireUid(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    value.length <= 128 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !/^__.*__$/.test(value),
  );
}

function requireCandidateId(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    value.length <= 1500 &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    !/^__.*__$/.test(value),
  );
}

function requireScope(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(value),
  );
  const granted = new Set(value.split(' '));
  requireValue(REQUIRED_SCOPES.every((scope) => granted.has(scope)));
}

function timestamp(milliseconds: number): Timestamp {
  requireValue(Number.isSafeInteger(milliseconds));
  // Timestamp validates the Firestore range, year 1 through year 9999.
  return Timestamp.fromMillis(milliseconds);
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  return {
    stage: async (input) => {
      try {
        // Capture primitive values before awaiting; retries use the same result.
        const { uid, candidateId } = input;
        const { accessToken, refreshToken, tokenType, expiresIn, scope } = input.tokens;
        requireUid(uid);
        requireCandidateId(candidateId);
        requireText(accessToken);
        requireText(refreshToken);
        requireValue(tokenType === 'Bearer');
        requireScope(scope);
        requireValue(Number.isSafeInteger(expiresIn) && expiresIn > 0);

        const startedAt = deps.now();
        timestamp(startedAt);
        const duration = expiresIn * 1000;
        requireValue(Number.isSafeInteger(duration));
        const expiresAt = timestamp(startedAt + duration);
        const pendingLink = {
          candidateId,
          encryptedAccessToken: encrypt(accessToken, deps.encryptionKey, {
            uid, purpose: 'accessToken',
          }),
          encryptedRefreshToken: encrypt(refreshToken, deps.encryptionKey, {
            uid, purpose: 'refreshToken',
          }),
          expiresAt,
          scope,
        };
        const userRef = deps.firestore.doc(`users/${uid}`);
        const tokenRef = deps.firestore.doc(`xTokens/${uid}`);

        await deps.firestore.runTransaction(async (tx) => {
          await getWritableAccount(tx, userRef);
          const snapshot = await tx.get(tokenRef);
          const currentTime = deps.now();
          timestamp(currentTime);
          requireValue(currentTime < expiresAt.toMillis());
          // Replace this map only; preserve active credentials and oauthStates.
          if (snapshot.exists) tx.update(tokenRef, { pendingLink });
          else tx.create(tokenRef, { pendingLink });
        });
      } catch {
        // Never expose input, provider tokens, account reason or SDK errors.
        throw new Error(FAILURE);
      }
    },
  };
}
