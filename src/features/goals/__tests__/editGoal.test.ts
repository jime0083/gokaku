import type { DateKey } from '@shared/index';
import { buildGoalEditPatch, createGoalEditDraft, validateGoalEditDraft, saveGoalEdit } from '../editGoal';
import type { GoalDocument } from '../types';

const now = Date.parse('2026-10-14T23:59:59+09:00');
const goal: GoalDocument = {
  type: 'exam', university: '大学', targetDeviation: 60.1, currentDeviation: 50.1, subjectCount: 3,
  estimatedHours: { status: 'ok', lowerHours: 900, upperHours: 1500 }, targetHours: 1000,
  examDate: '2027-02-25', startDate: '2026-10-01', status: 'active', createdAt: 1,
  minDailyMinutes: 60, goalDailyMinutes: 120,
};

describe('6-2a numeric goal edit', () => {
  it('prefills all current values and builds only the numeric patch, without changing the estimate/identity', () => {
    const draft = createGoalEditDraft(goal);
    expect(draft).toEqual({ targetHoursText: '1000', examDate: '2027-02-25', minDailyMinutes: 60,
      goalDailyMinutes: 120, targetDeviationText: '60.1', currentDeviationText: '50.1', subjectCount: 3 });
    expect(buildGoalEditPatch('exam', { ...draft, targetDeviationText: '70.1', subjectCount: 8 }, now)).toEqual({
      targetHours: 1000, examDate: '2027-02-25', minDailyMinutes: 60, goalDailyMinutes: 120,
      targetDeviation: 70.1, currentDeviation: 50.1, subjectCount: 8,
    });
    expect(goal.estimatedHours).toEqual({ status: 'ok', lowerHours: 900, upperHours: 1500 });
  });

  it.each(['', '0', '20001', '1.5', 'NaN', 'Infinity'])('rejects target hours %s before writing', async (targetHoursText) => {
    const update = jest.fn();
    await expect(saveGoalEdit({ update }, { uid: 'owner', goalId: 'goal', type: 'exam',
      draft: { ...createGoalEditDraft(goal), targetHoursText }, now })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([1, 20000])('accepts target hours boundary %s', (hours) => {
    expect(buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), targetHoursText: String(hours) }, now).targetHours).toBe(hours);
  });

  it.each([25, 80, 60.1, 64.1, 35.1])('accepts deviation %s', (deviation) => {
    expect(buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), targetDeviationText: String(deviation) }, now).targetDeviation).toBe(deviation);
  });

  it.each(['24.9', '80.1', '50.15', 'NaN', ''])('rejects deviation %s', (value) => {
    expect(validateGoalEditDraft('exam', { ...createGoalEditDraft(goal), currentDeviationText: value }, now).currentDeviation).not.toBeNull();
  });

  it.each([0, 9, 1.5, NaN])('rejects subject count %s', (subjectCount) => {
    expect(() => buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), subjectCount }, now)).toThrow();
  });

  it.each([0, 15, 970, NaN])('rejects daily minutes %s', (minDailyMinutes) => {
    expect(() => buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), minDailyMinutes }, now)).toThrow();
  });

  it('rejects effort below minimum, today, invalid dates and rechecks midnight JST at save', () => {
    const draft = createGoalEditDraft(goal);
    expect(() => buildGoalEditPatch('exam', { ...draft, goalDailyMinutes: 50 }, now)).toThrow();
    for (const examDate of ['2026-10-14', '2027-02-29', '2026-13-01']) {
      expect(() => buildGoalEditPatch('exam', { ...draft, examDate: examDate as DateKey }, now)).toThrow();
    }
    expect(buildGoalEditPatch('exam', { ...draft, examDate: '2026-10-15' }, now).examDate).toBe('2026-10-15');
    expect(() => buildGoalEditPatch('exam', { ...draft, examDate: '2026-10-15' }, now + 1000)).toThrow();
  });

  it('cert patch excludes exam fields even if supplied by the caller; one update keeps goal id', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const patch = await saveGoalEdit({ update }, { uid: 'owner', goalId: 'original', type: 'cert', draft: createGoalEditDraft(goal), now });
    expect(patch).toEqual({ targetHours: 1000, examDate: '2027-02-25', minDailyMinutes: 60, goalDailyMinutes: 120 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('owner', 'original', patch);
  });

  it('propagates communication errors without modifying draft and blocks missing identity', async () => {
    const draft = createGoalEditDraft(goal);
    const copy = { ...draft };
    const update = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(saveGoalEdit({ update }, { uid: 'owner', goalId: 'original', type: 'exam', draft, now })).rejects.toThrow('offline');
    expect(draft).toEqual(copy);
    await expect(saveGoalEdit({ update }, { uid: '', goalId: 'original', type: 'exam', draft, now })).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
  });
});


describe('edit patch wrong types and boundary daily values', () => {
  it.each([10, 960])('accepts daily boundary %s', (minutes) => {
    expect(buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), minDailyMinutes: minutes,
      goalDailyMinutes: minutes }, now).minDailyMinutes).toBe(minutes);
  });
  it.each(['60', null, undefined, Infinity])('rejects wrong daily minute value %s', (value) => {
    expect(() => buildGoalEditPatch('exam', { ...createGoalEditDraft(goal), minDailyMinutes: value as number }, now)).toThrow();
  });
});
