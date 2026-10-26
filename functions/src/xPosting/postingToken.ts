/**
 * Server-internal posting credentials. Never expose ready through a callable or log.
 * Dependencies are injected; this module has no configuration or posting policy.
 */
import { Timestamp } from 'firebase-admin/firestore';

import type { ActiveSnapshot, ActiveTokenStore } from '../xAuth/activeTokenStore';
import { decrypt } from '../xAuth/crypto';
import {
  requestTokenOutcome,
  type TokenCredentials,
  type TokenFetch,
  type TokenOAuthError,
  type TokenOutcome,
  type TokenResult,
} from '../xAuth/tokenTransport';

const FAILURE = 'X posting token operation failed';
const CLAIM_TTL_MS = 30_000;

interface PostingTokenProviderDeps {
  readonly store: ActiveTokenStore;
  readonly fetch: TokenFetch;
  readonly credentials: TokenCredentials;
  readonly encryptionKey: string;
  readonly now: () => number;
  readonly newClaimId: () => string;
}

type PostingTokenResult =
  | {
      readonly kind: 'ready';
      readonly accessToken: string;
      readonly linkRevision: number;
      readonly candidateId: string;
    }
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'relink_required';
      readonly reason: 'unlinked' | 'blocked' | 'invalid_grant' | 'unknown_refresh';
    }
  | { readonly kind: 'link_changed' }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly oauthError?: TokenOAuthError;
    };

interface PostingTokenProvider {
  acquire(
    uid: string, expectedLinkRevision: number, forceRefresh?: boolean,
  ): Promise<PostingTokenResult>;
}

type Observation =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'current'; readonly snapshot: ActiveSnapshot };

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireText(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' && value.trim().length > 0 &&
    Buffer.from(value, 'utf8').toString('utf8') === value,
  );
}

function requireUid(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    value.length <= 128 && !value.includes('/') &&
    value !== '.' && value !== '..' && !/^__.*__$/.test(value),
  );
}

function requireId(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    value.length <= 1500 && /^[A-Za-z0-9_-]+$/.test(value) &&
    !/^__.*__$/.test(value),
  );
}

function requireRevision(value: unknown): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function checkedTime(value: number): number {
  requireValue(Number.isSafeInteger(value));
  requireValue(Timestamp.fromMillis(value).toMillis() === value);
  return value;
}

function sameGeneration(a: ActiveSnapshot, b: ActiveSnapshot): boolean {
  return a.uid === b.uid && a.linkRevision === b.linkRevision &&
    a.candidateId === b.candidateId && a.xUserId === b.xUserId;
}

function unknownRefresh(): PostingTokenResult {
  return { kind: 'relink_required', reason: 'unknown_refresh' };
}

export function createPostingTokenProvider(
  deps: PostingTokenProviderDeps,
): PostingTokenProvider {
  try {
    const { store, fetch, encryptionKey, now, newClaimId } = deps;
    requireValue(store !== null && typeof store === 'object');
    requireValue(
      typeof store.read === 'function' && typeof store.claimRefresh === 'function' &&
      typeof store.saveRefresh === 'function' && typeof store.blockRefresh === 'function' &&
      typeof store.releaseRefresh === 'function',
    );
    requireValue(
      typeof fetch === 'function' && typeof now === 'function' &&
      typeof newClaimId === 'function',
    );
    requireText(encryptionKey);
    const credentials: TokenCredentials = {
      clientId: deps.credentials.clientId,
      clientSecret: deps.credentials.clientSecret,
    };
    requireText(credentials.clientId);
    requireText(credentials.clientSecret);

    function currentTime(): number {
      return checkedTime(now());
    }

    /** Copy before awaiting; only the persisted snapshot may supply ready access. */
    function checkedSnapshot(value: ActiveSnapshot, uid: string): ActiveSnapshot {
      requireValue(value !== null && typeof value === 'object');
      const copy: ActiveSnapshot = {
        uid: value.uid,
        linkRevision: value.linkRevision,
        candidateId: value.candidateId,
        xUserId: value.xUserId,
        encryptedAccessToken: value.encryptedAccessToken,
        encryptedRefreshToken: value.encryptedRefreshToken,
        scope: value.scope,
        expiresAt: value.expiresAt,
      };
      requireValue(copy.uid === uid);
      requireRevision(copy.linkRevision);
      requireId(copy.candidateId);
      requireText(copy.xUserId);
      requireValue(/^[0-9]+$/.test(copy.xUserId));
      requireText(copy.scope);
      requireValue(copy.expiresAt instanceof Timestamp);
      const expiresAt = Timestamp.fromMillis(checkedTime(copy.expiresAt.toMillis()));
      requireValue(expiresAt.isEqual(copy.expiresAt));
      requireText(decrypt(copy.encryptedAccessToken, encryptionKey, {
        uid, purpose: 'accessToken',
      }));
      requireText(decrypt(copy.encryptedRefreshToken, encryptionKey, {
        uid, purpose: 'refreshToken',
      }));
      return { ...copy, expiresAt };
    }

    /** Only backend read failures are uncertainty; local validation still throws. */
    async function observe(expected: ActiveSnapshot): Promise<Observation> {
      let value: ActiveSnapshot | null;
      try {
        value = await store.read(expected.uid);
      } catch {
        return { kind: 'unavailable' };
      }
      if (value === null) return { kind: 'changed' };
      const current = checkedSnapshot(value, expected.uid);
      return sameGeneration(expected, current)
        ? { kind: 'current', snapshot: current }
        : { kind: 'changed' };
    }

    function persistedReady(current: ActiveSnapshot): PostingTokenResult {
      if (current.expiresAt.toMillis() <= currentTime()) return unknownRefresh();
      const accessToken = decrypt(current.encryptedAccessToken, encryptionKey, {
        uid: current.uid, purpose: 'accessToken',
      });
      requireText(accessToken);
      return {
        kind: 'ready', accessToken,
        linkRevision: current.linkRevision, candidateId: current.candidateId,
      };
    }

    /** Unknown HTTP never releases its claim, even when blocking fails. */
    async function blockUnknown(
      expected: ActiveSnapshot,
      claimId: string,
      reason: 'invalid_grant' | 'unknown_refresh',
    ): Promise<PostingTokenResult> {
      try {
        await store.blockRefresh(expected.uid, expected, claimId);
      } catch {
        const observation = await observe(expected);
        if (observation.kind === 'changed') return { kind: 'link_changed' };
        throw new Error(FAILURE);
      }
      const observation = await observe(expected);
      if (observation.kind === 'changed') return { kind: 'link_changed' };
      requireValue(observation.kind !== 'unavailable');
      return { kind: 'relink_required', reason };
    }

    async function releaseKnown(
      expected: ActiveSnapshot, claimId: string,
    ): Promise<Observation> {
      try {
        await store.releaseRefresh(expected.uid, expected, claimId);
      } catch {
        const observation = await observe(expected);
        if (observation.kind === 'changed') return observation;
        throw new Error(FAILURE);
      }
      const observation = await observe(expected);
      requireValue(observation.kind !== 'unavailable');
      return observation;
    }

    async function saveAndReload(
      expected: ActiveSnapshot, claimId: string, tokens: TokenResult,
    ): Promise<PostingTokenResult> {
      // Retry only the identical CAS save. Never revisit the HTTP operation.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await store.saveRefresh(expected.uid, expected, claimId, tokens);
          requireValue(result === 'saved' || result === 'already-saved');
        } catch {
          const observation = await observe(expected);
          if (observation.kind === 'changed') return { kind: 'link_changed' };
          if (attempt === 0) continue;
          // Preserve either an inflight claim or its committed saved receipt.
          // Neither is released/replaced after an uncertain save response.
          return unknownRefresh();
        }
        const observation = await observe(expected);
        if (observation.kind === 'changed') return { kind: 'link_changed' };
        if (observation.kind === 'unavailable') return unknownRefresh();
        return persistedReady(observation.snapshot);
      }
      return unknownRefresh();
    }

    async function acquire(
      uid: string, expectedLinkRevision: number, forceRefresh: boolean,
    ): Promise<PostingTokenResult> {
      requireUid(uid);
      requireRevision(expectedLinkRevision);
      requireValue(typeof forceRefresh === 'boolean');
      currentTime();
      const initial = await store.read(uid);
      if (initial === null) return { kind: 'relink_required', reason: 'unlinked' };
      const expected = checkedSnapshot(initial, uid);
      if (expected.linkRevision !== expectedLinkRevision) return { kind: 'link_changed' };

      const claimId = newClaimId();
      requireId(claimId);
      let claim: 'claimed' | 'busy' | 'blocked';
      try {
        claim = await store.claimRefresh(uid, expected, claimId, CLAIM_TTL_MS);
      } catch {
        const observation = await observe(expected);
        if (observation.kind === 'changed') return { kind: 'link_changed' };
        // A same-generation backend failure is not a busy/blocked result.
        throw new Error(FAILURE);
      }
      if (claim === 'busy') return { kind: 'busy' };
      if (claim === 'blocked') return { kind: 'relink_required', reason: 'blocked' };
      requireValue(claim === 'claimed');

      if (!forceRefresh && expected.expiresAt.toMillis() > currentTime()) {
        const observation = await releaseKnown(expected, claimId);
        if (observation.kind === 'changed') return { kind: 'link_changed' };
        requireValue(observation.kind === 'current');
        return persistedReady(observation.snapshot);
      }

      const refreshToken = decrypt(expected.encryptedRefreshToken, encryptionKey, {
        uid, purpose: 'refreshToken',
      });
      requireText(refreshToken);
      let outcome: TokenOutcome;
      try {
        outcome = await requestTokenOutcome(fetch, credentials, {
          grantType: 'refresh_token', refreshToken, grantedScope: expected.scope,
        });
      } catch {
        return blockUnknown(expected, claimId, 'unknown_refresh');
      }

      if (outcome.kind === 'tokens') {
        // One stable result object is used for both possible DB save calls.
        const tokens: TokenResult = { ...outcome.tokens };
        return saveAndReload(expected, claimId, tokens);
      }
      if (outcome.kind === 'unknown') {
        return blockUnknown(expected, claimId, 'unknown_refresh');
      }
      if (outcome.kind === 'oauth_error' && outcome.error === 'invalid_grant') {
        return blockUnknown(expected, claimId, 'invalid_grant');
      }
      if (outcome.kind === 'oauth_error' ||
        (outcome.kind === 'http_error' && outcome.status === 429)) {
        const observation = await releaseKnown(expected, claimId);
        if (observation.kind === 'changed') return { kind: 'link_changed' };
        return outcome.kind === 'oauth_error'
          ? { kind: 'rejected', status: outcome.status, oauthError: outcome.error }
          : { kind: 'rejected', status: outcome.status };
      }
      // A neutral non-429 status does not prove refresh was safely refused.
      return blockUnknown(expected, claimId, 'unknown_refresh');
    }

    return {
      acquire: async (uid, expectedLinkRevision, forceRefresh = false) => {
        try {
          return await acquire(uid, expectedLinkRevision, forceRefresh);
        } catch {
          // No backend/provider/crypto input, raw exception or cause escapes.
          throw new Error(FAILURE);
        }
      },
    };
  } catch {
    throw new Error(FAILURE);
  }
}
