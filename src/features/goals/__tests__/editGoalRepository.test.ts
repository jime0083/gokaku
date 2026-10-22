import {
  doc, getFirestore, runTransaction, serverTimestamp, Timestamp, updateDoc,
} from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';

import { createGoalEditDraft } from '../editGoal';
import { parseEditableGoal, updateGoalNumbers } from '../editGoalRepository';
import type { GoalDocument } from '../types';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'firestore'),
  doc: jest.fn((_db, ...path) => path.join('/')),
  runTransaction: jest.fn(),
  updateDoc: jest.fn(async () => {}),
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

const goal: GoalDocument = {
  type: 'cert', certId: 'other', certOtherName: '資格', estimatedHours: null, targetHours: 100,
  examDate: '2027-02-25', startDate: '2026-01-01', createdAt: 1, status: 'active',
  minDailyMinutes: 60, goalDailyMinutes: 120,
};
const now = Date.parse('2026-10-14T10:00:00+09:00');
const userRef = 'users/owner';
const goalRef = `${userRef}/goals/original`;
const entryRef = `${userRef}/judgementHistory/goal/entries/2`;
const counters = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
const metadata = () => ({
  judgementHistoryStartedAt: new Timestamp(1, 123),
  judgementRevisions: { ...counters },
});
const projection = (data: Record<string, unknown>) => ({
  goalId: 'original', startDate: data.startDate, examDate: data.examDate,
  minDailyMinutes: data.minDailyMinutes, goalDailyMinutes: data.goalDailyMinutes,
});
let currentUser: Record<string, unknown>;
let currentGoal: Record<string, unknown>;
let userExists: boolean;
let goalExists: boolean;
let switchAfterRead: number;
let readCount: number;
const tx = { get: jest.fn(), update: jest.fn(), set: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = { activeGoalId: 'original' };
  currentGoal = { ...goal };
  userExists = true;
  goalExists = true;
  switchAfterRead = 0;
  readCount = 0;
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  tx.get.mockImplementation(async (ref: string) => {
    if (ref !== userRef && ref !== goalRef) throw new Error(`Unexpected read: ${ref}`);
    const exists = ref === userRef ? userExists : goalExists;
    const value = ref === userRef ? currentUser : currentGoal;
    readCount += 1;
    if (readCount === switchAfterRead) jest.mocked(getCurrentUid).mockReturnValue('other');
    return { exists: () => exists, data: () => exists ? value : undefined };
  });
  jest.mocked(runTransaction).mockImplementation(async (_db, body) => body(tx as never));
});

const save = (draft = createGoalEditDraft(goal), type: GoalDocument['type'] = 'cert') =>
  updateGoalNumbers('original', type, draft, now);
const noWrites = () => {
  expect(tx.update).not.toHaveBeenCalled();
  expect(tx.set).not.toHaveBeenCalled();
  expect(updateDoc).not.toHaveBeenCalled();
};

describe('7-2-D native numeric-edit transaction', () => {
  it('legacy uses authenticated owner/ref and exactly one allowlist partial update', async () => {
    const patch = await save();
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(doc).toHaveBeenCalledWith('firestore', 'users', 'owner');
    expect(doc).toHaveBeenCalledWith('firestore', 'users', 'owner', 'goals', 'original');
    expect(tx.get.mock.calls.map(([ref]) => ref)).toEqual([userRef, goalRef]);
    expect(patch).toEqual({
      targetHours: 100, examDate: goal.examDate, minDailyMinutes: 60, goalDailyMinutes: 120,
    });
    expect(tx.update.mock.calls).toEqual([[goalRef, patch]]);
    expect(tx.set).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
    expect(serverTimestamp).not.toHaveBeenCalled();
  });

  it.each(['cert', 'exam'] as const)('initialized %s writes current before, patched after and counter atomically', async (type) => {
    currentUser = { ...currentUser, ...metadata() };
    currentGoal = type === 'exam'
      ? { ...goal, type, university: '大学', targetDeviation: 60.1, currentDeviation: 50.1, subjectCount: 3 }
      : { ...goal };
    // A value changed since the popup opened must be preserved in before.
    currentGoal = { ...currentGoal, minDailyMinutes: 30, createdAt: 10 };
    const initialUser = { ...currentUser };
    const initialGoal = { ...currentGoal };
    const draft = {
      ...createGoalEditDraft(currentGoal as GoalDocument),
      targetHoursText: '200', minDailyMinutes: 90, goalDailyMinutes: 180,
    };
    const patch = await save(draft, type);
    expect(tx.get.mock.calls.map(([ref]) => ref)).toEqual([userRef, goalRef]);
    expect(tx.update.mock.calls).toEqual([
      [goalRef, patch],
      [userRef, expect.any(Object)],
    ]);
    // Support either nested-field update or a map update preserving all other counters.
    const parentPatch = tx.update.mock.calls[1][1];
    expect([
      { 'judgementRevisions.goal': 2 },
      { judgementRevisions: { ...counters, goal: 2 } },
    ]).toContainEqual(parentPatch);
    expect(tx.set.mock.calls).toEqual([[entryRef, {
      schemaVersion: 1, revision: 2, committedAt: { serverTime: true },
      before: projection(initialGoal),
      after: projection({ ...initialGoal, ...patch }),
    }]]);
    expect(serverTimestamp).toHaveBeenCalledTimes(1);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(currentUser).toEqual(initialUser);
    expect(currentGoal).toEqual(initialGoal);
    expect(patch).not.toHaveProperty('createdAt');
    expect(patch).not.toHaveProperty('startDate');
    expect(patch).not.toHaveProperty('estimatedHours');
    if (type === 'exam') {
      expect(patch).toMatchObject({ targetDeviation: 60.1, currentDeviation: 50.1, subjectCount: 3 });
    }
  });

  it.each([false, true])('permits equal snapshots (targetHours-only change=%s)', async (hoursOnly) => {
    currentUser = { ...currentUser, ...metadata() };
    await save({
      ...createGoalEditDraft(goal), targetHoursText: hoursOnly ? '200' : '100',
    });
    expect(tx.set).toHaveBeenCalledWith(entryRef, {
      schemaVersion: 1, revision: 2, committedAt: { serverTime: true },
      before: projection(goal), after: projection(goal),
    });
  });

  it('SDK retry rereads current before/counter and selects the new canonical entry', async () => {
    currentUser = { ...currentUser, ...metadata() };
    jest.mocked(runTransaction).mockImplementationOnce(async (_db, body) => {
      await body(tx as never); // SDK discards this attempted transaction.
      currentUser = { ...currentUser, judgementRevisions: { ...counters, goal: 5 } };
      currentGoal = { ...currentGoal, minDailyMinutes: 40 };
      tx.get.mockClear(); tx.update.mockClear(); tx.set.mockClear();
      return body(tx as never);
    });
    await save();
    expect(tx.get.mock.calls.map(([ref]) => ref)).toEqual([userRef, goalRef]);
    expect(tx.set.mock.calls).toEqual([[
      `${userRef}/judgementHistory/goal/entries/6`,
      {
        schemaVersion: 1, revision: 6, committedAt: { serverTime: true },
        before: projection(currentGoal), after: projection(goal),
      },
    ]]);
    expect([
      { 'judgementRevisions.goal': 6 },
      { judgementRevisions: { ...counters, goal: 6 } },
    ]).toContainEqual(tx.update.mock.calls[1][1]);
  });

  it.each([1, 2])('rejects UID change after async read %s before any write', async (read) => {
    currentUser = { ...currentUser, ...metadata() };
    switchAfterRead = read;
    await expect(save()).rejects.toThrow();
    noWrites();
  });

  it('rejects missing authentication before loading Firestore', async () => {
    jest.mocked(getCurrentUid).mockReturnValue(null);
    await expect(save()).rejects.toThrow();
    expect(getFirestore).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
    noWrites();
  });

  it('rejects invalid input before SDK/transaction', async () => {
    await expect(save({ ...createGoalEditDraft(goal), targetHoursText: '0' })).rejects.toThrow();
    expect(getFirestore).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
    noWrites();
  });

  it('propagates SDK transaction failure', async () => {
    jest.mocked(runTransaction).mockRejectedValueOnce(new Error('offline'));
    await expect(save()).rejects.toThrow('offline');
    noWrites();
  });

  it.each(['user-missing', 'goal-missing', 'pointer', 'type', 'status', 'deleting'])(
    'rejects invalid current state: %s', async (state) => {
      currentUser = { ...currentUser, ...metadata() };
      if (state === 'user-missing') userExists = false;
      if (state === 'goal-missing') goalExists = false;
      if (state === 'pointer') currentUser.activeGoalId = 'another';
      if (state === 'type') currentGoal.type = 'exam';
      if (state === 'status') currentGoal.status = 'replaced';
      if (state === 'deleting') currentUser.deletionInProgress = true;
      await expect(save()).rejects.toThrow();
      noWrites();
    },
  );

  const badMetadata: Record<string, unknown>[] = [
    { judgementHistoryStartedAt: new Timestamp(1, 0) },
    { judgementRevisions: counters },
    { ...metadata(), judgementHistoryStartedAt: null },
    { ...metadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
    { ...metadata(), judgementRevisions: null },
    { ...metadata(), judgementRevisions: [] },
    { ...metadata(), judgementRevisions: {} },
    ...(['goal', 'settings', 'xLink', 'subscription'] as const).flatMap((stream) =>
      [undefined, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => ({
        ...metadata(), judgementRevisions: { ...counters, [stream]: value },
      }))),
    { ...metadata(), judgementRevisions: { ...counters, goal: Number.MAX_SAFE_INTEGER } },
  ];

  it.each(badMetadata)('fails closed for partial/invalid metadata: %#', async (bad) => {
    currentUser = { activeGoalId: 'original', ...bad };
    await expect(save()).rejects.toThrow();
    noWrites();
  });
});

describe('editable goal parsing remains unchanged', () => {
  it('preserves old startDate and estimated snapshot when reading both goal types', () => {
    expect(parseEditableGoal(goal)).toEqual(goal);
    const exam = { ...goal, type: 'exam', university: '大学', targetDeviation: 64.1, currentDeviation: 35.1, subjectCount: 3 };
    expect(parseEditableGoal(exam)).toEqual(exam);
  });
  it.each([undefined, {}, { ...goal, status: 'replaced' }, { ...goal, minDailyMinutes: '60' },
    { ...goal, type: 'exam' }, { ...goal, type: 'unknown' }, { ...goal, certId: 1 }])('does not open incomplete/non-active goal %p', (data) => {
    expect(parseEditableGoal(data)).toBeUndefined();
  });
});
