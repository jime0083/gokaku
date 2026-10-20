import { collection, doc, getFirestore, runTransaction } from '@react-native-firebase/firestore';
import { getCurrentUid } from '@/config/firebase';
import { replaceGoal } from '../replaceGoalRepository';
import { INITIAL_ONBOARDING_DRAFT } from '../../onboarding/types';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'db'), collection: jest.fn(() => 'goals'),
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
