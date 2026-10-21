/**
 * Server-only orchestration. Caller supplies authenticated UID and dependencies.
 * Expiry and atomic writes remain the store's responsibility.
 */
import type { CandidateStore } from './candidateStore';
import { decrypt } from './crypto';
import {
  requestProfile,
  type ProfileFetch,
  type ProfileResult,
} from './profileTransport';

const FAILURE = 'X candidate flow failed';

export interface PublicPendingCandidate {
  readonly candidateId: string;
  readonly profile: ProfileResult;
  /** Epoch milliseconds from the store's existing expiry. */
  readonly expiresAt: number;
}

export interface CandidateFlow {
  getPending(uid: string): Promise<PublicPendingCandidate | null>;
  confirm(uid: string, candidateId: string, postEnabled: boolean): Promise<void>;
  discard(uid: string, candidateId: string): Promise<void>;
}

export interface CandidateFlowDeps {
  readonly store: CandidateStore;
  readonly fetch: ProfileFetch;
  readonly encryptionKey: string;
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Never retain dependency errors, credentials, provider data, or causes.
    throw new Error(FAILURE);
  }
}

export function createCandidateFlow(deps: CandidateFlowDeps): CandidateFlow {
  const { store, fetch, encryptionKey } = deps;
  return {
    getPending: (uid) => guarded(async () => {
      let pending = await store.get(uid);
      if (pending === null) return null;

      if (pending.profile === undefined) {
        const { candidateId, encryptedAccessToken } = pending;
        const accessToken = decrypt(encryptedAccessToken, encryptionKey, {
          uid, purpose: 'accessToken',
        });
        const profile = await requestProfile(fetch, accessToken);
        await store.attachProfile(uid, candidateId, encryptedAccessToken, profile);
        pending = await store.get(uid);
        if (
          pending === null ||
          pending.candidateId !== candidateId ||
          pending.encryptedAccessToken !== encryptedAccessToken
        ) throw new Error(FAILURE);
      }

      const profile = pending.profile;
      if (profile === undefined) throw new Error(FAILURE);
      // Copy only public fields; do not expose store/provider objects.
      return {
        candidateId: pending.candidateId,
        profile: {
          id: profile.id,
          username: profile.username,
          profileImageUrl: profile.profileImageUrl,
        },
        expiresAt: pending.expiresAt.toMillis(),
      };
    }),
    confirm: (uid, candidateId, postEnabled) => guarded(async () => {
      await store.confirm(uid, candidateId, postEnabled);
    }),
    discard: (uid, candidateId) => guarded(async () => {
      await store.discard(uid, candidateId);
    }),
  };
}
