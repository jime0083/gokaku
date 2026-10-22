import type { SaveGoalHistoryDeps } from '../saveGoal';
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


describe('7-2 replacement history persistence', () => {
  class HistoryTimestamp {
    seconds = 1;
    nanoseconds = 123;
  }
  const counters = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
  const metadata = () => ({
    judgementHistoryStartedAt: new HistoryTimestamp(),
    judgementRevisions: { ...counters },
  });
  const projection = (id: string, value: Record<string, unknown>) => ({
    goalId: id, startDate: value.startDate, examDate: value.examDate,
    minDailyMinutes: value.minDailyMinutes,
    goalDailyMinutes: value.goalDailyMinutes,
  });
  function initialized() {
    const base = setup();
    const deps: ReplaceGoalDeps<string> & {
      history?: SaveGoalHistoryDeps<string>;
    } = base.deps;
    deps.history = {
      isTimestamp: (value) => value instanceof HistoryTimestamp,
      getEntryDocRef: (uid, revision) => `${uid}/history/${revision}`,
      serverTimestamp: jest.fn(() => ({ serverTime: true })),
    };
    base.store.user = { ...base.store.user, ...metadata() };
    return { ...base, deps };
  }

  it('atomically saves old/new/pointer/counter/minimal history from current values', async () => {
    const { deps, store, writes } = initialized();
    store.old = { ...store.old, minDailyMinutes: 40, goalDailyMinutes: 80 };
    const before = { ...store.old };
    const beforeUser = { ...store.user };
    const result = await replaceGoal(deps, params);
    expect(writes).toHaveLength(4);
    expect([...writes].sort()).toEqual(
      ['old', 'new', 'user', 'owner/history/2'].sort(),
    );
    expect(store.old).toEqual({ ...before, status: 'replaced' });
    expect(store.new).toEqual(result.goal);
    expect(store.user).toEqual({
      ...beforeUser, activeGoalId: 'new',
      judgementRevisions: { ...counters, goal: 2 },
    });
    expect(store['owner/history/2']).toEqual({
      schemaVersion: 1, revision: 2, committedAt: { serverTime: true },
      before: projection('old', before),
      after: projection('new', result.goal),
    });
    expect(deps.history!.serverTimestamp).toHaveBeenCalledTimes(1);
    expect(result.goal).toEqual(buildGoalDocument(draft, now));
  });

  it('retry rereads old values/counter while keeping one new goal reference', async () => {
    const { deps, store } = initialized();
    const tx = {
      get: jest.fn(async (ref: string) => ({
        exists: () => !!store[ref], data: () => store[ref],
      })),
      set: jest.fn(),
      update: jest.fn(),
    };
    deps.runTransaction = async (body) => {
      await body(tx); // Discard first SDK attempt.
      store.user = {
        ...store.user, judgementRevisions: { ...counters, goal: 5 },
      };
      store.old = { ...store.old, minDailyMinutes: 50 };
      tx.get.mockClear(); tx.set.mockClear(); tx.update.mockClear();
      return body(tx);
    };
    const result = await replaceGoal(deps, params);
    expect(deps.createGoalDocRef).toHaveBeenCalledTimes(1);
    expect(tx.get.mock.calls.map(([ref]) => ref)).toEqual(['user', 'old']);
    expect(tx.set.mock.calls).toEqual([
      ['new', result.goal],
      ['owner/history/6', {
        schemaVersion: 1, revision: 6, committedAt: { serverTime: true },
        before: projection('old', store.old),
        after: projection('new', result.goal),
      }],
    ]);
    expect(tx.update).toHaveBeenCalledWith('user', {
      activeGoalId: 'new', judgementRevisions: { ...counters, goal: 6 },
    });
  });

  it.each([1, 2])('rejects UID switch after read %s without writes', async (at) => {
    const { deps, setUid, writes } = initialized();
    const run = deps.runTransaction;
    deps.runTransaction = (body) => run((tx) => {
      let reads = 0;
      return body({
        ...tx,
        get: async (ref) => {
          const result = await tx.get(ref);
          reads += 1;
          if (reads === at) setUid('other');
          return result;
        },
      });
    });
    await expect(replaceGoal(deps, params))
      .rejects.toBeInstanceOf(GoalReplacementAuthError);
    expect(writes).toEqual([]);
  });

  const malformed: Record<string, unknown>[] = [
    { judgementHistoryStartedAt: new HistoryTimestamp() },
    { judgementRevisions: counters },
    { ...metadata(), judgementHistoryStartedAt: null },
    { ...metadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
    { ...metadata(), judgementRevisions: null },
    { ...metadata(), judgementRevisions: [] },
    { ...metadata(), judgementRevisions: {} },
    ...(['goal', 'settings', 'xLink', 'subscription'] as const).flatMap((stream) =>
      [undefined, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
        .map((value) => ({
          ...metadata(), judgementRevisions: { ...counters, [stream]: value },
        }))),
    { ...metadata(), judgementRevisions: {
      ...counters, goal: Number.MAX_SAFE_INTEGER,
    } },
  ];
  it.each(malformed)('fails closed on malformed metadata %#', async (bad) => {
    const { deps, store, writes } = initialized();
    store.user = { ...user, ...bad };
    await expect(replaceGoal(deps, params)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('requires history dependencies only when metadata exists', async () => {
    const { deps, writes } = initialized();
    delete deps.history;
    await expect(replaceGoal(deps, params)).rejects.toThrow();
    expect(writes).toEqual([]);
    const legacy = setup();
    await expect(replaceGoal(legacy.deps, params)).resolves.toBeDefined();
  });

  it('rejects deletion in progress before writes', async () => {
    const { deps, store, writes } = initialized();
    store.user.deletionInProgress = true;
    await expect(replaceGoal(deps, params)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it.each(['startDate', 'examDate', 'minDailyMinutes', 'goalDailyMinutes'])(
    'rejects malformed current snapshot field %s before writes', async (field) => {
      const { deps, store, writes } = initialized();
      delete store.old[field];
      await expect(replaceGoal(deps, params)).rejects.toThrow();
      expect(writes).toEqual([]);
    },
  );

  it('commit failure leaves old/pointer unchanged and creates no goal/history', async () => {
    const { deps, store } = initialized();
    const before = { ...store };
    deps.runTransaction = async (body) => {
      await body({
        get: async (ref) => ({
          exists: () => !!store[ref], data: () => store[ref],
        }),
        set: jest.fn(), update: jest.fn(),
      });
      throw new Error('commit failed');
    };
    await expect(replaceGoal(deps, params)).rejects.toThrow('commit failed');
    expect(store).toEqual(before);
  });
});
