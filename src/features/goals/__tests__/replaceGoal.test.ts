import { replaceGoal, GoalReplacementConflictError, GoalReplacementAuthError, type ReplaceGoalDeps } from '../replaceGoal';
import { GoalRejectedByServerError } from '../saveGoal';
import { buildGoalDocument } from '../buildGoalDocument';
import { INITIAL_ONBOARDING_DRAFT } from '../../onboarding/types';

const now = Date.parse('2026-10-14T10:00:00+09:00');
const draft = { ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other', certOtherName: '新資格',
  targetHoursText: '100', examDate: '2027-01-01', minDailyMinutes: 30, goalDailyMinutes: 60 };
const old = { ...buildGoalDocument(draft, now), startDate: '2026-01-01', createdAt: 1, extraMetadata: { kept: true } };
const user = { activeGoalId: 'old', subscription: { status: 'active' }, xLinked: true, xUsername: 'owner',
  checkEnabled: false, xPostEnabled: true, createdAt: 1 };
function setup() {
  const store: Record<string, Record<string, unknown>> = { user: { ...user }, old: { ...old } };
  const writes: string[] = [];
  let uid: string | null = 'owner';
  const deps: ReplaceGoalDeps<string> = {
    getCurrentUid: () => uid,
    getUserDocRef: () => 'user', getGoalDocRef: (_uid, id) => id,
    createGoalDocRef: jest.fn(() => ({ ref: 'new', id: 'new' })),
    runTransaction: jest.fn(async (body) => {
      const staged: (() => void)[] = [];
      const result = await body({
        get: async (ref) => {
          expect(writes).toEqual([]);
          return { exists: () => !!store[ref], data: () => store[ref] };
        },
        set: (ref, data) => { writes.push(ref); staged.push(() => { store[ref] = data; }); },
        update: (ref, data) => { writes.push(ref); staged.push(() => { store[ref] = { ...store[ref], ...data }; }); },
      });
      staged.forEach((commit) => commit());
      return result;
    }),
  };
  return { deps, store, writes, setUid: (value: string | null) => { uid = value; } };
}
const params = { expectedUid: 'owner', expectedGoalId: 'old', draft, now };
it('atomically creates a fresh goal and changes only old status/user pointer, without mutating the draft', async () => {
  const { deps, store } = setup();
  const before = { ...draft };
  const result = await replaceGoal(deps, params);
  expect(result).toEqual({ goalId: 'new', goal: buildGoalDocument(draft, now) });
  expect(store).toEqual({ user: { ...user, activeGoalId: 'new' }, old: { ...old, status: 'replaced' }, new: result.goal });
  expect(draft).toEqual(before);
});
it.each([null, 'different'])('rejects auth mismatch %s before transaction', async (uid) => {
  const { deps, setUid } = setup(); setUid(uid);
  await expect(replaceGoal(deps, params)).rejects.toBeInstanceOf(GoalReplacementAuthError);
  expect(deps.runTransaction).not.toHaveBeenCalled();
});
it('guards auth again when the transaction callback runs', async () => {
  const { deps, setUid } = setup();
  const original = deps.runTransaction;
  deps.runTransaction = async (body) => { setUid(null); return original(body); };
  await expect(replaceGoal(deps, params)).rejects.toBeInstanceOf(GoalReplacementAuthError);
});
it.each(['missing-user', 'wrong-pointer', 'missing-goal', 'finished', 'replaced'])('rejects stale/inactive context %s without writes', async (state) => {
  const { deps, store, writes } = setup();
  if (state === 'missing-user') delete store.user;
  else if (state === 'wrong-pointer') store.user.activeGoalId = 'different';
  else if (state === 'missing-goal') delete store.old;
  else store.old.status = state;
  await expect(replaceGoal(deps, params)).rejects.toBeInstanceOf(GoalReplacementConflictError);
  expect(writes).toEqual([]);
});
it('rejects a repeated replacement after the first commit', async () => {
  const { deps, store, writes } = setup();
  await replaceGoal(deps, params); writes.length = 0;
  await expect(replaceGoal(deps, params)).rejects.toBeInstanceOf(GoalReplacementConflictError);
  expect(Object.keys(store)).toHaveLength(3);
  expect(writes).toEqual([]);
});
it('rejects invalid draft/ids before writes', async () => {
  const { deps } = setup();
  await expect(replaceGoal(deps, { ...params, draft: { ...draft, targetHoursText: '0' } })).rejects.toBeInstanceOf(RangeError);
  await expect(replaceGoal(deps, { ...params, expectedGoalId: '' })).rejects.toBeInstanceOf(RangeError);
  expect(deps.runTransaction).not.toHaveBeenCalled();
});
it.each(['permission-denied', 'firestore/permission-denied', 'unavailable'])('propagates commit failure %s without clearing inputs or partial state', async (code) => {
  const { deps, store } = setup();
  const error = Object.assign(new Error('failed'), { code });
  deps.runTransaction = async () => { throw error; };
  await expect(replaceGoal(deps, params)).rejects.toBeInstanceOf(code.includes('permission-denied') ? GoalRejectedByServerError : Error);
  expect(store).toEqual({ user, old });
});
