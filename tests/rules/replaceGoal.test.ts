import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, runTransaction, setDoc, updateDoc, writeBatch, deleteField, setLogLevel } from 'firebase/firestore';
import { addDays, toJstDateKey } from '@shared/index';
import { replaceGoal, GoalReplacementConflictError, type ReplaceGoalDeps } from '../../src/features/goals/replaceGoal';
import { GoalRejectedByServerError } from '../../src/features/goals/saveGoal';
import { buildGoalDocument } from '../../src/features/goals/buildGoalDocument';
import { INITIAL_ONBOARDING_DRAFT } from '../../src/features/onboarding/types';

let env: RulesTestEnvironment;
const uid = 'owner';
const draft = () => ({ ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other', certOtherName: '新資格',
  targetHoursText: '100', examDate: addDays(toJstDateKey(Date.now()), 30), minDailyMinutes: 30, goalDailyMinutes: 60 });
const oldGoal = () => ({ ...buildGoalDocument(draft(), Date.now()), startDate: '2026-01-01', createdAt: 1,
  metadata: { retained: true } });
const user = { activeGoalId: 'old', createdAt: 1, subscription: { status: 'active' }, xLinked: true,
  xUsername: 'owner-x', xNotice: 'notice', checkEnabled: false, xPostEnabled: true };
const session = { goalId: 'old', startAt: 1, stopAt: 60001 };
const daily = { goalId: 'old', studiedMinutes: 1 };
const databases = new Map<string | null, ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>>();
function dbFor(auth: string | null = uid) {
  let db = databases.get(auth);
  if (!db) {
    db = (auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore();
    databases.set(auth, db);
  }
  return db;
}
const goalRef = (id: string, auth: string | null = uid) => doc(dbFor(auth), 'users', uid, 'goals', id);
const userRef = (auth: string | null = uid) => doc(dbFor(auth), 'users', uid);
beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({ projectId: `demo-gokaku-replace-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', uid), user);
    await setDoc(doc(db, 'users', uid, 'goals', 'old'), oldGoal());
    await setDoc(doc(db, 'users', uid, 'sessions', 'session'), session);
    await setDoc(doc(db, 'users', uid, 'dailyResults', 'day'), daily);
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => { if (env) await env.cleanup(); });
function deps(auth: string | null = uid): ReplaceGoalDeps<ReturnType<typeof doc>> {
  const db = dbFor(auth);
  return {
    getCurrentUid: () => uid, getUserDocRef: (owner) => doc(db, 'users', owner),
    getGoalDocRef: (owner, id) => doc(db, 'users', owner, 'goals', id),
    createGoalDocRef: (owner) => { const ref = doc(collection(db, 'users', owner, 'goals')); return { ref, id: ref.id }; },
    runTransaction: (body) => runTransaction(db, (tx) => body({
      get: async (ref) => { const snapshot = await tx.get(ref); return { exists: () => snapshot.exists(), data: () => snapshot.data() }; },
      set: (ref, data, options) => options ? tx.set(ref, data, options) : tx.set(ref, data),
      update: (ref, data) => tx.update(ref, data),
    })),
  };
}
const params = () => ({ expectedUid: uid, expectedGoalId: 'old', draft: draft(), now: Date.now() });
async function assertUnchanged(before: unknown) {
  expect((await getDoc(goalRef('old'))).data()).toEqual(before);
  expect((await getDoc(userRef())).data()).toEqual(user);
  expect((await getDocs(collection(dbFor(), 'users', uid, 'goals'))).size).toBe(1);
}
function replacementBatch(overrides: { old?: object; next?: object; pointer?: unknown; auth?: string | null; skipOld?: boolean; skipNew?: boolean; skipPointer?: boolean } = {}) {
  const auth = overrides.auth === undefined ? uid : overrides.auth;
  const batch = writeBatch(dbFor(auth));
  if (!overrides.skipOld) batch.update(goalRef('old', auth), { status: 'replaced', ...overrides.old });
  if (!overrides.skipNew) batch.set(goalRef('new', auth), { ...buildGoalDocument(draft(), Date.now()), ...overrides.next });
  if (!overrides.skipPointer) batch.update(userRef(auth), { activeGoalId: overrides.pointer === undefined ? 'new' : overrides.pointer });
  return batch;
}
it('runs real domain transaction; preserves old metadata/history/settings and gives new goal no records', async () => {
  const before = (await getDoc(goalRef('old'))).data();
  const result = await replaceGoal(deps(), params());
  expect((await getDoc(goalRef('old'))).data()).toEqual({ ...before, status: 'replaced' });
  expect((await getDoc(goalRef(result.goalId))).data()).toEqual(result.goal);
  expect((await getDoc(userRef())).data()).toEqual({ ...user, activeGoalId: result.goalId });
  expect((await getDoc(doc(dbFor(), 'users', uid, 'sessions', 'session'))).data()).toEqual(session);
  expect((await getDoc(doc(dbFor(), 'users', uid, 'dailyResults', 'day'))).data()).toEqual(daily);
  const sessions = await getDocs(collection(dbFor(), 'users', uid, 'sessions'));
  expect(sessions.docs.filter((row) => row.data().goalId === result.goalId)).toEqual([]);
  await expect(replaceGoal(deps(), params())).rejects.toBeInstanceOf(GoalReplacementConflictError);
  expect((await getDocs(collection(dbFor(), 'users', uid, 'goals'))).size).toBe(2);
});
it('concurrent replacements commit exactly one and reject the stale old pointer', async () => {
  const results = await Promise.allSettled([replaceGoal(deps(), params()), replaceGoal(deps(), params())]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  // Emulator may reject stale writes in rules before the SDK retries its read callback.
  if (failed.reason instanceof GoalRejectedByServerError) {
    expect((failed.reason.cause as { code: string }).code).toBe('permission-denied');
  } else {
    expect(failed.reason).toBeInstanceOf(GoalReplacementConflictError);
  }
  const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof replaceGoal>>>;
  expect((await getDoc(userRef())).data()?.activeGoalId).toBe(winner.value.goalId);
  expect((await getDoc(goalRef('old'))).data()?.status).toBe('replaced');
  expect((await getDocs(collection(dbFor(), 'users', uid, 'goals'))).size).toBe(2);
}, 20000);
it.each([null, 'other'])('rejects unauthorized domain transaction %s with no partial writes', async (auth) => {
  const before = (await getDoc(goalRef('old'))).data();
  await expect(replaceGoal(deps(auth), params())).rejects.toThrow();
  await assertUnchanged(before);
});
it.each([
  { skipOld: true }, { skipNew: true }, { skipPointer: true },
  { pointer: null }, { pointer: 'missing' }, { pointer: 'old' },
  { old: { status: 'finished' } }, { old: { status: 'active' } },
  { old: { targetHours: 200 } }, { old: { startDate: toJstDateKey(Date.now()) } },
  { old: { estimatedHours: null, createdAt: 2 } }, { old: { certOtherName: 'changed' } },
  { old: { metadata: deleteField() } },
  { next: { status: 'replaced' } }, { next: { targetHours: 0 } }, { next: { minDailyMinutes: 15 } },
  { next: { startDate: '2026-01-01' } }, { next: { examDate: toJstDateKey(Date.now()) } },
  { next: { examDate: '2027-02-29' } }, { next: { extra: true } },
  { auth: null }, { auth: 'other' },
])('rejects malformed/malicious atomic replacement %p and rolls back all writes', async (change) => {
  const before = (await getDoc(goalRef('old'))).data();
  await assertFails(replacementBatch(change).commit());
  await assertUnchanged(before);
});
it.each(['active', 'finished', 'replaced'])('cannot reset by switching to a preexisting %s goal', async (status) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid, 'goals', 'existing'), { ...buildGoalDocument(draft(), Date.now()), status });
  });
  await assertFails(replacementBatch({ pointer: 'existing', skipNew: true }).commit());
  await assertFails(updateDoc(userRef(), { activeGoalId: 'existing' }));
  expect((await getDoc(userRef())).data()).toEqual(user);
});
it('denies standalone creation, status changes, pointer null/deletion/missing and extra active goals', async () => {
  await assertFails(setDoc(goalRef('new'), buildGoalDocument(draft(), Date.now())));
  await assertFails(updateDoc(goalRef('old'), { status: 'replaced' }));
  for (const activeGoalId of [null, 'missing', deleteField(), 1, '']) await assertFails(updateDoc(userRef(), { activeGoalId }));
  const batch = replacementBatch();
  batch.set(goalRef('extra'), buildGoalDocument(draft(), Date.now()));
  await assertFails(batch.commit());
});
it('rejects mixing protected user fields or history writes into replacement', async () => {
  for (const field of ['subscription', 'xLinked', 'xUsername', 'xNotice', 'createdAt']) {
    const batch = replacementBatch(); batch.update(userRef(), { [field]: 'changed' });
    await assertFails(batch.commit());
  }
  const batch = replacementBatch(); batch.update(doc(dbFor(), 'users', uid, 'sessions', 'session'), { goalId: 'new' });
  await assertFails(batch.commit());
});
it('rejects replacing an inactive or missing old goal, including direct batches', async () => {
  for (const status of ['finished', 'replaced']) {
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'users', uid, 'goals', 'old'), { status }); });
    await expect(replaceGoal(deps(), params())).rejects.toBeInstanceOf(GoalReplacementConflictError);
    await assertFails(replacementBatch().commit());
  }
});

// P-048: Construct a complete exam goal so rejection cannot come from mixed cert/exam keys.
function examReplacementBatch(patch: Record<string, unknown>) {
  const goal = buildGoalDocument({ ...draft(), type: 'exam', university: '合格大学',
    targetDeviationText: '60', currentDeviationText: '50', subjectCount: 3 }, Date.now());
  const batch = replacementBatch({ skipNew: true });
  batch.set(goalRef('new'), { ...goal, ...patch });
  return batch;
}
it.each(['targetDeviation', 'currentDeviation'])('P-048: replacement rejects non-tenth %s without changing old goal/pointer/history', async (field) => {
  const before = (await getDoc(goalRef('old'))).data();
  for (const value of [60.05, 60.00001]) {
    await assertFails(examReplacementBatch({ [field]: value }).commit());
    await assertUnchanged(before);
    expect((await getDoc(goalRef('new'))).exists()).toBe(false);
    expect((await getDoc(doc(dbFor(), 'users', uid, 'sessions', 'session'))).data()).toEqual(session);
    expect((await getDoc(doc(dbFor(), 'users', uid, 'dailyResults', 'day'))).data()).toEqual(daily);
  }
});
it.each([25, 80, 60.1, 60.1000005])('P-048: replacement accepts both deviations at valid boundary/precision/tolerance %s', async (value) => {
  const before = (await getDoc(goalRef('old'))).data();
  await assertSucceeds(examReplacementBatch({ targetDeviation: value, currentDeviation: value }).commit());
  expect((await getDoc(goalRef('old'))).data()).toEqual({ ...before, status: 'replaced' });
  expect((await getDoc(userRef())).data()).toEqual({ ...user, activeGoalId: 'new' });
  expect((await getDoc(goalRef('new'))).data()).toEqual(expect.objectContaining({ type: 'exam',
    status: 'active', targetDeviation: value, currentDeviation: value }));
});
