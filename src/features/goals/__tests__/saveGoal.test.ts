import { addDays, jstStartOfDay } from '@shared/index';

import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from '../../onboarding/types';
import { ActiveGoalAlreadyExistsError, saveGoal, type SaveGoalDeps } from '../saveGoal';

const REGISTER_DATE = '2027-01-01';
const NOW = jstStartOfDay(REGISTER_DATE) + 1000;
const EXAM_DATE = addDays(REGISTER_DATE, 30);
const UID = 'uid-1';

const examDraft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  type: 'exam',
  university: '合格大学',
  targetDeviationText: '60.0',
  currentDeviationText: '50.0',
  subjectCount: 3,
  targetHoursText: '1800',
  autoFilledTargetHoursText: '1800',
  examDate: EXAM_DATE,
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
  ...overrides,
});

/**
 * Firestore の最小限の振る舞い(get/set・トランザクションの全成功/全失敗)を再現するフェイク。
 * runTransaction は updateFunction が例外を投げた場合、バッファした書き込みを一切 store に反映しない
 * (「途中で失敗して goals だけ残る状態を作らない」ことを saveGoal の実装に依存せず確かめるため)
 */
function createFakeDeps(
  initialUsers: Record<string, Record<string, unknown>> = {},
  options: { failSetFor?: 'user' | 'goal' } = {},
): SaveGoalDeps<{ kind: 'user' | 'goal'; uid: string; id: string }> & {
  readonly users: Record<string, Record<string, unknown>>;
  readonly goals: Record<string, Record<string, unknown>>;
  clearOnboardingDraftCallCount: number;
} {
  const users: Record<string, Record<string, unknown>> = { ...initialUsers };
  const goals: Record<string, Record<string, unknown>> = {};
  let nextGoalId = 1;
  let clearOnboardingDraftCallCount = 0;

  return {
    users,
    goals,
    get clearOnboardingDraftCallCount() {
      return clearOnboardingDraftCallCount;
    },
    getUserDocRef: (uid) => ({ kind: 'user', uid, id: uid }),
    createGoalDocRef: (uid) => {
      const id = `goal-${nextGoalId}`;
      nextGoalId += 1;
      return { ref: { kind: 'goal', uid, id }, id };
    },
    runTransaction: async (updateFunction) => {
      const staged: { store: Record<string, Record<string, unknown>>; key: string; data: Record<string, unknown> }[] =
        [];
      const result = await updateFunction({
        get: async (ref) => {
          const store = ref.kind === 'user' ? users : goals;
          const data = store[ref.id];
          return { exists: () => data !== undefined, data: () => data };
        },
        set: (ref, data, setOptions) => {
          if (options.failSetFor === ref.kind) {
            throw new Error(`simulated rules rejection on ${ref.kind} set`);
          }
          const store = ref.kind === 'user' ? users : goals;
          const existing = setOptions?.merge ? store[ref.id] : undefined;
          staged.push({ store, key: ref.id, data: { ...existing, ...data } });
        },
      });
      // 全て成功した場合のみ反映する(Firestore のトランザクションの原子性を再現)
      for (const { store, key, data } of staged) {
        store[key] = data;
      }
      return result;
    },
    clearOnboardingDraft: async () => {
      clearOnboardingDraftCallCount += 1;
    },
  };
}

describe('saveGoal', () => {
  it('新規ユーザーなら goal を作成し、users.activeGoalId を設定し、一時保存を消す', async () => {
    const deps = createFakeDeps();

    const result = await saveGoal(deps, { uid: UID, draft: examDraft(), now: NOW });

    expect(deps.goals[result.goalId]).toEqual(result.goal);
    expect(deps.users[UID]).toEqual({ activeGoalId: result.goalId });
    expect(deps.clearOnboardingDraftCallCount).toBe(1);
  });

  it('users ドキュメントが存在しない(未作成)場合も新規ユーザーとして保存できる', async () => {
    const deps = createFakeDeps({});

    const result = await saveGoal(deps, { uid: UID, draft: examDraft(), now: NOW });

    expect(deps.users[UID]?.activeGoalId).toBe(result.goalId);
  });

  it('既に有効な目標がある場合は ActiveGoalAlreadyExistsError を投げ、何も書き込まず一時保存も消さない', async () => {
    const deps = createFakeDeps({ [UID]: { activeGoalId: 'existing-goal' } });

    await expect(saveGoal(deps, { uid: UID, draft: examDraft(), now: NOW })).rejects.toBeInstanceOf(
      ActiveGoalAlreadyExistsError,
    );

    expect(Object.keys(deps.goals)).toHaveLength(0);
    expect(deps.users[UID]).toEqual({ activeGoalId: 'existing-goal' });
    expect(deps.clearOnboardingDraftCallCount).toBe(0);
  });

  it('draft が不正な場合は Firestore に触れずに RangeError を投げる', async () => {
    const deps = createFakeDeps();

    await expect(
      saveGoal(deps, { uid: UID, draft: examDraft({ examDate: null }), now: NOW }),
    ).rejects.toThrow(RangeError);

    expect(Object.keys(deps.goals)).toHaveLength(0);
    expect(deps.users[UID]).toBeUndefined();
    expect(deps.clearOnboardingDraftCallCount).toBe(0);
  });

  it('トランザクションの途中で失敗した場合、goal だけが残る状態にならない(goal への set は成功した後に users への set が失敗する例)', async () => {
    const deps = createFakeDeps({}, { failSetFor: 'user' });

    await expect(
      saveGoal(deps, { uid: UID, draft: examDraft(), now: NOW }),
    ).rejects.toThrow('simulated rules rejection on user set');

    // goal への set(1回目)は呼ばれた後に例外が起きるが、バッファした書き込みは一切 store に反映されない
    expect(Object.keys(deps.goals)).toHaveLength(0);
    expect(deps.users[UID]).toBeUndefined();
    expect(deps.clearOnboardingDraftCallCount).toBe(0);
  });
});


// 7-2-C: 初期化済みユーザーの初回登録。
class HistoryTestTimestamp {
  constructor(readonly seconds: number, readonly nanoseconds = 0) {}
}

function historyMetadata() {
  return {
    judgementHistoryStartedAt: new HistoryTestTimestamp(1),
    judgementRevisions: { goal: 1, settings: 2, xLink: 3, subscription: 4 },
  };
}

function historyDeps(
  user: Record<string, unknown>,
  options: { failPath?: string; retry?: boolean } = {},
) {
  const store = new Map<string, Record<string, unknown>>([['user', user]]);
  const stamp = { serverTimestamp: true };
  const createGoalDocRef = jest.fn(() => ({ ref: 'goal', id: 'goal' }));
  const clearOnboardingDraft = jest.fn(async () => {});
  const history = {
    isTimestamp: (value: unknown) => value instanceof HistoryTestTimestamp,
    getEntryDocRef: jest.fn((uid: string, revision: number) =>
      `users/${uid}/judgementHistory/goal/entries/${revision}`),
    serverTimestamp: jest.fn(() => stamp),
  };
  const base: SaveGoalDeps<string> = {
    getUserDocRef: () => 'user',
    createGoalDocRef,
    clearOnboardingDraft,
    runTransaction: async (body) => {
      const attempt = async (commit: boolean) => {
        const pending: [string, Record<string, unknown>][] = [];
        const result = await body({
          get: async (ref) => ({
            exists: () => store.has(ref),
            data: () => store.get(ref),
          }),
          set: (ref, data, setOptions) => {
            if (ref === options.failPath) throw new Error('write rejected');
            pending.push([ref, {
              ...(setOptions?.merge ? store.get(ref) : {}),
              ...data,
            }]);
          },
        });
        if (commit) pending.forEach(([ref, data]) => store.set(ref, data));
        return result;
      };
      if (options.retry) await attempt(false);
      return attempt(true);
    },
  };
  return {
    deps: Object.assign(base, { history }),
    store, stamp, createGoalDocRef, clearOnboardingDraft,
  };
}

describe('saveGoal judgement history: initial registration', () => {
  it('goal・pointer・counter・最小entryを同じtransactionで保存する', async () => {
    const metadata = historyMetadata();
    const f = historyDeps(metadata);
    const result = await saveGoal(f.deps, { uid: UID, draft: examDraft(), now: NOW });
    const entryPath = `users/${UID}/judgementHistory/goal/entries/2`;
    expect(f.store.size).toBe(3);
    expect(f.store.get('goal')).toEqual(result.goal);
    expect(f.store.get('user')).toEqual({
      ...metadata,
      activeGoalId: result.goalId,
      judgementRevisions: { goal: 2, settings: 2, xLink: 3, subscription: 4 },
    });
    expect(f.store.get(entryPath)).toEqual({
      schemaVersion: 1,
      revision: 2,
      committedAt: f.stamp,
      before: null,
      after: {
        goalId: result.goalId,
        startDate: result.goal.startDate,
        examDate: result.goal.examDate,
        minDailyMinutes: result.goal.minDailyMinutes,
        goalDailyMinutes: result.goal.goalDailyMinutes,
      },
    });
    expect(f.clearOnboardingDraft).toHaveBeenCalledTimes(1);
  });

  it('transaction retryでもgoal IDを作り直さない', async () => {
    const f = historyDeps(historyMetadata(), { retry: true });
    await saveGoal(f.deps, { uid: UID, draft: examDraft(), now: NOW });
    expect(f.createGoalDocRef).toHaveBeenCalledTimes(1);
    expect(f.store.size).toBe(3);
    expect(f.clearOnboardingDraft).toHaveBeenCalledTimes(1);
  });

  it('initializedなのにhistory depsがなければ何も保存しない', async () => {
    const f = historyDeps(historyMetadata());
    const { history: omitted, ...deps } = f.deps;
    expect(omitted).toBeDefined();
    await expect(saveGoal(deps, {
      uid: UID, draft: examDraft(), now: NOW,
    })).rejects.toThrow();
    expect(f.store.size).toBe(1);
    expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
  });

  const malformed: Record<string, unknown>[] = [
    { judgementHistoryStartedAt: new HistoryTestTimestamp(1) },
    { judgementRevisions: historyMetadata().judgementRevisions },
    { ...historyMetadata(), judgementHistoryStartedAt: null },
    { ...historyMetadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
    { ...historyMetadata(), judgementRevisions: null },
    { ...historyMetadata(), judgementRevisions: { goal: 1, settings: 1, xLink: 1 } },
    ...[0, -1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1].map((goal) => ({
      ...historyMetadata(),
      judgementRevisions: { ...historyMetadata().judgementRevisions, goal },
    })),
    {
      ...historyMetadata(),
      judgementRevisions: {
        ...historyMetadata().judgementRevisions,
        subscription: 0,
      },
    },
  ];

  it.each(malformed)('部分metadata/型不正をlegacyへ落とさない: %#', async (user) => {
    const f = historyDeps(user);
    await expect(saveGoal(f.deps, {
      uid: UID, draft: examDraft(), now: NOW,
    })).rejects.toThrow();
    expect(f.store.size).toBe(1);
    expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
  });

  it('goal counterのsafe integer overflowを拒否する', async () => {
    const metadata = historyMetadata();
    metadata.judgementRevisions.goal = Number.MAX_SAFE_INTEGER;
    const f = historyDeps(metadata);
    await expect(saveGoal(f.deps, {
      uid: UID, draft: examDraft(), now: NOW,
    })).rejects.toThrow();
    expect(f.store.size).toBe(1);
    expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
  });

  it.each(['', false, 0])('initializedの不正な旧pointerを拒否する: %p', async (activeGoalId) => {
    const f = historyDeps({ ...historyMetadata(), activeGoalId });
    await expect(saveGoal(f.deps, {
      uid: UID, draft: examDraft(), now: NOW,
    })).rejects.toThrow();
    expect(f.store.size).toBe(1);
    expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
  });

  it('initializedでも既存activeGoalのguardを維持する', async () => {
    const f = historyDeps({ ...historyMetadata(), activeGoalId: 'existing' });
    await expect(saveGoal(f.deps, {
      uid: UID, draft: examDraft(), now: NOW,
    })).rejects.toBeInstanceOf(ActiveGoalAlreadyExistsError);
    expect(f.store.size).toBe(1);
    expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
  });

  it.each(['goal', 'user', `users/${UID}/judgementHistory/goal/entries/2`])(
    '%s書込失敗で全書込を破棄しdraftを保持する',
    async (failPath) => {
      const f = historyDeps(historyMetadata(), { failPath });
      await expect(saveGoal(f.deps, {
        uid: UID, draft: examDraft(), now: NOW,
      })).rejects.toThrow('write rejected');
      expect(f.store.size).toBe(1);
      expect(f.clearOnboardingDraft).not.toHaveBeenCalled();
    },
  );

  it('両metadata absentならhistory depsがあってもlegacy動作を維持する', async () => {
    const f = historyDeps({ createdAt: 0 });
    await saveGoal(f.deps, { uid: UID, draft: examDraft(), now: NOW });
    expect(f.store.size).toBe(2);
    expect(f.deps.history.getEntryDocRef).not.toHaveBeenCalled();
    expect(f.deps.history.serverTimestamp).not.toHaveBeenCalled();
    expect(f.store.get('user')).toEqual({ createdAt: 0, activeGoalId: 'goal' });
  });
});
