/**
 * Server-only active credential persistence.
 * Callers provide authenticated UID, server-generated claim IDs and server time.
 * No HTTP, scheduler, environment lookup, user notification or root writes.
 */
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import { getWritableAccount } from '../account/accountWriteGuard';
import { decrypt, encrypt } from './crypto';
import type { TokenResult } from './tokenTransport';

const FAILURE = 'X auth active token operation failed';
const REQUIRED_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const ACTIVE_FIELDS = [
  'encryptedAccessToken', 'encryptedRefreshToken', 'expiresAt',
  'scope', 'xUserId', 'confirmedLink',
] as const;

export interface ActiveTokenStoreDeps {
  readonly firestore: Firestore;
  /** Trusted server epoch milliseconds; checked again on each transaction attempt. */
  readonly now: () => number;
  readonly encryptionKey: string;
}

/** Internal encrypted snapshot, never a callable/public result. */
export interface ActiveSnapshot {
  readonly uid: string;
  readonly linkRevision: number;
  readonly candidateId: string;
  readonly xUserId: string;
  readonly encryptedAccessToken: string;
  readonly encryptedRefreshToken: string;
  readonly scope: string;
  readonly expiresAt: Timestamp;
}

export interface ActiveTokenStore {
  read(uid: string): Promise<ActiveSnapshot | null>;
  claimRefresh(
    uid: string, expected: ActiveSnapshot, claimId: string, ttlMs: number,
  ): Promise<'claimed' | 'busy' | 'blocked'>;
  saveRefresh(
    uid: string, expected: ActiveSnapshot, claimId: string, tokens: TokenResult,
  ): Promise<'saved' | 'already-saved'>;
  blockRefresh(uid: string, expected: ActiveSnapshot, claimId: string): Promise<void>;
  /** Only call after a known refusal, never after an unknown HTTP outcome. */
  releaseRefresh(uid: string, expected: ActiveSnapshot, claimId: string): Promise<void>;
}

type ControlBase = {
  readonly schemaVersion: 1;
  readonly claimId: string;
  readonly expected: ActiveSnapshot;
  readonly expiresAt: Timestamp;
};

type RefreshControl = ControlBase & (
  | { readonly state: 'inflight' | 'blocked' | 'released' }
  | { readonly state: 'saved'; readonly saved: ActiveSnapshot }
);

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireMap(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null),
  );
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

/** Trusted server UUID/base64url-style identity, never a path or client choice. */
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

function grantedScope(value: unknown): string {
  requireText(value);
  requireValue(
    /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(value),
  );
  const granted = new Set(value.split(' '));
  requireValue(REQUIRED_SCOPES.every((item) => granted.has(item)));
  return value;
}

function timestamp(milliseconds: number): Timestamp {
  requireValue(Number.isSafeInteger(milliseconds));
  return Timestamp.fromMillis(milliseconds);
}

function storedTimestamp(value: unknown): Timestamp {
  requireValue(value instanceof Timestamp);
  const copy = timestamp(value.toMillis());
  requireValue(copy.isEqual(value));
  return copy;
}

/** Copy primitives and timestamps before any await; never retain caller maps. */
function snapshot(value: unknown, uid: string, key: string): ActiveSnapshot {
  requireMap(value);
  requireValue(value.uid === uid);
  requireRevision(value.linkRevision);
  requireId(value.candidateId);
  requireText(value.xUserId);
  requireValue(/^[0-9]+$/.test(value.xUserId));
  requireText(value.encryptedAccessToken);
  requireText(value.encryptedRefreshToken);
  const scope = grantedScope(value.scope);
  const expiresAt = storedTimestamp(value.expiresAt);
  requireText(decrypt(value.encryptedAccessToken, key, { uid, purpose: 'accessToken' }));
  requireText(decrypt(value.encryptedRefreshToken, key, { uid, purpose: 'refreshToken' }));
  return {
    uid,
    linkRevision: value.linkRevision,
    candidateId: value.candidateId,
    xUserId: value.xUserId,
    encryptedAccessToken: value.encryptedAccessToken,
    encryptedRefreshToken: value.encryptedRefreshToken,
    scope,
    expiresAt,
  };
}

function sameGeneration(a: ActiveSnapshot, b: ActiveSnapshot): boolean {
  return a.uid === b.uid && a.linkRevision === b.linkRevision &&
    a.candidateId === b.candidateId;
}

function sameSnapshot(a: ActiveSnapshot, b: ActiveSnapshot): boolean {
  return sameGeneration(a, b) && a.xUserId === b.xUserId &&
    a.encryptedAccessToken === b.encryptedAccessToken &&
    a.encryptedRefreshToken === b.encryptedRefreshToken &&
    a.scope === b.scope && a.expiresAt.isEqual(b.expiresAt);
}

function control(value: unknown, uid: string, key: string): RefreshControl {
  requireMap(value);
  requireValue(value.schemaVersion === 1);
  requireId(value.claimId);
  const expected = snapshot(value.expected, uid, key);
  const expiresAt = storedTimestamp(value.expiresAt);
  const base: ControlBase = {
    schemaVersion: 1, claimId: value.claimId, expected, expiresAt,
  };
  if (value.state === 'saved') {
    const saved = snapshot(value.saved, uid, key);
    requireValue(sameGeneration(expected, saved) && expected.xUserId === saved.xUserId);
    return { ...base, state: 'saved', saved };
  }
  requireValue(
    value.state === 'inflight' || value.state === 'blocked' || value.state === 'released',
  );
  return { ...base, state: value.state };
}

function providerTokens(value: unknown): TokenResult {
  requireMap(value);
  requireText(value.accessToken);
  requireText(value.refreshToken);
  requireValue(value.tokenType === 'Bearer');
  requireValue(
    typeof value.expiresIn === 'number' &&
    Number.isSafeInteger(value.expiresIn) && value.expiresIn > 0 &&
    Number.isSafeInteger(value.expiresIn * 1000),
  );
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tokenType: 'Bearer',
    expiresIn: value.expiresIn,
    scope: grantedScope(value.scope),
  };
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // No raw account/backend/cryptography error, input, tokens or cause.
    throw new Error(FAILURE);
  }
}

export function createActiveTokenStore(deps: ActiveTokenStoreDeps): ActiveTokenStore {
  const { firestore, now, encryptionKey } = deps;

  function currentTime(): number {
    const value = now();
    timestamp(value);
    return value;
  }

  async function load(tx: Transaction, uid: string) {
    const userRef = firestore.doc('users/' + uid);
    const tokenRef = firestore.doc('xTokens/' + uid);
    // Re-executed inside every transaction attempt, before any queued write.
    const user = (await getWritableAccount(tx, userRef)).data();
    requireMap(user);
    const data = (await tx.get(tokenRef)).data();
    const hasActive = data !== undefined &&
      ACTIVE_FIELDS.some((field) => Object.hasOwn(data, field));
    if (!hasActive && user.xLinked === false) {
      return { tokenRef, data, current: null };
    }
    requireValue(user.xLinked === true);
    requireMap(data);
    requireMap(user.judgementRevisions);
    requireMap(data.confirmedLink);
    requireValue(typeof data.confirmedLink.postEnabled === 'boolean');
    const current = snapshot({
      uid,
      linkRevision: user.judgementRevisions.xLink,
      candidateId: data.confirmedLink.candidateId,
      xUserId: data.xUserId,
      encryptedAccessToken: data.encryptedAccessToken,
      encryptedRefreshToken: data.encryptedRefreshToken,
      scope: data.scope,
      expiresAt: data.expiresAt,
    }, uid, encryptionKey);
    return { tokenRef, data, current };
  }

  function existingControl(data: Record<string, unknown>, uid: string) {
    return Object.hasOwn(data, 'refreshControl')
      ? control(data.refreshControl, uid, encryptionKey)
      : null;
  }

  function owned(
    active: RefreshControl | null, expected: ActiveSnapshot, claimId: string,
  ): asserts active is RefreshControl {
    requireValue(
      active !== null && active.claimId === claimId &&
      sameSnapshot(active.expected, expected),
    );
  }

  return {
    read: (uid) => guarded(async () => {
      requireUid(uid);
      return firestore.runTransaction(async (tx) => (await load(tx, uid)).current);
    }),

    claimRefresh: (uid, expectedSnapshot, claimId, ttlMs) => guarded(async () => {
      requireUid(uid);
      requireId(claimId);
      const expected = snapshot(expectedSnapshot, uid, encryptionKey);
      requireValue(Number.isSafeInteger(ttlMs) && ttlMs > 0);
      const startedAt = currentTime();
      // Capture once: transaction retries must not extend the lease.
      const expiresAt = timestamp(startedAt + ttlMs);
      requireValue(expiresAt.toMillis() > startedAt);
      return firestore.runTransaction(async (tx) => {
        const { tokenRef, data, current } = await load(tx, uid);
        requireValue(current !== null && sameSnapshot(current, expected));
        requireMap(data);
        const active = existingControl(data, uid);
        const checkedAt = currentTime();
        requireValue(checkedAt >= startedAt);
        if (active !== null) {
          if (sameGeneration(active.expected, current)) {
            if (active.state === 'saved') {
              requireValue(sameSnapshot(active.saved, current));
            } else {
              requireValue(sameSnapshot(active.expected, current));
              if (active.state === 'blocked') return 'blocked';
              if (active.state === 'inflight') {
                if (checkedAt < active.expiresAt.toMillis()) return 'busy';
                // Unknown outcome is terminal for this generation. Never reclaim.
                tx.update(tokenRef, {
                  refreshControl: { ...active, state: 'blocked' },
                });
                return 'blocked';
              }
            }
          } else {
            // Only a newer confirmed candidate authorizes replacing old control.
            requireValue(
              current.linkRevision > active.expected.linkRevision &&
              current.candidateId !== active.expected.candidateId,
            );
          }
          // A released/saved/old-generation identity cannot be reused as a new claim.
          requireValue(claimId !== active.claimId);
        }
        requireValue(checkedAt < expiresAt.toMillis());
        const refreshControl: RefreshControl = {
          schemaVersion: 1, state: 'inflight', claimId, expected, expiresAt,
        };
        tx.update(tokenRef, { refreshControl });
        return 'claimed';
      });
    }),

    saveRefresh: (uid, expectedSnapshot, claimId, tokenResult) => guarded(async () => {
      requireUid(uid);
      requireId(claimId);
      const expected = snapshot(expectedSnapshot, uid, encryptionKey);
      const result = providerTokens(tokenResult);
      const startedAt = currentTime();
      // Provider lifetime is fixed for the call, not recomputed on a retry.
      const expiresAt = timestamp(startedAt + result.expiresIn * 1000);
      let prepared: ActiveSnapshot | undefined;
      return firestore.runTransaction(async (tx) => {
        const { tokenRef, data, current } = await load(tx, uid);
        requireValue(current !== null);
        requireMap(data);
        const active = existingControl(data, uid);
        owned(active, expected, claimId);
        const checkedAt = currentTime();
        requireValue(checkedAt >= startedAt);
        if (active.state === 'saved') {
          // Receipt binds original input and current saved credentials. No encryption
          // and no update on response-loss retries, even after the old lease expires.
          requireValue(sameSnapshot(active.saved, current));
          return 'already-saved';
        }
        requireValue(
          active.state === 'inflight' && sameSnapshot(current, expected) &&
          checkedAt < active.expiresAt.toMillis() && checkedAt < expiresAt.toMillis(),
        );
        if (prepared === undefined) {
          prepared = {
            ...expected,
            encryptedAccessToken: encrypt(result.accessToken, encryptionKey, {
              uid, purpose: 'accessToken',
            }),
            encryptedRefreshToken: encrypt(result.refreshToken, encryptionKey, {
              uid, purpose: 'refreshToken',
            }),
            scope: result.scope,
            expiresAt,
          };
        }
        const refreshControl: RefreshControl = {
          schemaVersion: 1,
          state: 'saved',
          claimId,
          expected,
          expiresAt: active.expiresAt,
          saved: prepared,
        };
        // Existing token document only. Maps unrelated to active refresh are untouched.
        tx.update(tokenRef, {
          encryptedAccessToken: prepared.encryptedAccessToken,
          encryptedRefreshToken: prepared.encryptedRefreshToken,
          scope: prepared.scope,
          expiresAt: prepared.expiresAt,
          refreshControl,
        });
        return 'saved';
      });
    }),

    blockRefresh: (uid, expectedSnapshot, claimId) => guarded(async () => {
      requireUid(uid);
      requireId(claimId);
      const expected = snapshot(expectedSnapshot, uid, encryptionKey);
      await firestore.runTransaction(async (tx) => {
        const { tokenRef, data, current } = await load(tx, uid);
        requireValue(current !== null && sameSnapshot(current, expected));
        requireMap(data);
        const active = existingControl(data, uid);
        owned(active, expected, claimId);
        currentTime();
        if (active.state === 'blocked') return;
        requireValue(active.state === 'inflight');
        // An owner may report an unknown outcome after its lease elapsed.
        tx.update(tokenRef, { refreshControl: { ...active, state: 'blocked' } });
      });
    }),

    releaseRefresh: (uid, expectedSnapshot, claimId) => guarded(async () => {
      requireUid(uid);
      requireId(claimId);
      const expected = snapshot(expectedSnapshot, uid, encryptionKey);
      await firestore.runTransaction(async (tx) => {
        const { tokenRef, data, current } = await load(tx, uid);
        requireValue(current !== null && sameSnapshot(current, expected));
        requireMap(data);
        const active = existingControl(data, uid);
        owned(active, expected, claimId);
        const checkedAt = currentTime();
        requireValue(
          active.state === 'inflight' && checkedAt < active.expiresAt.toMillis(),
        );
        // Retain the released identity so its replay cannot grant HTTP permission.
        tx.update(tokenRef, { refreshControl: { ...active, state: 'released' } });
      });
    }),
  };
}
