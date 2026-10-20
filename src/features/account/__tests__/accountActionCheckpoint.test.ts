import {
  ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY,
  clearAccountActionCheckpoint,
  loadAccountActionCheckpoint,
  saveAccountActionCheckpoint,
  type AccountCheckpointStore,
} from '../accountActionCheckpoint';
import type { AccountActionCheckpoint } from '../accountActionFlow';

const KEY = 'account:action:v1';
const INITIAL: AccountActionCheckpoint = {
  uid: 'owner-a', action: 'logout', phase: 'cloud-pending',
};
const PHASES = ['cloud-pending', 'local-cleanup', 'sign-out', 'launch'] as const;

let data: Map<string, string>;
let store: jest.Mocked<AccountCheckpointStore>;
let guard: jest.Mock<Promise<void>, []>;

beforeEach(() => {
  data = new Map([['unrelated', 'keep']]);
  store = {
    getItem: jest.fn(async (key: string) => data.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      data.delete(key);
    }),
  };
  guard = jest.fn(async () => undefined);
});

afterEach(() => {
  expect(data.get('unrelated')).toBe('keep');
});

function seed(value: unknown): void {
  data.set(KEY, JSON.stringify(value));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('uses the dedicated v1 key and treats only missing storage as absent', async () => {
  expect(ACCOUNT_ACTION_CHECKPOINT_STORAGE_KEY).toBe(KEY);
  await expect(loadAccountActionCheckpoint(store, guard)).resolves.toBeNull();
  expect(store.getItem).toHaveBeenCalledWith(KEY);
  expect(guard).toHaveBeenCalledTimes(2);
});

it.each(['logout', 'delete'] as const)('round trips only three metadata fields for %s', async (action) => {
  const value = { ...INITIAL, action };
  await saveAccountActionCheckpoint(value, store, guard);
  expect(data.get(KEY)).toBe(JSON.stringify(value));
  expect(Object.keys(JSON.parse(data.get(KEY)!)).sort()).toEqual(['action', 'phase', 'uid']);
  await expect(loadAccountActionCheckpoint(store, guard)).resolves.toEqual(value);
});

const invalid = [
  null, [], true, 1, 'unknown',
  {},
  { ...INITIAL, uid: '' },
  { ...INITIAL, uid: 1 },
  { ...INITIAL, action: 'unknown' },
  { ...INITIAL, phase: 'unknown' },
  { uid: INITIAL.uid, action: INITIAL.action },
  { ...INITIAL, version: 1 },
  { ...INITIAL, token: 'must-not-persist' },
  { uid: INITIAL.uid, action: INITIAL.action, other: INITIAL.phase },
];

it.each(invalid.map((value) => [JSON.stringify(value)]))(
  'rejects unknown stored format %s without erasing it',
  async (raw) => {
    data.set(KEY, raw);
    await expect(loadAccountActionCheckpoint(store, guard)).rejects.toThrow('account-checkpoint-invalid');
    expect(data.get(KEY)).toBe(raw);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
  },
);

it.each(['', '{', 'undefined'])('throws for corrupt JSON %j', async (raw) => {
  data.set(KEY, raw);
  await expect(loadAccountActionCheckpoint(store, guard)).rejects.toThrow('account-checkpoint-invalid');
  expect(data.get(KEY)).toBe(raw);
});

it.each(invalid)('rejects invalid save input %#', async (value) => {
  await expect(saveAccountActionCheckpoint(
    value as AccountActionCheckpoint, store, guard,
  )).rejects.toThrow('account-checkpoint-invalid');
  expect(store.getItem).not.toHaveBeenCalled();
  expect(store.setItem).not.toHaveBeenCalled();
});

const transitions = PHASES.flatMap((from, fromIndex) =>
  PHASES.map((to, toIndex) => ({ from, to, fromIndex, toIndex })),
);
it.each(transitions)('handles $from -> $to monotonically', async ({ from, to, fromIndex, toIndex }) => {
  const previous = { ...INITIAL, phase: from };
  const next = { ...INITIAL, phase: to };
  seed(previous);
  if (toIndex < fromIndex) {
    await expect(saveAccountActionCheckpoint(next, store, guard)).rejects.toThrow('account-checkpoint-regression');
    expect(data.get(KEY)).toBe(JSON.stringify(previous));
    expect(store.setItem).not.toHaveBeenCalled();
  } else {
    await saveAccountActionCheckpoint(next, store, guard);
    expect(data.get(KEY)).toBe(JSON.stringify(next));
    expect(store.setItem).toHaveBeenCalledTimes(toIndex === fromIndex ? 0 : 1);
  }
});

const conflicts: AccountActionCheckpoint[] = [
  { ...INITIAL, uid: 'owner-b' },
  { ...INITIAL, action: 'delete' },
  { ...INITIAL, uid: 'owner-b', action: 'delete' },
];
it.each(conflicts)('refuses overwrite and clear for another identity %#', async (saved) => {
  seed(saved);
  await expect(saveAccountActionCheckpoint(INITIAL, store, guard)).rejects.toThrow('account-checkpoint-conflict');
  await expect(clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard)).rejects.toThrow('account-checkpoint-conflict');
  expect(data.get(KEY)).toBe(JSON.stringify(saved));
  expect(store.setItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
});

it('clears matching identity and repeats safely when absent', async () => {
  seed(INITIAL);
  await clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
  await clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
  expect(data.has(KEY)).toBe(false);
  expect(store.removeItem).toHaveBeenCalledTimes(1);
  expect(store.removeItem).toHaveBeenCalledWith(KEY);
});

it.each([
  ['', 'logout'],
  ['owner-a', 'unknown'],
] as const)('refuses invalid clear identity %s/%s', async (uid, action) => {
  seed(INITIAL);
  await expect(clearAccountActionCheckpoint(
    uid, action as AccountActionCheckpoint['action'], store, guard,
  )).rejects.toThrow('account-checkpoint-invalid');
  expect(store.getItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
});

it.each(['save', 'clear'] as const)('does not %s over corrupt metadata', async (operation) => {
  data.set(KEY, '{');
  const result = operation === 'save'
    ? saveAccountActionCheckpoint(INITIAL, store, guard)
    : clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
  await expect(result).rejects.toThrow('account-checkpoint-invalid');
  expect(data.get(KEY)).toBe('{');
  expect(store.setItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
});

it.each(['load', 'save', 'clear'] as const)('propagates %s read failure and leaves the chain usable', async (operation) => {
  seed(INITIAL);
  store.getItem.mockRejectedValueOnce(new Error('read-failed'));
  const result = operation === 'load'
    ? loadAccountActionCheckpoint(store, guard)
    : operation === 'save'
      ? saveAccountActionCheckpoint(INITIAL, store, guard)
      : clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
  await expect(result).rejects.toThrow('read-failed');
  await expect(loadAccountActionCheckpoint(store, guard)).resolves.toEqual(INITIAL);
  expect(store.setItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
});

it.each(['save', 'clear'] as const)('propagates %s write failure and permits explicit retry', async (operation) => {
  if (operation === 'save') {
    store.setItem.mockRejectedValueOnce(new Error('write-failed'));
    await expect(saveAccountActionCheckpoint(INITIAL, store, guard)).rejects.toThrow('write-failed');
    expect(data.has(KEY)).toBe(false);
    await saveAccountActionCheckpoint(INITIAL, store, guard);
    expect(data.get(KEY)).toBe(JSON.stringify(INITIAL));
  } else {
    seed(INITIAL);
    store.removeItem.mockRejectedValueOnce(new Error('write-failed'));
    await expect(clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard)).rejects.toThrow('write-failed');
    expect(data.get(KEY)).toBe(JSON.stringify(INITIAL));
    await clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
    expect(data.has(KEY)).toBe(false);
  }
});

it.each([1, 2])('guards load boundary %i', async (boundary) => {
  seed(INITIAL);
  let calls = 0;
  guard.mockImplementation(async () => {
    if (++calls === boundary) throw new Error('identity-changed');
  });
  await expect(loadAccountActionCheckpoint(store, guard)).rejects.toThrow('identity-changed');
  expect(store.getItem).toHaveBeenCalledTimes(boundary === 1 ? 0 : 1);
  expect(data.get(KEY)).toBe(JSON.stringify(INITIAL));
});

it.each(['save', 'clear'] as const)('guards every %s boundary including immediately before mutation', async (operation) => {
  for (const boundary of [1, 2, 3, 4]) {
    data.delete(KEY);
    if (operation === 'clear') seed(INITIAL);
    store.getItem.mockClear();
    store.setItem.mockClear();
    store.removeItem.mockClear();
    let calls = 0;
    guard.mockImplementation(async () => {
      if (++calls === boundary) throw new Error('identity-changed');
    });
    const result = operation === 'save'
      ? saveAccountActionCheckpoint(INITIAL, store, guard)
      : clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
    await expect(result).rejects.toThrow('identity-changed');
    expect(store.getItem).toHaveBeenCalledTimes(boundary === 1 ? 0 : 1);
    expect(store.setItem).toHaveBeenCalledTimes(operation === 'save' && boundary === 4 ? 1 : 0);
    expect(store.removeItem).toHaveBeenCalledTimes(operation === 'clear' && boundary === 4 ? 1 : 0);
    expect(data.has(KEY)).toBe(operation === 'save' ? boundary === 4 : boundary !== 4);
  }
});

it('rechecks after an asynchronous read changes the caller identity', async () => {
  let valid = true;
  guard.mockImplementation(async () => {
    if (!valid) throw new Error('identity-changed');
  });
  store.getItem.mockImplementationOnce(async () => {
    valid = false;
    return null;
  });
  await expect(saveAccountActionCheckpoint(INITIAL, store, guard)).rejects.toThrow('identity-changed');
  expect(store.setItem).not.toHaveBeenCalled();
});

it('serializes competing identities and revalidates queued guards', async () => {
  const entered = deferred();
  const release = deferred();
  store.getItem.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return data.get(KEY) ?? null;
  });
  const first = saveAccountActionCheckpoint(INITIAL, store, guard);
  await entered.promise;
  const contender = saveAccountActionCheckpoint(
    { ...INITIAL, uid: 'owner-b' }, store, guard,
  );
  const rejected = expect(contender).rejects.toThrow('account-checkpoint-conflict');
  try {
    expect(store.getItem).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await first;
    await rejected;
  }
  expect(data.get(KEY)).toBe(JSON.stringify(INITIAL));
});

it('serializes loads and clear behind an unfinished save', async () => {
  const entered = deferred();
  const release = deferred();
  store.setItem.mockImplementationOnce(async (key, value) => {
    entered.resolve();
    await release.promise;
    data.set(key, value);
  });
  const saved = saveAccountActionCheckpoint(INITIAL, store, guard);
  await entered.promise;
  const loaded = loadAccountActionCheckpoint(store, guard);
  const cleared = clearAccountActionCheckpoint(INITIAL.uid, INITIAL.action, store, guard);
  try {
    expect(store.getItem).toHaveBeenCalledTimes(1);
    expect(store.removeItem).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await saved;
    await expect(loaded).resolves.toEqual(INITIAL);
    await cleared;
  }
  expect(data.has(KEY)).toBe(false);
});

it('takes a snapshot before queued work and does not persist later argument changes', async () => {
  const entered = deferred();
  const release = deferred();
  store.getItem.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return null;
  });
  const reading = loadAccountActionCheckpoint(store, guard);
  await entered.promise;
  const value = { ...INITIAL };
  const saving = saveAccountActionCheckpoint(value, store, guard);
  value.uid = 'owner-b';
  value.phase = 'launch';
  release.resolve();
  await reading;
  await saving;
  expect(data.get(KEY)).toBe(JSON.stringify(INITIAL));
});

it('checks the guard when queued work actually starts', async () => {
  const entered = deferred();
  const release = deferred();
  store.getItem.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return null;
  });
  const first = loadAccountActionCheckpoint(store, guard);
  await entered.promise;
  const queuedGuard = jest.fn(async () => { throw new Error('lease-lost'); });
  const queued = saveAccountActionCheckpoint(INITIAL, store, queuedGuard);
  const rejected = expect(queued).rejects.toThrow('lease-lost');
  try {
    expect(queuedGuard).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await first;
    await rejected;
  }
  expect(store.setItem).not.toHaveBeenCalled();
});

it('leaves confirmed null-auth policy to the caller guard', async () => {
  const confirmed: AccountActionCheckpoint = { ...INITIAL, phase: 'local-cleanup' };
  let currentUid: string | null = null;
  const callerGuard = jest.fn(async () => {
    if (currentUid !== confirmed.uid && currentUid !== null) {
      throw new Error('identity-changed');
    }
  });
  await saveAccountActionCheckpoint(confirmed, store, callerGuard);
  currentUid = 'owner-b';
  await expect(clearAccountActionCheckpoint(
    confirmed.uid, confirmed.action, store, callerGuard,
  )).rejects.toThrow('identity-changed');
  expect(data.get(KEY)).toBe(JSON.stringify(confirmed));
});
