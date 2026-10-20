import { doc, getFirestore, updateDoc } from '@react-native-firebase/firestore';

import { getCurrentUid } from '@/config/firebase';

import { createGoalEditDraft } from '../editGoal';
import { parseEditableGoal, updateGoalNumbers } from '../editGoalRepository';
import type { GoalDocument } from '../types';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'firestore'), doc: jest.fn(() => 'goal-ref'), updateDoc: jest.fn(),
}));
const goal: GoalDocument = {
  type: 'cert', certId: 'other', certOtherName: '資格', estimatedHours: null, targetHours: 100,
  examDate: '2027-02-25', startDate: '2026-01-01', createdAt: 1, status: 'active',
  minDailyMinutes: 60, goalDailyMinutes: 120,
};
afterEach(() => jest.clearAllMocks());

describe('6-2a native edit adapter and full goal access', () => {
  it('uses authenticated uid and exactly one updateDoc numeric patch on original goal ref', async () => {
    jest.mocked(getCurrentUid).mockReturnValue('owner');
    jest.mocked(updateDoc).mockResolvedValue(undefined);
    const patch = await updateGoalNumbers('original', 'cert', createGoalEditDraft(goal), Date.parse('2026-10-14T10:00:00+09:00'));
    expect(doc).toHaveBeenCalledWith('firestore', 'users', 'owner', 'goals', 'original');
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledWith('goal-ref', {
      targetHours: 100, examDate: '2027-02-25', minDailyMinutes: 60, goalDailyMinutes: 120,
    });
    expect(patch).toEqual({ targetHours: 100, examDate: '2027-02-25', minDailyMinutes: 60, goalDailyMinutes: 120 });
  });
  it('rejects missing authentication before loading SDK or writing', async () => {
    jest.mocked(getCurrentUid).mockReturnValue(null);
    await expect(updateGoalNumbers('original', 'cert', createGoalEditDraft(goal), 0)).rejects.toThrow();
    expect(updateDoc).not.toHaveBeenCalled();
    expect(getFirestore).not.toHaveBeenCalled();
  });
  it('rejects invalid inputs before writes and propagates SDK failures', async () => {
    jest.mocked(getCurrentUid).mockReturnValue('owner');
    const now = Date.parse('2026-10-14T10:00:00+09:00');
    await expect(updateGoalNumbers('original', 'cert', { ...createGoalEditDraft(goal), targetHoursText: '0' }, now)).rejects.toThrow();
    expect(updateDoc).not.toHaveBeenCalled();
    jest.mocked(updateDoc).mockRejectedValueOnce(new Error('offline'));
    await expect(updateGoalNumbers('original', 'cert', createGoalEditDraft(goal), now)).rejects.toThrow('offline');
  });
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
