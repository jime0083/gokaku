import { Timestamp } from 'firebase-admin/firestore';

import { createCandidateFlow } from '../candidateFlow';
import type { CandidateStore, PendingCandidate } from '../candidateStore';
import { encrypt } from '../crypto';
import type { ProfileFetch, ProfileResult } from '../profileTransport';

const UID = 'candidate-flow-user';
// Synthetic fixtures only; no real credentials or environment reads.
const KEY = Buffer.alloc(32, 9).toString('base64');
const ACCESS = 'SYNTHETIC_ACCESS_PRIVATE';
const PRIVATE = 'SYNTHETIC_PROVIDER_PRIVATE';
const FAILURE = 'X candidate flow failed';
const EXPIRES = 1800000000123;
const PROFILE: ProfileResult = {
  id: '123456', username: 'study_user', profileImageUrl: null,
};

function response(image?: string): Response {
  return new Response(JSON.stringify({ data: {
    id: PROFILE.id,
    username: PROFILE.username,
    ...(image === undefined ? {} : { profile_image_url: image }),
    privateField: PRIVATE,
  } }));
}

function fixture() {
  const initial: PendingCandidate = {
    candidateId: 'candidate-a',
    encryptedAccessToken: encrypt(ACCESS, KEY, {
      uid: UID, purpose: 'accessToken',
    }),
    encryptedRefreshToken: encrypt('SYNTHETIC_REFRESH_PRIVATE', KEY, {
      uid: UID, purpose: 'refreshToken',
    }),
    expiresAt: Timestamp.fromMillis(EXPIRES),
    scope: 'tweet.read tweet.write users.read offline.access',
  };
  let current: PendingCandidate | null = initial;
  const store: jest.Mocked<CandidateStore> = {
    get: jest.fn<
      ReturnType<CandidateStore['get']>, Parameters<CandidateStore['get']>
    >(async () => current),
    attachProfile: jest.fn<
      ReturnType<CandidateStore['attachProfile']>, Parameters<CandidateStore['attachProfile']>
    >(async (_uid, candidateId, envelope, profile) => {
      if (
        current === null || current.candidateId !== candidateId ||
        current.encryptedAccessToken !== envelope
      ) throw new Error(PRIVATE);
      current = { ...current, profile };
    }),
    confirm: jest.fn<
      ReturnType<CandidateStore['confirm']>, Parameters<CandidateStore['confirm']>
    >(async () => undefined),
    discard: jest.fn<
      ReturnType<CandidateStore['discard']>, Parameters<CandidateStore['discard']>
    >(async () => undefined),
  };
  const fetch: jest.MockedFunction<ProfileFetch> =
    jest.fn<ReturnType<ProfileFetch>, Parameters<ProfileFetch>>(async () => response());
  return {
    initial, store, fetch,
    flow: createCandidateFlow({ store, fetch, encryptionKey: KEY }),
    set: (value: PendingCandidate | null) => { current = value; },
  };
}

async function safeFailure(operation: Promise<unknown>) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message).toBe(FAILURE);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
  for (const value of [PRIVATE, ACCESS, KEY, 'SYNTHETIC_REFRESH_PRIVATE']) {
    expect(error.stack).not.toContain(value);
  }
}

let logs: jest.SpyInstance[];
beforeEach(() => {
  logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
    jest.spyOn(console, name as 'log').mockImplementation(() => undefined),
  );
});
afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});

it('returns null without decryption, HTTP, or writes when no candidate exists', async () => {
  const f = fixture();
  f.set(null);
  const flow = createCandidateFlow({
    store: f.store, fetch: f.fetch, encryptionKey: 'unused',
  });
  await expect(flow.getPending(UID)).resolves.toBeNull();
  expect(f.store.get).toHaveBeenCalledWith(UID);
  expect(f.store.get).toHaveBeenCalledTimes(1);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.store.attachProfile).not.toHaveBeenCalled();
});

it('returns only copied public cached fields, including null images, without HTTP', async () => {
  for (const profileImageUrl of [null, 'https://images.example.test/avatar.png']) {
    const f = fixture();
    const profile = { ...PROFILE, profileImageUrl, privateField: PRIVATE };
    f.set({ ...f.initial, profile });
    const flow = createCandidateFlow({
      store: f.store, fetch: f.fetch, encryptionKey: 'unused',
    });
    const result = await flow.getPending(UID);
    expect(result).toEqual({
      candidateId: 'candidate-a',
      profile: { ...PROFILE, profileImageUrl },
      expiresAt: EXPIRES,
    });
    expect(result?.profile).not.toBe(profile);
    expect(f.store.get).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.store.attachProfile).not.toHaveBeenCalled();
  }
});

it('fetches lazily, attaches exact ID/envelope, re-reads, and subsequently uses cache', async () => {
  const f = fixture();
  const expected = {
    candidateId: 'candidate-a', profile: PROFILE, expiresAt: EXPIRES,
  };
  await expect(f.flow.getPending(UID)).resolves.toEqual(expected);
  expect(f.fetch).toHaveBeenCalledWith(
    'https://api.x.com/2/users/me?user.fields=profile_image_url',
    expect.objectContaining({
      headers: { Authorization: `Bearer ${ACCESS}`, Accept: 'application/json' },
    }),
  );
  expect(f.store.attachProfile).toHaveBeenCalledWith(
    UID, f.initial.candidateId, f.initial.encryptedAccessToken, PROFILE,
  );
  expect(f.store.get).toHaveBeenCalledTimes(2);
  const reads = f.store.get.mock.invocationCallOrder;
  const http = f.fetch.mock.invocationCallOrder[0];
  const attach = f.store.attachProfile.mock.invocationCallOrder[0];
  expect(reads[0]).toBeLessThan(http);
  expect(http).toBeLessThan(attach);
  expect(attach).toBeLessThan(reads[1]);
  await expect(f.flow.getPending(UID)).resolves.toEqual(expected);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.store.attachProfile).toHaveBeenCalledTimes(1);
  expect(f.store.confirm).not.toHaveBeenCalled();
  expect(f.store.discard).not.toHaveBeenCalled();
});

it('preserves a supplied profile image through transport and storage', async () => {
  const f = fixture();
  const image = 'https://images.example.test/avatar.png';
  f.fetch.mockResolvedValueOnce(response(image));
  await expect(f.flow.getPending(UID)).resolves.toEqual({
    candidateId: 'candidate-a',
    profile: { ...PROFILE, profileImageUrl: image },
    expiresAt: EXPIRES,
  });
});

it('authenticates access-token UID, purpose, and key before HTTP', async () => {
  for (const binding of ['uid', 'purpose', 'key']) {
    const f = fixture();
    f.set({
      ...f.initial,
      encryptedAccessToken: encrypt(
        ACCESS,
        binding === 'key' ? Buffer.alloc(32, 8).toString('base64') : KEY,
        {
          uid: binding === 'uid' ? 'another-user' : UID,
          purpose: binding === 'purpose' ? 'refreshToken' : 'accessToken',
        },
      ),
    });
    await safeFailure(f.flow.getPending(UID));
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.store.attachProfile).not.toHaveBeenCalled();
  }
});

it('rejects replacement, deletion, or envelope changes during HTTP', async () => {
  for (const race of ['replace', 'discard', 'envelope']) {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      f.set(race === 'discard' ? null : {
        ...f.initial,
        ...(race === 'replace' ? { candidateId: 'candidate-b' } : {}),
        ...(race === 'envelope'
          ? { encryptedAccessToken: 'changed-envelope' } : {}),
      });
      return response();
    });
    await safeFailure(f.flow.getPending(UID));
    expect(f.store.attachProfile).toHaveBeenCalledWith(
      UID, f.initial.candidateId, f.initial.encryptedAccessToken, PROFILE,
    );
    expect(f.store.confirm).not.toHaveBeenCalled();
    expect(f.store.discard).not.toHaveBeenCalled();
  }
});

it('rejects stale or incomplete re-reads after attach succeeds', async () => {
  for (const race of ['replace', 'missing', 'envelope', 'profile']) {
    const f = fixture();
    f.store.attachProfile.mockImplementationOnce(async () => {
      f.set(race === 'missing' ? null : {
        ...f.initial,
        ...(race === 'replace' ? { candidateId: 'candidate-b' } : {}),
        ...(race === 'envelope'
          ? { encryptedAccessToken: 'changed-envelope' } : {}),
        ...(race === 'profile' ? {} : { profile: PROFILE }),
      });
    });
    await safeFailure(f.flow.getPending(UID));
    expect(f.store.get).toHaveBeenCalledTimes(2);
  }
});

it('returns the persisted re-read profile rather than the earlier HTTP object', async () => {
  const f = fixture();
  const saved = { ...PROFILE, username: 'persisted_user' };
  f.store.attachProfile.mockImplementationOnce(async () => {
    f.set({ ...f.initial, profile: saved });
  });
  await expect(f.flow.getPending(UID)).resolves.toEqual({
    candidateId: 'candidate-a', profile: saved, expiresAt: EXPIRES,
  });
});

it('redacts dependency errors from every asynchronous boundary', async () => {
  for (const step of ['get', 'fetch', 'attach', 'reread', 'confirm', 'discard']) {
    const f = fixture();
    const raw = Object.assign(new Error(PRIVATE + ACCESS), { credentials: KEY });
    if (step === 'get') f.store.get.mockRejectedValueOnce(raw);
    if (step === 'fetch') f.fetch.mockRejectedValueOnce(raw);
    if (step === 'attach') f.store.attachProfile.mockRejectedValueOnce(raw);
    if (step === 'reread') {
      f.store.get.mockResolvedValueOnce(f.initial).mockRejectedValueOnce(raw);
    }
    if (step === 'confirm') f.store.confirm.mockRejectedValueOnce(raw);
    if (step === 'discard') f.store.discard.mockRejectedValueOnce(raw);
    await safeFailure(
      step === 'confirm' ? f.flow.confirm(UID, 'candidate-a', false)
        : step === 'discard' ? f.flow.discard(UID, 'candidate-a')
          : f.flow.getPending(UID),
    );
  }
});

it('delegates confirm true/false and discard exactly, with no extra reads or HTTP', async () => {
  const f = fixture();
  for (const enabled of [true, false]) {
    f.store.confirm.mockResolvedValueOnce(PRIVATE as unknown as void);
    await expect(
      f.flow.confirm(UID, 'exact-candidate', enabled),
    ).resolves.toBeUndefined();
  }
  expect(f.store.confirm.mock.calls).toEqual([
    [UID, 'exact-candidate', true],
    [UID, 'exact-candidate', false],
  ]);
  f.store.discard.mockResolvedValueOnce(PRIVATE as unknown as void);
  await expect(f.flow.discard(UID, 'exact-candidate')).resolves.toBeUndefined();
  expect(f.store.discard.mock.calls).toEqual([[UID, 'exact-candidate']]);
  expect(f.store.get).not.toHaveBeenCalled();
  expect(f.store.attachProfile).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
