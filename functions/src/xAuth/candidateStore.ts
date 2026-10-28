/**
 * Server-only candidate persistence; never re-export to app/shared/public results.
 * uid is authenticated by the caller; profiles come only from server transport.
 * No HTTP, configuration lookup, plaintext return, or additional expiry policy.
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { getWritableAccount } from '../account/accountWriteGuard';
import { buildServerHistory } from '../dailyJudgement/serverHistory';
import { readXNotice } from '../domain';
import { decrypt } from './crypto';
import type { ProfileResult } from './profileTransport';

const FAILURE = 'X auth candidate operation failed';
const REQUIRED_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

export interface CandidateStoreDeps {
  readonly firestore: Firestore;
  /** Epoch milliseconds; read again on every transaction attempt. */
  readonly now: () => number;
  readonly encryptionKey: string;
}

/** Same contract as server profile transport; never accept client profiles. */
export type CandidateProfile = ProfileResult;

/** Internal secret-bearing result. Not a callable/public response type. */
export interface PendingCandidate {
  readonly candidateId: string;
  readonly encryptedAccessToken: string;
  readonly encryptedRefreshToken: string;
  readonly expiresAt: Timestamp;
  readonly scope: string;
  readonly profile?: CandidateProfile;
}

export interface CandidateStore {
  get(uid: string): Promise<PendingCandidate | null>;
  attachProfile(
    uid: string,
    candidateId: string,
    expectedEncryptedAccessToken: string,
    serverProfile: CandidateProfile,
  ): Promise<void>;
  confirm(uid: string, candidateId: string, postEnabled: boolean): Promise<void>;
  discard(uid: string, candidateId: string): Promise<void>;
}

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

function requireCandidateId(value: unknown): asserts value is string {
  requireText(value);
  requireValue(
    value.length <= 1500 && /^[A-Za-z0-9_-]+$/.test(value) &&
    !/^__.*__$/.test(value),
  );
}

function requireMap(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null),
  );
}

function profile(value: unknown): CandidateProfile {
  requireMap(value);
  const { id, username, profileImageUrl } = value;
  requireText(id);
  requireText(username);
  requireValue(
    !/[^0-9]/.test(id) &&
    username.length <= 15 && !/[^A-Za-z0-9_]/.test(username),
  );
  if (profileImageUrl !== null) {
    requireValue(typeof profileImageUrl === 'string');
    // Match profileTransport's image validation without importing runtime HTTP code.
    requireValue(
      /^https:\/\//i.test(profileImageUrl) &&
      Buffer.from(profileImageUrl, 'utf8').toString('utf8') === profileImageUrl &&
      !profileImageUrl.includes('#') &&
      !profileImageUrl.includes('\\') &&
      Array.from(profileImageUrl).every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x20 && (code < 0x7f || code > 0x9f);
      }),
    );
    const url = new URL(profileImageUrl);
    const authority = profileImageUrl.slice('https://'.length).split(/[/?#]/, 1)[0];
    requireValue(
      url.protocol === 'https:' && url.hostname.length > 0 &&
      url.username === '' && url.password === '' && !authority.includes('@'),
    );
  }
  // null is the approved missing-image representation, not an inferred fallback.
  // Copy only trusted display/identity fields, never arbitrary provider fields.
  return { id, username, profileImageUrl };
}

function timestamp(milliseconds: number): Timestamp {
  requireValue(Number.isSafeInteger(milliseconds));
  return Timestamp.fromMillis(milliseconds);
}

function expiry(value: unknown): Timestamp {
  requireValue(value instanceof Timestamp);
  requireValue(timestamp(value.toMillis()).isEqual(value));
  return value;
}

function scope(value: unknown): string {
  requireText(value);
  requireValue(
    /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(value),
  );
  const granted = new Set(value.split(' '));
  requireValue(REQUIRED_SCOPES.every((item) => granted.has(item)));
  return value;
}

/** Authenticate both envelopes against exact UID/purpose without returning plaintext. */
function candidate(value: unknown, uid: string, key: string): PendingCandidate {
  requireMap(value);
  requireCandidateId(value.candidateId);
  requireText(value.encryptedAccessToken);
  requireText(value.encryptedRefreshToken);
  const expiresAt = expiry(value.expiresAt);
  const grantedScope = scope(value.scope);
  requireText(decrypt(value.encryptedAccessToken, key, { uid, purpose: 'accessToken' }));
  requireText(decrypt(value.encryptedRefreshToken, key, { uid, purpose: 'refreshToken' }));
  return {
    candidateId: value.candidateId,
    encryptedAccessToken: value.encryptedAccessToken,
    encryptedRefreshToken: value.encryptedRefreshToken,
    expiresAt,
    scope: grantedScope,
    ...(Object.hasOwn(value, 'profile') ? { profile: profile(value.profile) } : {}),
  };
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(FAILURE);
  }
}

export function createCandidateStore(deps: CandidateStoreDeps): CandidateStore {
  function currentTime(): number {
    const now = deps.now();
    timestamp(now);
    return now;
  }

  return {
    get: (uid) => guarded(async () => {
      requireUid(uid);
      const userRef = deps.firestore.doc('users/' + uid);
      const tokenRef = deps.firestore.doc('xTokens/' + uid);
      return deps.firestore.runTransaction(async (tx) => {
        await getWritableAccount(tx, userRef);
        const data = (await tx.get(tokenRef)).data();
        if (data === undefined || !Object.hasOwn(data, 'pendingLink')) return null;
        const pending = candidate(data.pendingLink, uid, deps.encryptionKey);
        return pending.expiresAt.toMillis() > currentTime() ? pending : null;
      });
    }),

    attachProfile: (uid, candidateId, expectedEncryptedAccessToken, serverProfile) =>
      guarded(async () => {
        requireUid(uid);
        requireCandidateId(candidateId);
        requireText(expectedEncryptedAccessToken);
        // Snapshot caller-owned input before the first await and transaction retries.
        const trustedProfile = profile(serverProfile);
        const userRef = deps.firestore.doc('users/' + uid);
        const tokenRef = deps.firestore.doc('xTokens/' + uid);
        await deps.firestore.runTransaction(async (tx) => {
          await getWritableAccount(tx, userRef);
          const data = (await tx.get(tokenRef)).data();
          const pending = candidate(data?.pendingLink, uid, deps.encryptionKey);
          requireValue(
            pending.candidateId === candidateId &&
            pending.encryptedAccessToken === expectedEncryptedAccessToken &&
            pending.expiresAt.toMillis() > currentTime(),
          );
          requireMap(data?.pendingLink);
          tx.update(tokenRef, {
            pendingLink: { ...data.pendingLink, profile: trustedProfile },
          });
        });
      }),

    confirm: (uid, candidateId, postEnabled) => guarded(async () => {
      requireUid(uid);
      requireCandidateId(candidateId);
      requireValue(typeof postEnabled === 'boolean');
      const userRef = deps.firestore.doc('users/' + uid);
      const tokenRef = deps.firestore.doc('xTokens/' + uid);
      await deps.firestore.runTransaction(async (tx) => {
        const current = (await getWritableAccount(tx, userRef)).data()!;
        const data = (await tx.get(tokenRef)).data();
        requireValue(data !== undefined);
        if (Object.hasOwn(data, 'confirmedLink')) {
          const receipt = data.confirmedLink;
          requireMap(receipt);
          requireCandidateId(receipt.candidateId);
          requireValue(typeof receipt.postEnabled === 'boolean');
          if (receipt.candidateId === candidateId) {
            requireValue(receipt.postEnabled === postEnabled);
            // Lost-response retry: preserve later user settings and newer candidates.
            return;
          }
        }
        // A different receipt is not proof for this request. A matching NEW pending
        // candidate can still be confirmed, replacing the previous small receipt.
        const pending = candidate(data.pendingLink, uid, deps.encryptionKey);
        // Sample once per callback after reads; receipt replays return above.
        const confirmedAt = currentTime();
        requireValue(
          pending.candidateId === candidateId &&
          pending.expiresAt.toMillis() > confirmedAt &&
          pending.profile !== undefined,
        );
        const trustedProfile = pending.profile;
        const userUpdatePatch = {
          xLinked: true,
          xUsername: trustedProfile.username,
          xPostEnabled: postEnabled,
        };
        const history = buildServerHistory(current, userUpdatePatch);
        // Validate existing notice even for legacy new confirmations, but never
        // infer a revision when the history writer produced no counter patch.
        const notice = readXNotice(current.xNotice);
        const newLinkRevision = history.counterPatch['judgementRevisions.xLink'];
        const noticePatch = notice !== null && notice.kind === 'relink_required'
          && notice.readAt === null && newLinkRevision !== undefined
          && notice.linkRevision < newLinkRevision
          ? { xNotice: { ...notice, readAt: confirmedAt } } : {};
        tx.update(tokenRef, {
          encryptedAccessToken: pending.encryptedAccessToken,
          encryptedRefreshToken: pending.encryptedRefreshToken,
          expiresAt: pending.expiresAt,
          scope: pending.scope,
          xUserId: trustedProfile.id,
          pendingLink: FieldValue.delete(),
          confirmedLink: { candidateId, postEnabled },
        });
        tx.update(userRef, {
          ...userUpdatePatch,
          ...history.counterPatch,
          ...noticePatch,
        });
        for (const entry of history.entries) {
          const entryRef = deps.firestore.doc(
            userRef.path + '/judgementHistory/' + entry.stream +
            '/entries/' + entry.revisionId,
          );
          tx.create(entryRef, entry.data);
        }
      });
    }),

    discard: (uid, candidateId) => guarded(async () => {
      requireUid(uid);
      requireCandidateId(candidateId);
      const userRef = deps.firestore.doc('users/' + uid);
      const tokenRef = deps.firestore.doc('xTokens/' + uid);
      await deps.firestore.runTransaction(async (tx) => {
        await getWritableAccount(tx, userRef);
        const data = (await tx.get(tokenRef)).data();
        // Lost-response retry: absence is success only under a writable parent.
        if (data === undefined || !Object.hasOwn(data, 'pendingLink')) return;
        requireMap(data.pendingLink);
        requireCandidateId(data.pendingLink.candidateId);
        requireValue(data.pendingLink.candidateId === candidateId);
        tx.update(tokenRef, { pendingLink: FieldValue.delete() });
      });
    }),
  };
}
