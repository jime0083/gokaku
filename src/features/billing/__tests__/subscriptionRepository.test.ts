import { createAccountOperationGate } from '@/features/account/accountOperationGate';

type Repository = typeof import('../subscriptionRepository');
type Cache = typeof import('../subscriptionCache');
const UID = 'owner-a';
let repository: Repository;
let cache: Cache;
let uid: string | null;
let data: Map<string, string>;
let user: Record<string, unknown>;
let exists: boolean;
let nativeLoads: number;
let getItem: jest.Mock;
let setItem: jest.Mock;
let removeItem: jest.Mock;
let remote: jest.Mock;
let localRead: jest.Mock;
let connect: jest.Mock;
let unsubscribe: jest.Mock;
let listener: ((user: { uid: string } | null) => void) | undefined;
let gate: ReturnType<typeof createAccountOperationGate>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function seed(subscription: unknown = { status: 'active', expiresAt: 100 }, owner = UID) {
  data.set(cache.subscriptionCacheKey(UID), JSON.stringify({
    version: 1, uid: owner, registered: true, xLinked: true, subscription,
  }));
}
function doc(subscription: unknown) {
  return {
    exists: () => true,
    data: () => ({ activeGoalId: 'goal', xLinked: true, subscription }),
  };
}

beforeEach(() => {
  jest.resetModules();
  uid = UID;
  data = new Map();
  user = { activeGoalId: 'goal', xLinked: true, subscription: { status: 'active', expiresAt: 100 } };
  exists = true;
  nativeLoads = 0;
  listener = undefined;
  getItem = jest.fn(async (key: string) => data.get(key) ?? null);
  setItem = jest.fn(async (key: string, raw: string) => { data.set(key, raw); });
  removeItem = jest.fn(async (key: string) => { data.delete(key); });
  remote = jest.fn(async () => ({ exists: () => exists, data: () => user }));
  localRead = jest.fn(() => { throw new Error('local SDK reads are forbidden'); });
  connect = jest.fn();
  unsubscribe = jest.fn();
  gate = createAccountOperationGate({
    getCurrentUid: () => uid,
    getAccountCompletionConfirmed: () => false,
    readDurableBlocked: async () => false,
  });
  jest.doMock('@/config/firebase', () => ({
    getCurrentUid: () => uid, connectFirebaseEmulatorsIfNeeded: connect,
  }));
  jest.doMock('@/features/account/accountOperationRuntime', () => ({ accountOperationGate: gate }));
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true, default: { getItem, setItem, removeItem },
  }));
  jest.doMock('@react-native-firebase/app', () => {
    nativeLoads += 1;
    return { getApp: jest.fn(() => ({})) };
  });
  jest.doMock('@react-native-firebase/firestore', () => {
    nativeLoads += 1;
    return {
      getFirestore: jest.fn(() => ({})),
      doc: jest.fn((_db, collection: string, owner: string) => `${collection}/${owner}`),
      getDocFromServer: remote, getDoc: localRead,
    };
  });
  jest.doMock('@react-native-firebase/auth', () => {
    nativeLoads += 1;
    return {
      getAuth: jest.fn(() => ({})),
      onAuthStateChanged: jest.fn((_auth, callback: typeof listener) => {
        listener = callback;
        return unsubscribe;
      }),
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cache = require('../subscriptionCache') as Cache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  repository = require('../subscriptionRepository') as Repository;
});

afterEach(() => {
  jest.resetModules();
  for (const name of [
    '@/config/firebase', '@/features/account/accountOperationRuntime',
    '@react-native-async-storage/async-storage', '@react-native-firebase/app',
    '@react-native-firebase/firestore', '@react-native-firebase/auth',
  ]) jest.dontMock(name);
});

it('defers native loading and returns the actual auth unsubscribe', () => {
  expect(nativeLoads).toBe(0);
  expect(connect).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalled();
  const callback = jest.fn();
  expect(repository.subscribeSubscriptionAuth(callback)).toBe(unsubscribe);
  listener?.({ uid: UID });
  listener?.(null);
  expect(callback.mock.calls).toEqual([[UID], [null]]);
  expect(nativeLoads).toBe(2);
  expect(remote).not.toHaveBeenCalled();
});

it('reads the server and persists only normalized subscription and strict route flags', async () => {
  user = {
    activeGoalId: ' goal ', xLinked: 'true',
    subscription: { status: 'active', expiresAt: 100, originalTransactionId: 'not-retained' },
    accessToken: 'not-retained',
  };
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
    uid: UID, registered: true, xLinked: false, access: 'allowed',
  });
  expect(remote).toHaveBeenCalledWith(`users/${UID}`);
  expect(localRead).not.toHaveBeenCalled();
  expect(JSON.parse(data.get(cache.subscriptionCacheKey(UID))!)).toEqual({
    version: 1, uid: UID, registered: true, xLinked: false,
    subscription: { status: 'active', expiresAt: 100 },
  });
});

it('keeps the fresh online expired decision even if cache persistence fails', async () => {
  seed();
  user.subscription = { status: 'expired', expiresAt: 200 };
  setItem.mockRejectedValueOnce(new Error('storage-failed'));
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toMatchObject({ access: 'locked' });
  expect(JSON.parse(data.get(cache.subscriptionCacheKey(UID))!).subscription.status).toBe('active');
});

it('treats missing or malformed online subscription as authoritative null', async () => {
  for (const subscription of [undefined, { status: 'active', expiresAt: { seconds: 100 } }]) {
    seed();
    user = { activeGoalId: ' ', xLinked: true, subscription };
    await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
      uid: UID, registered: false, xLinked: true, access: 'locked',
    });
    expect(JSON.parse(data.get(cache.subscriptionCacheKey(UID))!).subscription).toBeNull();
  }
});

it('clears old cache when the server document is missing', async () => {
  seed();
  exists = false;
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
    uid: UID, registered: false, xLinked: false, access: 'locked',
  });
  expect(removeItem).toHaveBeenCalledWith(cache.subscriptionCacheKey(UID));
  expect(data.has(cache.subscriptionCacheKey(UID))).toBe(false);
});

it('uses only validated own-UID cache offline, including the exact expiry boundary', async () => {
  remote.mockRejectedValue(new Error('unavailable'));
  seed();
  for (const [now, access] of [[99, 'allowed'], [100, 'locked'], [101, 'locked']] as const) {
    await expect(repository.loadSubscriptionSession(UID, now)).resolves.toEqual({
      uid: UID, registered: true, xLinked: true, access,
    });
  }
  seed({ status: 'expired', expiresAt: 200 });
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toMatchObject({ access: 'locked' });
  seed({ status: 'active', expiresAt: 200 }, 'other-owner');
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
    uid: UID, registered: true, xLinked: false, access: 'locked',
  });
  data.clear();
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
    uid: UID, registered: true, xLinked: false, access: 'locked',
  });
  expect(setItem).not.toHaveBeenCalled();
});

it('still attempts the server when cache reading fails', async () => {
  getItem.mockRejectedValue(new Error('cache-unreadable'));
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toMatchObject({ access: 'allowed' });
  remote.mockRejectedValueOnce(new Error('unavailable'));
  await expect(repository.loadSubscriptionSession(UID, 99)).resolves.toEqual({
    uid: UID, registered: true, xLinked: false, access: 'locked',
  });
});

it('propagates UID changes at each storage/server boundary, including rejected I/O', async () => {
  for (const phase of ['read', 'server', 'write', 'remove']) {
    for (const rejects of [false, true]) {
      uid = UID;
      exists = phase !== 'remove';
      const change = async () => {
        uid = 'other-owner';
        if (rejects) throw new Error('I/O-failed');
        return null;
      };
      if (phase === 'read') getItem.mockImplementationOnce(change);
      if (phase === 'server') remote.mockImplementationOnce(change);
      if (phase === 'write') setItem.mockImplementationOnce(change);
      if (phase === 'remove') removeItem.mockImplementationOnce(change);
      await expect(repository.loadSubscriptionSession(UID, 99)).rejects.toThrow('uid-changed');
    }
  }
  uid = null;
  const reads = getItem.mock.calls.length;
  await expect(repository.loadSubscriptionSession(UID, 99)).rejects.toThrow('uid-changed');
  expect(getItem).toHaveBeenCalledTimes(reads);
});

it('serializes writes, drains both roots, and skips late stale active responses', async () => {
  const enteredWrite = deferred<void>();
  const finishWrite = deferred<void>();
  setItem.mockImplementationOnce(async (key: string, raw: string) => {
    enteredWrite.resolve();
    await finishWrite.promise;
    data.set(key, raw);
  });
  const older = repository.loadSubscriptionSession(UID, 99);
  await enteredWrite.promise;
  const parsedNewer = deferred<void>();
  remote.mockResolvedValueOnce({
    exists: () => true,
    data: () => {
      parsedNewer.resolve();
      return { activeGoalId: 'goal', xLinked: true, subscription: { status: 'expired', expiresAt: 100 } };
    },
  });
  const newer = repository.loadSubscriptionSession(UID, 99);
  await parsedNewer.promise;
  expect(setItem).toHaveBeenCalledTimes(1);
  let drained = false;
  const closing = gate.acquireAccount(UID).then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  finishWrite.resolve();
  await Promise.all([older, newer, closing]);
  expect(JSON.parse(data.get(cache.subscriptionCacheKey(UID))!).subscription.status).toBe('expired');
  await gate.releaseAccount(UID);

  const oldResponse = deferred<ReturnType<typeof doc>>();
  const started = deferred<void>();
  remote.mockImplementationOnce(() => {
    started.resolve();
    return oldResponse.promise;
  });
  remote.mockResolvedValueOnce(doc({ status: 'expired', expiresAt: 100 }));
  const late = repository.loadSubscriptionSession(UID, 99);
  await started.promise;
  await repository.loadSubscriptionSession(UID, 99);
  oldResponse.resolve(doc({ status: 'active', expiresAt: 200 }));
  await late;
  expect(setItem).toHaveBeenCalledTimes(3);
  expect(JSON.parse(data.get(cache.subscriptionCacheKey(UID))!).subscription.status).toBe('expired');
});
