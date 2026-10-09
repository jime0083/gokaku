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
