import { createAccountOperationGate } from '@/features/account/accountOperationGate';
import { cleanupLocalAccountData } from '@/features/account/localAccountData';
import { relinkIntentKey } from '../relinkIntentData';

type Storage = typeof import('../relinkIntentStorage');
const UID = 'owner/a:% 日本';
const OTHER = 'owner-b';
const ownKey = relinkIntentKey(UID);
const otherKey = relinkIntentKey(OTHER);
const payload = (uid = UID) => JSON.stringify({ version: 1, uid });

let storage: Storage;
let uid: string | null;
let blocked: boolean;
let data: Map<string, string>;
let getItem: jest.Mock;
let setItem: jest.Mock;
let removeItem: jest.Mock;
let readDurableBlocked: jest.Mock;
let gate: ReturnType<typeof createAccountOperationGate>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetModules();
  uid = UID;
  blocked = false;
  data = new Map();
  getItem = jest.fn(async (key: string) => data.get(key) ?? null);
  setItem = jest.fn(async (key: string, raw: string) => { data.set(key, raw); });
  removeItem = jest.fn(async (key: string) => { data.delete(key); });
  readDurableBlocked = jest.fn(async () => blocked);
  gate = createAccountOperationGate({
    getCurrentUid: () => uid,
    getAccountCompletionConfirmed: () => false,
    readDurableBlocked,
  });
  jest.doMock('@/config/firebase', () => ({ getCurrentUid: () => uid }));
  jest.doMock('@/features/account/accountOperationRuntime', () => ({ accountOperationGate: gate }));
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true, default: { getItem, setItem, removeItem },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  storage = require('../relinkIntentStorage') as Storage;
});

afterEach(() => {
  for (const name of [
    '@/config/firebase',
    '@/features/account/accountOperationRuntime',
    '@react-native-async-storage/async-storage',
  ]) jest.dontMock(name);
});

it('loads missing as false, saves the exact payload and clears only the own key', async () => {
  const otherRaw = JSON.stringify({ version: 1, uid: OTHER }, null, 2);
  data.set(otherKey, otherRaw);
  await expect(storage.loadRelinkIntent(UID)).resolves.toBe(false);
  await storage.saveRelinkIntent(UID);
  expect(setItem).toHaveBeenCalledWith(ownKey, payload());
  await expect(storage.loadRelinkIntent(UID)).resolves.toBe(true);
  await storage.saveRelinkIntent(UID);
  await storage.clearRelinkIntent(UID);
  await expect(storage.loadRelinkIntent(UID)).resolves.toBe(false);
  await storage.clearRelinkIntent(UID);
  expect(removeItem).toHaveBeenCalledTimes(1);
  expect(removeItem).toHaveBeenCalledWith(ownKey);
  expect([...data]).toEqual([[otherKey, otherRaw]]);
  expect(getItem.mock.calls.every(([key]) => key === ownKey)).toBe(true);
});

it('loads a persisted intent again after module restart', async () => {
  await storage.saveRelinkIntent(UID);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const restarted = require('../relinkIntentStorage') as Storage;
  await expect(restarted.loadRelinkIntent(UID)).resolves.toBe(true);
});

it.each(['loadRelinkIntent', 'saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s never repairs, overwrites or removes unknown data', async (operation) => {
    for (const raw of [
      '', '{', 'null', '{}', '[]', payload(OTHER),
      '{"version":2,"uid":"owner-b"}',
      JSON.stringify({ version: 1, uid: UID, token: 'forbidden' }),
      JSON.stringify({ version: 1, uid: UID, profile: null }),
      JSON.stringify({ version: 1, uid: UID, url: null }),
    ]) {
      data.set(ownKey, raw);
      await expect(storage[operation](UID)).rejects.toThrow('relink-intent-data-unknown');
      expect(data.get(ownKey)).toBe(raw);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  },
);

it.each(['loadRelinkIntent', 'saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s rejects invalid or foreign requested UID before storage access', async (operation) => {
    for (const requested of ['', ' ', OTHER]) {
      await expect(storage[operation](requested)).rejects.toThrow();
    }
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  },
);

it.each(['loadRelinkIntent', 'saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s rejects checkpoint blocking and unreadable checkpoint state', async (operation) => {
    blocked = true;
    await expect(storage[operation](UID)).rejects.toThrow('normal-blocked');
    blocked = false;
    readDurableBlocked.mockRejectedValueOnce(new Error('unreadable'));
    await expect(storage[operation](UID)).rejects.toThrow('durable-unknown');
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  },
);

it('rejects a UID change while awaiting gate admission before reading storage', async () => {
  const entered = deferred<void>();
  const resumed = deferred<boolean>();
  readDurableBlocked.mockImplementationOnce(() => {
    entered.resolve();
    return resumed.promise;
  });
  const result = storage.saveRelinkIntent(UID);
  const rejection = expect(result).rejects.toThrow();
  await entered.promise;
  uid = OTHER;
  resumed.resolve(false);
  await rejection;
  expect(getItem).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
});

it.each(['loadRelinkIntent', 'saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s rejects stale read completion without mutation', async (operation) => {
    const entered = deferred<void>();
    const resumed = deferred<string | null>();
    getItem.mockImplementationOnce(() => {
      entered.resolve();
      return resumed.promise;
    });
    const result = storage[operation](UID);
    const rejection = expect(result).rejects.toThrow();
    await entered.promise;
    uid = OTHER;
    resumed.resolve(payload());
    await rejection;
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  },
);

it.each(['saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s rejects stale mutation completion and never touches the new UID key', async (operation) => {
    data.set(ownKey, payload());
    data.set(otherKey, payload(OTHER));
    const entered = deferred<void>();
    const resumed = deferred<void>();
    const writer = operation === 'saveRelinkIntent' ? setItem : removeItem;
    writer.mockImplementationOnce(async () => {
      entered.resolve();
      await resumed.promise;
    });
    const result = storage[operation](UID);
    const rejection = expect(result).rejects.toThrow();
    await entered.promise;
    uid = OTHER;
    resumed.resolve();
    await rejection;
    expect(writer.mock.calls[0][0]).toBe(ownKey);
    expect(data.get(otherKey)).toBe(payload(OTHER));
  },
);

it.each(['loadRelinkIntent', 'saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s propagates storage read failure without mutation', async (operation) => {
    getItem.mockRejectedValueOnce(new Error('read-failed'));
    await expect(storage[operation](UID)).rejects.toThrow('read-failed');
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  },
);

it.each(['saveRelinkIntent', 'clearRelinkIntent'] as const)(
  '%s propagates write failure and allows the following operation', async (operation) => {
    data.set(ownKey, payload());
    const writer = operation === 'saveRelinkIntent' ? setItem : removeItem;
    writer.mockRejectedValueOnce(new Error('write-failed'));
    await expect(storage[operation](UID)).rejects.toThrow('write-failed');
    await storage.clearRelinkIntent(UID);
    expect(data.has(ownKey)).toBe(false);
  },
);

it('preserves call order even when the first root admission is slower', async () => {
  const firstAdmission = deferred<boolean>();
  const secondAdmission = deferred<void>();
  readDurableBlocked.mockImplementationOnce(() => firstAdmission.promise);
  readDurableBlocked.mockImplementationOnce(async () => {
    secondAdmission.resolve();
    return false;
  });
  const save = storage.saveRelinkIntent(UID);
  const clear = storage.clearRelinkIntent(UID);
  await secondAdmission.promise;
  expect(getItem).not.toHaveBeenCalled();
  firstAdmission.resolve(false);
  await Promise.all([save, clear]);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(removeItem).toHaveBeenCalledTimes(1);
  expect(data.has(ownKey)).toBe(false);
});

it('serializes clear then save and a following read sees the final saved intent', async () => {
  data.set(ownKey, payload());
  const entered = deferred<void>();
  const resumed = deferred<void>();
  removeItem.mockImplementationOnce(async (key: string) => {
    entered.resolve();
    await resumed.promise;
    data.delete(key);
  });
  const clear = storage.clearRelinkIntent(UID);
  const save = storage.saveRelinkIntent(UID);
  const load = storage.loadRelinkIntent(UID);
  await entered.promise;
  expect(setItem).not.toHaveBeenCalled();
  resumed.resolve();
  await Promise.all([clear, save]);
  await expect(load).resolves.toBe(true);
  expect(data.get(ownKey)).toBe(payload());
});

it('drains every admitted root including queued work before account cleanup', async () => {
  const firstRead = deferred<void>();
  const firstResume = deferred<string | null>();
  const secondRead = deferred<void>();
  const secondResume = deferred<string | null>();
  getItem.mockImplementationOnce(() => {
    firstRead.resolve();
    return firstResume.promise;
  });
  getItem.mockImplementationOnce(() => {
    secondRead.resolve();
    return secondResume.promise;
  });

  const save = storage.saveRelinkIntent(UID);
  await firstRead.promise;
  const clear = storage.clearRelinkIntent(UID);
  blocked = true;
  let acquired = false;
  const acquisition = gate.acquireAccount(UID).then((permit) => {
    acquired = true;
    return permit;
  });

  await expect(storage.saveRelinkIntent(UID)).rejects.toThrow('normal-blocked');
  expect(acquired).toBe(false);
  firstResume.resolve(null);
  await save;
  await secondRead.promise;
  expect(acquired).toBe(false);
  secondResume.resolve(payload());
  await clear;
  const permit = await acquisition;

  data.set(ownKey, payload());
  data.set(otherKey, payload(OTHER));
  try {
    await cleanupLocalAccountData(UID, {
      getAllKeys: async () => [...data.keys()],
      getItem, setItem, removeItem,
    }, async () => { permit.assertCurrentUid(); });
    expect([...data]).toEqual([[otherKey, payload(OTHER)]]);
  } finally {
    await gate.releaseAccount(UID);
  }
  await expect(storage.loadRelinkIntent(UID)).rejects.toThrow('normal-blocked');
});
