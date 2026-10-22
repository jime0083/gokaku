import { randomBytes, randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';

import { createAuthorizationFlow } from '../authorizationFlow';
import { createCandidateFlow } from '../candidateFlow';
import { createCandidateStore } from '../candidateStore';
import { decrypt, encrypt } from '../crypto';
import type { ProfileFetch } from '../profileTransport';
import { createStateStore } from '../stateStore';
import { createTokenStore } from '../tokenStore';
import type { TokenFetch } from '../tokenTransport';

// Synthetic fixtures only. No environment credentials or real provider HTTP.
const NOW = Date.UTC(2026, 9, 21);
const TTL = 60_000;
const SCOPE = 'tweet.read tweet.write users.read offline.access';
const KEY = randomBytes(32).toString('base64');
const OLD_USER = {
  deletionInProgress: false,
  xLinked: true,
  xUsername: 'fixture_old',
  xPostEnabled: true,
};
const ACCOUNTS = {
  a: { id: '101', username: 'fixture_a' },
  b: { id: '202', username: 'fixture_b' },
} as const;
type Account = keyof typeof ACCOUNTS;

const emulatorSuite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

emulatorSuite('relink through existing flows and real Firestore stores', () => {
  let db: Firestore;
  let uid: string;

  beforeAll(() => {
    if (
      process.env.GCLOUD_PROJECT !== 'demo-gokaku' ||
      !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
    ) {
      throw new Error('Local demo-gokaku Firestore Emulator required');
    }
    db = new Firestore({ projectId: 'demo-gokaku' });
  });

  beforeEach(async () => {
    uid = `oauth-relink-${randomUUID()}`;
    await db.doc(`users/${uid}`).create(OLD_USER);
    await db.doc(`xTokens/${uid}`).create({
      encryptedAccessToken: encrypt('fixture-old-access', KEY, {
        uid, purpose: 'accessToken',
      }),
      encryptedRefreshToken: encrypt('fixture-old-refresh', KEY, {
        uid, purpose: 'refreshToken',
      }),
      expiresAt: Timestamp.fromMillis(NOW + TTL),
      scope: SCOPE,
      xUserId: '100',
      oauthStates: {},
      confirmedLink: { candidateId: 'fixture-old', postEnabled: true },
    });
  });

  afterEach(async () => {
    if (!db || !uid) return;
    try {
      await db.doc(`xTokens/${uid}`).delete();
    } finally {
      await db.doc(`users/${uid}`).delete();
    }
  });

  afterAll(async () => {
    if (db) await db.terminate();
  });

  // Read both documents in one real transaction, including commit timestamps.
  async function snapshot() {
    return db.runTransaction(async (tx) => {
      const [user, token] = await tx.getAll(
        db.doc(`users/${uid}`), db.doc(`xTokens/${uid}`),
      );
      expect(user.exists).toBe(true);
      expect(token.exists).toBe(true);
      return {
        user: user.data()!,
        token: token.data()!,
        userUpdate: user.updateTime!,
        tokenUpdate: token.updateTime!,
      };
    }, { readOnly: true });
  }

  function fixture() {
    const deps = { firestore: db, now: () => NOW, encryptionKey: KEY };
    const tokenStore = createTokenStore(deps);
    const tokenFetch = jest.fn<ReturnType<TokenFetch>, Parameters<TokenFetch>>();
    const profileFetch = jest.fn<ReturnType<ProfileFetch>, Parameters<ProfileFetch>>();
    const authorization = createAuthorizationFlow({
      stateStore: createStateStore(deps),
      fetch: tokenFetch,
      credentials: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      redirectUri: 'gokaku://oauth/callback',
      stateTtlMs: TTL,
      now: () => NOW,
      stage: (input) => tokenStore.stage(input),
    });
    const candidate = createCandidateFlow({
      store: createCandidateStore(deps), fetch: profileFetch, encryptionKey: KEY,
    });

    async function complete(url: string, account: Account) {
      const state = new URL(url).searchParams.get('state');
      expect(state).toEqual(expect.any(String));
      tokenFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: `fixture-${account}-access`,
        refresh_token: `fixture-${account}-refresh`,
        token_type: 'Bearer',
        expires_in: TTL / 1000,
        scope: SCOPE,
      })));
      return authorization.complete(uid, { state: state!, code: `fixture-${account}-code` });
    }

    async function profile(account: Account, candidateId: string) {
      profileFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: ACCOUNTS[account] })),
      );
      await expect(candidate.getPending(uid)).resolves.toEqual({
        candidateId,
        profile: { ...ACCOUNTS[account], profileImageUrl: null },
        expiresAt: NOW + TTL,
      });
      expect(profileFetch.mock.calls.at(-1)?.[1].headers.Authorization)
        .toBe(`Bearer fixture-${account}-access`);
    }

    async function pending(account: Account) {
      const result = await complete(await authorization.begin(uid), account);
      await profile(account, result.candidateId);
      return result.candidateId;
    }

    return { authorization, candidate, tokenFetch, profileFetch, complete, profile, pending };
  }

  it('keeps the old link through begin, staging, profile failure and discard; confirm atomically replaces it', async () => {
    const f = fixture();
    const old = await snapshot();
    const url = await f.authorization.begin(uid);
    const begun = await snapshot();
    expect(begun.user).toEqual(old.user);
    expect(begun.token).toMatchObject(old.token);
    expect(Object.keys(begun.token.oauthStates)).toHaveLength(1);
    expect(f.tokenFetch).not.toHaveBeenCalled();
    expect(f.profileFetch).not.toHaveBeenCalled();

    const { candidateId } = await f.complete(url, 'a');
    const staged = await snapshot();
    expect(staged.user).toEqual(old.user);
    expect(staged.token).toMatchObject({
      ...old.token,
      pendingLink: { candidateId },
    });
    expect(staged.token.pendingLink).not.toHaveProperty('profile');
    expect(f.tokenFetch).toHaveBeenCalledTimes(1);

    f.profileFetch.mockRejectedValueOnce(new Error('fixture-profile-failure'));
    await expect(f.candidate.getPending(uid)).rejects.toThrow('X candidate flow failed');
    expect(await snapshot()).toEqual(staged);
    await expect(f.candidate.confirm(uid, candidateId, false))
      .rejects.toThrow('X candidate flow failed');
    expect(await snapshot()).toEqual(staged);

    await f.candidate.discard(uid, candidateId);
    const discarded = await snapshot();
    expect(discarded.user).toEqual(old.user);
    expect(discarded.token).toEqual(old.token);
    await expect(f.candidate.getPending(uid)).resolves.toBeNull();

    const replacementId = await f.pending('b');
    const ready = await snapshot();
    expect(ready.user).toEqual(old.user);
    expect(ready.token).toMatchObject(old.token);
    expect(ready.token.pendingLink.profile).toEqual({
      ...ACCOUNTS.b, profileImageUrl: null,
    });

    await f.candidate.confirm(uid, replacementId, false);
    const confirmed = await snapshot();
    expect(confirmed.user).toEqual({ ...OLD_USER, xUsername: ACCOUNTS.b.username, xPostEnabled: false });
    expect(confirmed.token).toEqual({
      encryptedAccessToken: ready.token.pendingLink.encryptedAccessToken,
      encryptedRefreshToken: ready.token.pendingLink.encryptedRefreshToken,
      expiresAt: ready.token.pendingLink.expiresAt,
      scope: SCOPE,
      xUserId: ACCOUNTS.b.id,
      oauthStates: {},
      confirmedLink: { candidateId: replacementId, postEnabled: false },
    });
    expect(decrypt(confirmed.token.encryptedAccessToken, KEY, {
      uid, purpose: 'accessToken',
    })).toBe('fixture-b-access');
    expect(decrypt(confirmed.token.encryptedRefreshToken, KEY, {
      uid, purpose: 'refreshToken',
    })).toBe('fixture-b-refresh');
    expect(confirmed.token.encryptedAccessToken).not.toBe(old.token.encryptedAccessToken);
    expect(confirmed.token.encryptedRefreshToken).not.toBe(old.token.encryptedRefreshToken);
    // The two real document updates share one server commit time.
    expect(confirmed.userUpdate.isEqual(confirmed.tokenUpdate)).toBe(true);
    expect(confirmed.userUpdate.isEqual(ready.userUpdate)).toBe(false);
    expect(confirmed.tokenUpdate.isEqual(ready.tokenUpdate)).toBe(false);
  }, 30_000);

  it('confirms distinct A then B; A retries preserve B and identical B retries preserve later user settings', async () => {
    const f = fixture();
    const a = await f.pending('a');
    await f.candidate.confirm(uid, a, true);
    const activeA = await snapshot();
    expect(activeA.user).toEqual({ ...OLD_USER, xUsername: ACCOUNTS.a.username });
    expect(activeA.token.xUserId).toBe(ACCOUNTS.a.id);
    expect(activeA.token.confirmedLink).toEqual({ candidateId: a, postEnabled: true });
    expect(activeA.token).not.toHaveProperty('pendingLink');

    const b = await f.pending('b');
    expect(b).not.toBe(a);
    const pendingB = await snapshot();
    expect(pendingB.user).toEqual(activeA.user);
    expect(pendingB.token).toMatchObject(activeA.token);
    expect(pendingB.token.pendingLink.candidateId).toBe(b);
    await f.candidate.confirm(uid, a, true);
    expect(await snapshot()).toEqual(pendingB);
    await expect(f.candidate.discard(uid, a)).rejects.toThrow('X candidate flow failed');
    expect(await snapshot()).toEqual(pendingB);

    await f.candidate.confirm(uid, b, false);
    const activeB = await snapshot();
    expect(activeB.user).toEqual({ ...OLD_USER, xUsername: ACCOUNTS.b.username, xPostEnabled: false });
    expect(activeB.token).toEqual({
      ...activeA.token,
      encryptedAccessToken: pendingB.token.pendingLink.encryptedAccessToken,
      encryptedRefreshToken: pendingB.token.pendingLink.encryptedRefreshToken,
      expiresAt: pendingB.token.pendingLink.expiresAt,
      xUserId: ACCOUNTS.b.id,
      confirmedLink: { candidateId: b, postEnabled: false },
    });
    expect(activeB.userUpdate.isEqual(activeB.tokenUpdate)).toBe(true);
    await expect(f.candidate.confirm(uid, a, true)).rejects.toThrow('X candidate flow failed');
    expect(await snapshot()).toEqual(activeB);

    await db.doc(`users/${uid}`).update({ xPostEnabled: true });
    const later = await snapshot();
    await f.candidate.confirm(uid, b, false);
    expect(await snapshot()).toEqual(later);
    expect(later.user.xPostEnabled).toBe(true);
    expect(f.tokenFetch).toHaveBeenCalledTimes(2);
    expect(f.profileFetch).toHaveBeenCalledTimes(2);
  }, 30_000);
});
