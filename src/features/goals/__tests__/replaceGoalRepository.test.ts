import { collection, doc, getFirestore, runTransaction, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import { getCurrentUid } from '@/config/firebase';
import { replaceGoal } from '../replaceGoalRepository';
import { INITIAL_ONBOARDING_DRAFT } from '../../onboarding/types';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'db'), collection: jest.fn(() => 'goals'),
  serverTimestamp: jest.fn(() => ({ serverTime: true })),
  Timestamp: class {
    seconds: number;
    nanoseconds: number;
    constructor(seconds: number, nanoseconds: number) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
  },
  doc: jest.fn((_db, ...path) => path.length ? path.join('/') : { id: 'fresh' }), runTransaction: jest.fn(),
}));
const draft = { ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other', certOtherName: '資格',
  targetHoursText: '100', examDate: '2027-01-01', minDailyMinutes: 30, goalDailyMinutes: 60 };
const now = Date.parse('2026-10-14T10:00:00+09:00');
afterEach(() => jest.clearAllMocks());
it.each([null, 'other'])('async rejects expected uid mismatch %s before loading Firestore or transaction', async (current) => {
  jest.mocked(getCurrentUid).mockReturnValue(current);
  await expect(replaceGoal('owner', 'old', draft, now)).rejects.toThrow();
  expect(getFirestore).not.toHaveBeenCalled(); expect(runTransaction).not.toHaveBeenCalled();
});
it('maps real domain reads/three writes to RNFB, retaining the expected owner and fresh goal id', async () => {
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  const tx = {
    get: jest.fn(async (ref) => ({ exists: () => true, data: () => ref === 'users/owner' ? { activeGoalId: 'old' } : { status: 'active' } })),
    update: jest.fn(), set: jest.fn(),
  };
  jest.mocked(runTransaction).mockImplementation(async (_db, body) => body(tx as never));
  const result = await replaceGoal('owner', 'old', draft, now);
  expect(collection).toHaveBeenCalledWith('db', 'users', 'owner', 'goals');
  expect(doc).toHaveBeenCalledWith('db', 'users', 'owner', 'goals', 'old');
  expect(tx.get.mock.calls.map(([ref]) => ref)).toEqual(['users/owner', 'users/owner/goals/old']);
  expect(tx.update.mock.calls).toEqual([['users/owner/goals/old', { status: 'replaced' }], ['users/owner', { activeGoalId: 'fresh' }]]);
  expect(tx.set).toHaveBeenCalledWith({ id: 'fresh' }, result.goal);
  expect(result.goalId).toBe('fresh');
});
it('propagates transaction failure without postcommit cleanup', async () => {
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  jest.mocked(runTransaction).mockRejectedValueOnce(new Error('offline'));
  await expect(replaceGoal('owner', 'old', draft, now)).rejects.toThrow('offline');
});


it('injects SDK Timestamp/serverTimestamp and canonical history reference', async () => {
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  const counters = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
  const before = {
    status: 'active', startDate: '2026-01-01', examDate: '2027-02-01',
    minDailyMinutes: 40, goalDailyMinutes: 80,
  };
  const tx = {
    get: jest.fn(async (ref) => ({
      exists: () => true,
      data: () => ref === 'users/owner' ? {
        activeGoalId: 'old',
        judgementHistoryStartedAt: new Timestamp(1, 123),
        judgementRevisions: counters,
      } : before,
    })),
    update: jest.fn(), set: jest.fn(),
  };
  jest.mocked(runTransaction).mockImplementation(async (_db, body) => body(tx as never));
  const result = await replaceGoal('owner', 'old', draft, now);
  expect(serverTimestamp).toHaveBeenCalledTimes(1);
  expect(doc).toHaveBeenCalledWith(
    'db', 'users', 'owner', 'judgementHistory', 'goal', 'entries', '2',
  );
  expect(tx.update.mock.calls).toEqual([
    ['users/owner/goals/old', { status: 'replaced' }],
    ['users/owner', {
      activeGoalId: 'fresh', judgementRevisions: { ...counters, goal: 2 },
    }],
  ]);
  expect(tx.set.mock.calls).toEqual([
    [{ id: 'fresh' }, result.goal],
    ['users/owner/judgementHistory/goal/entries/2', {
      schemaVersion: 1, revision: 2, committedAt: { serverTime: true },
      before: {
        goalId: 'old', startDate: before.startDate, examDate: before.examDate,
        minDailyMinutes: 40, goalDailyMinutes: 80,
      },
      after: {
        goalId: 'fresh', startDate: result.goal.startDate,
        examDate: result.goal.examDate,
        minDailyMinutes: result.goal.minDailyMinutes,
        goalDailyMinutes: result.goal.goalDailyMinutes,
      },
    }],
  ]);
});
