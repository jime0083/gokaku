import { getCurrentUid } from '@/config/firebase';
import {
  doc, getDoc, runTransaction, serverTimestamp, Timestamp, updateDoc,
} from '@react-native-firebase/firestore';
import { rememberCheckEnabledSetting } from '@/features/timer/lockscreenSync';
import { loadSettings, updateSettings } from '../settingsRepository';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/timer/lockscreenSync', () => ({
  rememberCheckEnabledSetting: jest.fn(),
}));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'db'),
  doc: jest.fn((_db, ...path) => path.join('/')),
  getDoc: jest.fn(),
  updateDoc: jest.fn(),
  runTransaction: jest.fn(),
  serverTimestamp: jest.fn(() => ({ serverTime: true })),
  Timestamp: class {
    seconds: number;
    nanoseconds: number;
    constructor(seconds: number, nanoseconds: number) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
  },
}));

const userRef = 'users/owner';
const counters = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
const metadata = () => ({
  judgementHistoryStartedAt: new Timestamp(1, 123),
  judgementRevisions: { ...counters },
});
const draft = { checkEnabled: false, xPostEnabled: true };
const tx = { get: jest.fn(), update: jest.fn(), set: jest.fn() };
let current: Record<string, unknown>;
let userExists: boolean;

beforeEach(() => {
  jest.clearAllMocks();
  current = { checkEnabled: true, xPostEnabled: false };
  userExists = true;
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  jest.mocked(getDoc).mockResolvedValue({
    exists: () => true, data: () => ({}),
  } as never);
  jest.mocked(updateDoc).mockResolvedValue(undefined);
  tx.get.mockImplementation(async (ref: string) => {
    if (ref !== userRef) throw new Error(`Unexpected read: ${ref}`);
    return {
      exists: () => userExists,
      data: () => userExists ? current : undefined,
    };
  });
  jest.mocked(runTransaction).mockImplementation(async (_db, body) =>
    body(tx as never));
});

const save = () => updateSettings('owner', draft);
const noWrites = () => {
  expect(tx.update).not.toHaveBeenCalled();
  expect(tx.set).not.toHaveBeenCalled();
  expect(updateDoc).not.toHaveBeenCalled();
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
};

function expectParentPatch(revision: number, settings = draft) {
  expect(tx.update.mock.calls).toHaveLength(1);
  expect(tx.update.mock.calls[0][0]).toBe(userRef);
  expect([
    { ...settings, judgementRevisions: { ...counters, settings: revision } },
    { ...settings, 'judgementRevisions.settings': revision },
  ]).toContainEqual(tx.update.mock.calls[0][1]);
}

it('loads defaults only for missing fields and retains the opening UID', async () => {
  expect(await loadSettings()).toEqual({
    uid: 'owner', checkEnabled: true, xPostEnabled: false,
  });
  expect(doc).toHaveBeenCalledWith('db', 'users', 'owner');
  jest.mocked(getDoc).mockResolvedValueOnce({
    exists: () => true,
    data: () => ({ checkEnabled: false, xPostEnabled: true }),
  } as never);
  expect(await loadSettings()).toEqual({ uid: 'owner', ...draft });
});

it('propagates load errors and rejects missing/malformed/unauthenticated users', async () => {
  jest.mocked(getDoc).mockRejectedValueOnce(new Error('offline'));
  await expect(loadSettings()).rejects.toThrow('offline');
  jest.mocked(getDoc).mockResolvedValueOnce({ exists: () => false } as never);
  await expect(loadSettings()).rejects.toThrow();
  jest.mocked(getDoc).mockResolvedValueOnce({
    exists: () => true, data: () => ({ checkEnabled: 'true' }),
  } as never);
  await expect(loadSettings()).rejects.toThrow();
  jest.mocked(getCurrentUid).mockReturnValue(null);
  await expect(loadSettings()).rejects.toThrow();
});

it.each([null, 'new-user'])('rejects changed/missing opening UID %s', async (uid) => {
  const loaded = await loadSettings();
  jest.mocked(getCurrentUid).mockReturnValue(uid);
  await expect(updateSettings(loaded.uid, loaded)).rejects.toThrow();
  expect(runTransaction).not.toHaveBeenCalled();
  noWrites();
});

it('retains the common two-boolean allowlist and legacy behavior in a transaction', async () => {
  current = {};
  await updateSettings('owner', {
    ...draft, subscription: { status: 'forged' },
  } as never);
  expect(runTransaction).toHaveBeenCalledTimes(1);
  expect(tx.get).toHaveBeenCalledWith(userRef);
  expect(tx.update.mock.calls).toEqual([[userRef, draft]]);
  expect(tx.set).not.toHaveBeenCalled();
  expect(serverTimestamp).not.toHaveBeenCalled();
  expect(updateDoc).not.toHaveBeenCalled();
  expect(rememberCheckEnabledSetting).toHaveBeenCalledWith(false);
});

it.each(['checkEnabled', 'xPostEnabled'] as const)(
  'rejects invalid draft %s before starting a transaction', async (field) => {
    await expect(updateSettings('owner', {
      ...draft, [field]: 'true',
    } as never)).rejects.toThrow();
    expect(runTransaction).not.toHaveBeenCalled();
    noWrites();
  },
);

it('writes current minimal before/draft after and settings counter atomically', async () => {
  current = {
    ...current, ...metadata(), activeGoalId: 'goal',
    subscription: { status: 'active' }, xLinked: true,
  };
  const initial = { ...current };
  await save();
  expect(tx.get.mock.calls).toEqual([[userRef]]);
  expectParentPatch(3);
  expect(tx.set.mock.calls).toEqual([[
    `${userRef}/judgementHistory/settings/entries/3`,
    {
      schemaVersion: 1, revision: 3, committedAt: { serverTime: true },
      before: { xPostEnabled: false }, after: { xPostEnabled: true },
    },
  ]]);
  expect(serverTimestamp).toHaveBeenCalledTimes(1);
  expect(updateDoc).not.toHaveBeenCalled();
  expect(current).toEqual(initial);
});

it.each([true, false])(
  'supports check-only/equal save with equal snapshots (checkEnabled=%s)', async (checkEnabled) => {
    current = { ...current, ...metadata() };
    const settings = { checkEnabled, xPostEnabled: false };
    await updateSettings('owner', settings);
    expectParentPatch(3, settings);
    expect(tx.set).toHaveBeenCalledWith(
      `${userRef}/judgementHistory/settings/entries/3`,
      {
        schemaVersion: 1, revision: 3, committedAt: { serverTime: true },
        before: { xPostEnabled: false }, after: { xPostEnabled: false },
      },
    );
  },
);

it('SDK retry rereads current settings/counter and uses the new canonical ID', async () => {
  current = { ...current, ...metadata() };
  jest.mocked(runTransaction).mockImplementationOnce(async (_db, body) => {
    await body(tx as never); // SDK discards the first attempt.
    expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
    current = {
      ...current, xPostEnabled: true,
      judgementRevisions: { ...counters, settings: 7 },
    };
    tx.get.mockClear(); tx.update.mockClear(); tx.set.mockClear();
    return body(tx as never);
  });
  await save();
  expect(tx.get.mock.calls).toEqual([[userRef]]);
  expectParentPatch(8);
  expect(tx.set.mock.calls).toEqual([[
    `${userRef}/judgementHistory/settings/entries/8`,
    {
      schemaVersion: 1, revision: 8, committedAt: { serverTime: true },
      before: { xPostEnabled: true }, after: { xPostEnabled: true },
    },
  ]]);
  expect(rememberCheckEnabledSetting).toHaveBeenCalledTimes(1);
});

it('rejects a UID switch after the asynchronous user read before any write', async () => {
  current = { ...current, ...metadata() };
  tx.get.mockImplementationOnce(async () => {
    jest.mocked(getCurrentUid).mockReturnValue('new-user');
    return { exists: () => true, data: () => current };
  });
  await expect(save()).rejects.toThrow();
  noWrites();
});

it('rechecks UID when the SDK retries', async () => {
  current = { ...current, ...metadata() };
  jest.mocked(runTransaction).mockImplementationOnce(async (_db, body) => {
    await body(tx as never);
    tx.get.mockClear(); tx.update.mockClear(); tx.set.mockClear();
    jest.mocked(getCurrentUid).mockReturnValue('new-user');
    return body(tx as never);
  });
  await expect(save()).rejects.toThrow();
  noWrites();
});

it.each(['owner', 'new-user', null])(
  'remembers only after successful commit and only for the same UID: %s', async (nextUid) => {
    current = { ...current, ...metadata() };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let attempted: Promise<unknown> | undefined;
    jest.mocked(runTransaction).mockImplementationOnce(async (_db, body) => {
      attempted = body(tx as never);
      await attempted;
      await gate;
    });
    const pending = save();
    try {
      expect(runTransaction).toHaveBeenCalledTimes(1);
      await attempted;
      expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
      jest.mocked(getCurrentUid).mockReturnValue(nextUid);
    } finally {
      release();
      await pending;
    }
    if (nextUid === 'owner') {
      expect(rememberCheckEnabledSetting).toHaveBeenCalledTimes(1);
      expect(rememberCheckEnabledSetting).toHaveBeenCalledWith(false);
    } else {
      expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
    }
  },
);

it('propagates transaction read failure without writes or native sync', async () => {
  tx.get.mockRejectedValueOnce(new Error('offline'));
  await expect(save()).rejects.toThrow('offline');
  noWrites();
});

it('propagates failed commit without native sync', async () => {
  current = { ...current, ...metadata() };
  jest.mocked(runTransaction).mockImplementationOnce(async (_db, body) => {
    await body(tx as never);
    throw new Error('commit failed');
  });
  await expect(save()).rejects.toThrow('commit failed');
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
});

it.each(['missing', 'deleting', 'legacy-deleting'])(
  'rejects invalid current user state: %s', async (state) => {
    current = { ...current, ...(state === 'legacy-deleting' ? {} : metadata()) };
    if (state === 'missing') userExists = false;
    else current.deletionInProgress = true;
    await expect(save()).rejects.toThrow();
    noWrites();
  },
);

const badMetadata: Record<string, unknown>[] = [
  { judgementHistoryStartedAt: new Timestamp(1, 0) },
  { judgementRevisions: counters },
  { ...metadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
  { ...metadata(), judgementHistoryStartedAt: null },
  { ...metadata(), judgementRevisions: null },
  { ...metadata(), judgementRevisions: [] },
  { ...metadata(), judgementRevisions: {} },
  ...(['goal', 'settings', 'xLink', 'subscription'] as const).map((stream) => ({
    ...metadata(), judgementRevisions: { ...counters, [stream]: 0 },
  })),
  ...[-1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER].map((settings) => ({
    ...metadata(), judgementRevisions: { ...counters, settings },
  })),
];

it.each(badMetadata)('rejects partial/malformed metadata: %#', async (bad) => {
  current = { ...current, ...bad };
  await expect(save()).rejects.toThrow();
  noWrites();
});

it.each([undefined, null, 'false'])(
  'does not invent an initialized before snapshot from xPostEnabled=%s', async (value) => {
    current = { ...metadata(), checkEnabled: true };
    if (value !== undefined) current.xPostEnabled = value;
    await expect(save()).rejects.toThrow();
    noWrites();
  },
);
