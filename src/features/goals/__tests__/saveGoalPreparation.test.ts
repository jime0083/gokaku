import * as App from '@react-native-firebase/app';
import * as Firestore from '@react-native-firebase/firestore';
import * as Functions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { getCurrentUid } from '@/config/firebase';
import { INITIAL_ONBOARDING_DRAFT } from '../../onboarding/types';
import { createGoalFirestoreDeps } from '../goalFirestoreDeps';
import { saveGoal } from '../saveGoal';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@react-native-firebase/app', () => ({ getApp: jest.fn(() => 'app') }));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: jest.fn(() => 'functions'), httpsCallable: jest.fn(),
}));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'db'), collection: jest.fn(() => 'goals'),
  doc: jest.fn((_db, ...path) => path.length ? path.join('/') : { id: 'fresh' }),
  runTransaction: jest.fn(), serverTimestamp: jest.fn(() => ({ serverTime: true })),
  Timestamp: class {
    readonly seconds: number;
    readonly nanoseconds: number;
    constructor(seconds: number, nanoseconds: number) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
  },
}));

const UID = 'history-owner';
const NOW = Date.parse('2026-10-25T10:00:00+09:00');
const draft = {
  ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other',
  certOtherName: '試験資格', targetHoursText: '100', examDate: '2027-01-01',
  minDailyMinutes: 30, goalDailyMinutes: 60,
};
const params = () => ({ uid: UID, draft: { ...draft }, now: NOW });
const callable = Object.assign(jest.fn(), { stream: jest.fn() });
const clearOnboardingDraft = jest.fn(async () => undefined);
let currentUid: string | null;
let initialized: boolean;
let reads: jest.Mock;
let writes: jest.Mock;
let committed: unknown[][];

function nativeDeps() {
  return { ...createGoalFirestoreDeps(), clearOnboardingDraft };
}

beforeEach(() => {
  jest.clearAllMocks();
  currentUid = UID;
  initialized = false;
  committed = [];
  jest.mocked(getCurrentUid).mockImplementation(() => currentUid);
  jest.mocked(Functions.httpsCallable).mockReturnValue(callable);
  callable.mockImplementation(async () => {
    initialized = true;
    return { data: { status: 'initialized' } };
  });
  reads = jest.fn(async () => ({
    exists: () => true,
    data: () => initialized ? {
      judgementHistoryStartedAt: new Firestore.Timestamp(1, 123),
      judgementRevisions: { goal: 1, settings: 1, xLink: 1, subscription: 1 },
    } : {},
  }));
  writes = jest.fn();
  jest.mocked(Firestore.runTransaction).mockImplementation(async (_db, body) => {
    const result = await body({ get: reads, set: writes } as never);
    committed.push(...writes.mock.calls);
    return result;
  });
});

it.each(['initialized', 'alreadyInitialized'] as const)(
  'awaits %s then atomically saves goal/pointer/history before clearing draft', async (status) => {
    callable.mockImplementationOnce(async () => {
      initialized = true;
      expect(Firestore.runTransaction).not.toHaveBeenCalled();
      return { data: { status } };
    });
    const result = await saveGoal(nativeDeps(), params());
    expect(Functions.getFunctions).toHaveBeenCalledWith('app', FUNCTIONS_REGION);
    expect(Functions.httpsCallable).toHaveBeenCalledWith('functions', 'initializeJudgementHistory');
    expect(callable).toHaveBeenCalledTimes(1);
    expect(callable).toHaveBeenCalledWith({});
    expect(committed).toEqual([
      [{ id: 'fresh' }, result.goal],
      [`users/${UID}`, {
        activeGoalId: 'fresh', judgementRevisions: { goal: 2, settings: 1, xLink: 1, subscription: 1 },
      }, { merge: true }],
      [`users/${UID}/judgementHistory/goal/entries/2`, {
        schemaVersion: 1, revision: 2, committedAt: { serverTime: true }, before: null,
        after: {
          goalId: 'fresh', startDate: result.goal.startDate, examDate: result.goal.examDate,
          minDailyMinutes: result.goal.minDailyMinutes, goalDailyMinutes: result.goal.goalDailyMinutes,
        },
      }],
    ]);
    expect(clearOnboardingDraft).toHaveBeenCalledTimes(1);
    expect(writes.mock.invocationCallOrder[2]).toBeLessThan(clearOnboardingDraft.mock.invocationCallOrder[0]);
  },
);

it('validates the goal before initialization or transaction', async () => {
  const input = params();
  input.draft.examDate = '';
  await expect(saveGoal(nativeDeps(), input)).rejects.toThrow(RangeError);
  expect(callable).not.toHaveBeenCalled();
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
});

it('keeps goal unwritten and input intact while initialization is pending', async () => {
  let release!: (value: unknown) => void;
  callable.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const input = params();
  const pending = saveGoal(nativeDeps(), input);
  // Allow promise continuations without timers or retries.
  await Promise.resolve();
  expect(callable).toHaveBeenCalledTimes(1);
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
  expect(input.draft).toEqual(draft);
  initialized = true;
  release({ data: { status: 'initialized' } });
  await pending;
  expect(committed).toHaveLength(3);
});

it('preserves input on initialization failure and allows an explicit save retry', async () => {
  const input = params();
  const deps = nativeDeps();
  callable.mockRejectedValueOnce(new Error('mock unavailable'));
  await expect(saveGoal(deps, input)).rejects.toThrow();
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(committed).toEqual([]);
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
  expect(input.draft).toEqual(draft);
  await saveGoal(deps, input);
  expect(callable).toHaveBeenCalledTimes(2);
  expect(committed).toHaveLength(3);
  expect(clearOnboardingDraft).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, [], {}, { status: 'other' }, { status: true }])(
  'rejects malformed initialization response %j before saving', async (data) => {
    callable.mockResolvedValueOnce({ data });
    await expect(saveGoal(nativeDeps(), params())).rejects.toThrow();
    expect(Firestore.runTransaction).not.toHaveBeenCalled();
    expect(clearOnboardingDraft).not.toHaveBeenCalled();
  },
);

it.each([null, 'other'])('rejects initial UID mismatch %s without calling initialization', async (uid) => {
  currentUid = uid;
  await expect(saveGoal(nativeDeps(), params())).rejects.toThrow();
  expect(callable).not.toHaveBeenCalled();
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
});

it('checks UID again after callable construction immediately before sending', async () => {
  jest.mocked(Functions.httpsCallable).mockImplementationOnce(() => {
    currentUid = 'other';
    return callable;
  });
  await expect(saveGoal(nativeDeps(), params())).rejects.toThrow();
  expect(callable).not.toHaveBeenCalled();
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
});

it.each([null, 'other'])('rejects UID change %s during initialization await', async (uid) => {
  callable.mockImplementationOnce(async () => {
    currentUid = uid;
    return { data: { status: 'initialized' } };
  });
  const input = params();
  await expect(saveGoal(nativeDeps(), input)).rejects.toThrow();
  expect(Firestore.runTransaction).not.toHaveBeenCalled();
  expect(committed).toEqual([]);
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
  expect(input.draft).toEqual(draft);
});

it.each(['entry', 'read', 'retry'] as const)('rejects UID switch at transaction %s', async (stage) => {
  jest.mocked(Firestore.runTransaction).mockImplementationOnce(async (_db, body) => {
    if (stage === 'entry') currentUid = 'other';
    if (stage === 'read') reads.mockImplementationOnce(async () => {
      currentUid = 'other';
      return { exists: () => true, data: () => ({}) };
    });
    if (stage === 'retry') {
      await body({ get: reads, set: writes } as never);
      writes.mockClear();
      currentUid = 'other';
    }
    return body({ get: reads, set: writes } as never);
  });
  await expect(saveGoal(nativeDeps(), params())).rejects.toThrow();
  expect(writes).not.toHaveBeenCalled();
  expect(committed).toEqual([]);
  expect(callable).toHaveBeenCalledTimes(1);
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
});

it('does not repeat initialization when Firestore retries its callback', async () => {
  jest.mocked(Firestore.runTransaction).mockImplementationOnce(async (_db, body) => {
    await body({ get: reads, set: writes } as never);
    writes.mockClear();
    const result = await body({ get: reads, set: writes } as never);
    committed.push(...writes.mock.calls);
    return result;
  });
  await saveGoal(nativeDeps(), params());
  expect(callable).toHaveBeenCalledTimes(1);
  expect(Firestore.collection).toHaveBeenCalledTimes(1);
  expect(committed).toHaveLength(3);
  expect(clearOnboardingDraft).toHaveBeenCalledTimes(1);
});

it('keeps input if transaction fails after successful initialization', async () => {
  jest.mocked(Firestore.runTransaction).mockRejectedValueOnce(new Error('mock transaction failure'));
  const input = params();
  await expect(saveGoal(nativeDeps(), input)).rejects.toThrow();
  expect(callable).toHaveBeenCalledTimes(1);
  expect(committed).toEqual([]);
  expect(clearOnboardingDraft).not.toHaveBeenCalled();
  expect(input.draft).toEqual(draft);
});

it('loads no native SDK at adapter module import', () => {
  jest.isolateModules(() => {
    const names = ['@react-native-firebase/app', '@react-native-firebase/firestore', '@react-native-firebase/functions'];
    for (const name of names) jest.doMock(name, () => { throw new Error('eager native SDK load'); });
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(require('../goalFirestoreDeps').createGoalFirestoreDeps).toEqual(expect.any(Function));
    } finally {
      for (const name of names) jest.dontMock(name);
    }
  });
  expect(App.getApp).toBeDefined();
});
