import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteField, setLogLevel } from 'firebase/firestore';
import { addDays, toJstDateKey } from '@shared/index';
import { createGoalEditDraft, saveGoalEdit } from '../../src/features/goals/editGoal';
import type { GoalDocument } from '../../src/features/goals/types';

const uid = 'owner';
let env: RulesTestEnvironment;
const today = () => toJstDateKey(Date.now());
const examGoal = () => ({ type: 'exam', university: '大学', targetDeviation: 60.1, currentDeviation: 50.1,
  subjectCount: 3, estimatedHours: { status: 'ok', lowerHours: 900, upperHours: 1500 },
  targetHours: 1000, examDate: addDays(today(), 30), startDate: addDays(today(), -30), status: 'active',
  createdAt: 1, minDailyMinutes: 60, goalDailyMinutes: 120 });
const certGoal = () => ({ type: 'cert', certId: 'other', certOtherName: '資格', estimatedHours: null,
  targetHours: 1000, examDate: addDays(today(), 30), startDate: addDays(today(), -30), status: 'active',
  createdAt: 1, minDailyMinutes: 60, goalDailyMinutes: 120 });
beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({ projectId: `demo-gokaku-edit-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', uid), { activeGoalId: 'exam', createdAt: 1 });
    await setDoc(doc(db, 'users', uid, 'goals', 'exam'), examGoal());
    await setDoc(doc(db, 'users', uid, 'goals', 'cert'), certGoal());
    await setDoc(doc(db, 'users', uid, 'sessions', 's'), { goalId: 'exam', startAt: 1, stopAt: 100 });
    await setDoc(doc(db, 'users', uid, 'dailyResults', '2026-10-01'), { goalId: 'exam', studiedMinutes: 10 });
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => { if (env) await env.cleanup(); });
const ref = (id = 'exam', auth: string | null = uid) => doc(
  (auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore(), 'users', uid, 'goals', id);

describe('6-2a numeric update allowlist', () => {
  it('allows atomic numeric patch of an old goal, retaining all immutable fields/history/sessions', async () => {
    const before = (await getDoc(ref())).data();
    const patch = { targetHours: 2000, examDate: addDays(today(), 1), minDailyMinutes: 120, goalDailyMinutes: 240,
      targetDeviation: 70.1, currentDeviation: 55.1, subjectCount: 8 };
    await assertSucceeds(updateDoc(ref(), patch));
    expect((await getDoc(ref())).data()).toEqual({ ...before, ...patch });
    const db = env.authenticatedContext(uid).firestore();
    expect((await getDoc(doc(db, 'users', uid))).data()?.activeGoalId).toBe('exam');
    expect((await getDoc(doc(db, 'users', uid, 'sessions', 's'))).data()).toEqual({ goalId: 'exam', startAt: 1, stopAt: 100 });
    expect((await getDoc(doc(db, 'users', uid, 'dailyResults', '2026-10-01'))).data()).toEqual({ goalId: 'exam', studiedMinutes: 10 });
  });
  it('runs the actual save layer against Emulator, preserving id and making no partial write on rejection', async () => {
    const current = (await getDoc(ref())).data() as GoalDocument;
    const draft = { ...createGoalEditDraft(current), targetHoursText: '2000', targetDeviationText: '64.1' };
    const update = async (_owner: string, id: string, patch: object) => { await updateDoc(ref(id), patch); };
    await saveGoalEdit({ update }, { uid, goalId: 'exam', type: 'exam', draft, now: Date.now() });
    expect((await getDoc(ref())).data()).toEqual({ ...current, targetHours: 2000, targetDeviation: 64.1 });
    // Client clock behind the server accepts today's exam date locally; server rejects the entire patch.
    await expect(saveGoalEdit({ update }, { uid, goalId: 'exam', type: 'exam',
      draft: { ...draft, targetHoursText: '3000', examDate: today() }, now: Date.now() - 86400000 })).rejects.toThrow();
    expect((await getDoc(ref())).data()?.targetHours).toBe(2000);
  });
  it.each([null, 'other'])('rejects non-owner %s', async (auth) => {
    await assertFails(updateDoc(ref('exam', auth), { targetHours: 2000 }));
  });
  it.each(['type', 'university', 'certId', 'certOtherName', 'startDate', 'status', 'createdAt', 'estimatedHours', 'extra'])('rejects immutable field mixed writes and deletions: %s', async (field) => {
    await assertFails(updateDoc(ref(), { targetHours: 2000, [field]: 'changed' }));
    // deleteField on an absent key is a no-op, so only test actual deletions.
    if (field in examGoal()) await assertFails(updateDoc(ref(), { targetHours: 2000, [field]: deleteField() }));
    expect((await getDoc(ref())).data()?.targetHours).toBe(1000);
  });
  it('rejects nested estimate changes', async () => {
    await assertFails(updateDoc(ref(), { targetHours: 2000, 'estimatedHours.upperHours': 2000 }));
  });
  it.each(['targetHours', 'examDate', 'minDailyMinutes', 'goalDailyMinutes', 'targetDeviation', 'currentDeviation', 'subjectCount'])('rejects deletion of required editable field %s', async (field) => {
    await assertFails(updateDoc(ref(), { [field]: deleteField() }));
  });
  it.each([
    ['targetHours', 0], ['targetHours', 20001], ['targetHours', 1.5], ['targetHours', '100'], ['targetHours', NaN],
    ['minDailyMinutes', 0], ['minDailyMinutes', 15], ['minDailyMinutes', 970], ['minDailyMinutes', '60'],
    ['goalDailyMinutes', 50], ['goalDailyMinutes', 970], ['goalDailyMinutes', 125], ['goalDailyMinutes', null],
    ['targetDeviation', 24.9], ['targetDeviation', 80.1], ['targetDeviation', 50.15], ['targetDeviation', '60'],
    ['currentDeviation', 50.15], ['currentDeviation', NaN], ['subjectCount', 0], ['subjectCount', 9], ['subjectCount', 1.5],
    ['examDate', '2027-02-29'], ['examDate', '2026-13-01'], ['examDate', 'bad'], ['examDate', null],
  ])('rejects invalid %s=%s', async (field, value) => {
    await assertFails(updateDoc(ref(), { [field as string]: value }));
  });
  it.each([0, -1])('rejects server JST today/past (%s days)', async (offset) => {
    await assertFails(updateDoc(ref(), { examDate: addDays(today(), offset) }));
  });
  it.each([1, 20000])('accepts target hours boundary %s', async (targetHours) => {
    await assertSucceeds(updateDoc(ref(), { targetHours }));
  });
  it.each([25, 80, 60.1, 25.3, 79.9, 64.1, 35.1])('accepts valid 0.1 precision %s', async (value) => {
    await assertSucceeds(updateDoc(ref(), { targetDeviation: value, currentDeviation: value }));
  });
  it.each([10, 960])('accepts daily boundary %s', async (value) => {
    await assertSucceeds(updateDoc(ref(), { minDailyMinutes: value, goalDailyMinutes: value }));
  });
  it('rejects non-current and finished/replaced goals', async () => {
    await assertFails(updateDoc(ref('cert'), { targetHours: 2000 }));
    for (const status of ['finished', 'replaced']) {
      await env.withSecurityRulesDisabled(async (context) => {
        await updateDoc(doc(context.firestore(), 'users', uid, 'goals', 'exam'), { status });
      });
      await assertFails(updateDoc(ref(), { targetHours: 2000 }));
    }
  });
  it('allows cert numeric edits but rejects exam fields and cert identity writes', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'users', uid), { activeGoalId: 'cert' });
    });
    await assertSucceeds(updateDoc(ref('cert'), { targetHours: 2000, examDate: addDays(today(), 1), minDailyMinutes: 10, goalDailyMinutes: 960 }));
    for (const field of ['targetDeviation', 'currentDeviation', 'subjectCount', 'certId', 'certOtherName']) {
      await assertFails(updateDoc(ref('cert'), { [field]: field === 'subjectCount' ? 3 : field.includes('Deviation') ? 60 : 'changed' }));
    }
    for (const field of ['certId', 'certOtherName', 'type', 'startDate', 'status', 'createdAt', 'estimatedHours']) {
      await assertFails(updateDoc(ref('cert'), { targetHours: 1500, [field]: deleteField() }));
    }
    expect((await getDoc(ref('cert'))).data()).toEqual({ ...certGoal(), targetHours: 2000,
      examDate: addDays(today(), 1), minDailyMinutes: 10, goalDailyMinutes: 960 });
  });
});
