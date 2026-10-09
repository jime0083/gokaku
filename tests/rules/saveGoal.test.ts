// saveGoal(src/features/goals/saveGoal.ts)の保存処理を、Emulator 上の実際の Firestore ルールに対して確認する。
// @react-native-firebase/firestore(ネイティブ SDK)は Jest から直接呼べないため、
// SaveGoalFirestoreDeps(doc/collection/runTransaction の modular API の形)を firebase/firestore(JS SDK)で満たし、
// Emulator(本人のルールが有効な認証済みコンテキスト)に対して本番と同じ saveGoal() 関数を実行する。
// これにより「保存処理の分岐(既存の目標がある場合 等)」と「ルールが保存データを許可すること」を同時に確認する
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, runTransaction, setDoc, setLogLevel } from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';

import { INITIAL_ONBOARDING_DRAFT, OTHER_CERTIFICATION_ID, type OnboardingDraft } from '../../src/features/onboarding/types';
import {
  ActiveGoalAlreadyExistsError,
  GoalRejectedByServerError,
  saveGoal,
  type SaveGoalDeps,
} from '../../src/features/goals/saveGoal';

const PROJECT_ID = `demo-gokaku-savegoal-${process.pid}-${Date.now()}`;
const OWNER_UID = 'owner-uid';

// ルール(firestore.rules)は startDate がサーバー(request.time)の日本時間の「今日」と一致することを要求する(problem P-021)。
// buildGoalDocument は params.now から startDate を計算するため、テストでも常に実行時点の現在時刻を使う
// (固定の過去・未来日付だと、本番の request.time と食い違って全て拒否されてしまう)。
// examDate はその30日後(閏日や月末の日数差を気にしなくてよい十分な余裕を持たせる)
function registerDateNow(): number {
  return Date.now();
}

function examDateAfter(now: number): string {
  return addDays(toJstDateKey(now), 30);
}

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  setLogLevel('error');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // users/{uid} ドキュメント自体の作成は 3-5b(Sign in with Apple でのユーザー作成)の責務であり、
  // このルールは update のみを許可する(3-5c-1 の対象は既存ユーザーへの activeGoalId 設定)。
  // そのため、3-5b が作成済みの状態を bypass で再現してから各テストを実行する
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', OWNER_UID), { createdAt: 0 });
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
    await testEnv.cleanup();
  }
});

type FirestoreRef = { kind: 'user' | 'goal'; firestoreRef: ReturnType<typeof doc> };

/**
 * firebase/firestore(JS SDK)で SaveGoalFirestoreDeps を満たす(本番は @react-native-firebase/firestore で満たす。goalFirestoreDeps.ts)。
 * authUid で認証した Emulator のコンテキストを使う(ルールの isOwner は実際にこの uid で判定される)。
 * firestore インスタンスは関数内で直接 doc/collection/runTransaction に渡す(型引数越しに渡すと
 * @firebase/rules-unit-testing の戻り値の型(compat)と firebase/firestore の modular 型の
 * 構造的な食い違いで型エラーになるため、変数を経由させるだけに留める)
 */
function createDeps(authUid: string, clearOnboardingDraft: () => Promise<void>): SaveGoalDeps<FirestoreRef> {
  const firestore = testEnv.authenticatedContext(authUid).firestore();

  return {
    getUserDocRef: (uid) => ({ kind: 'user', firestoreRef: doc(firestore, 'users', uid) }),
    createGoalDocRef: (uid) => {
      const ref = doc(collection(firestore, 'users', uid, 'goals'));
      return { ref: { kind: 'goal', firestoreRef: ref }, id: ref.id };
    },
    runTransaction: (updateFunction) =>
      runTransaction(firestore, (transaction) =>
        updateFunction({
          get: async (ref) => {
            const snapshot = await transaction.get(ref.firestoreRef);
            return { exists: () => snapshot.exists(), data: () => snapshot.data() };
          },
          set: (ref, data, options) =>
            options
              ? transaction.set(ref.firestoreRef, data, options)
              : transaction.set(ref.firestoreRef, data),
        }),
      ),
    clearOnboardingDraft,
  };
}

const examDraft = (examDate: string, overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  type: 'exam',
  university: '合格大学',
  targetDeviationText: '60.0',
  currentDeviationText: '50.0',
  subjectCount: 3,
  targetHoursText: '1800',
  autoFilledTargetHoursText: '1800',
  examDate,
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
  ...overrides,
});

const certDraft = (examDate: string, overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  type: 'cert',
  certId: 'it-passport',
  targetHoursText: '100',
  autoFilledTargetHoursText: '100',
  examDate,
  minDailyMinutes: 30,
  goalDailyMinutes: 60,
  ...overrides,
});

describe('saveGoal(Emulator・実際のルールに対して実行)', () => {
  it('受験: 新規ユーザーの保存に成功し、goal 作成・activeGoalId 設定・一時保存の削除が行われる', async () => {
    const firestore = testEnv.authenticatedContext(OWNER_UID).firestore();
    let clearedCount = 0;
    const deps = createDeps(OWNER_UID, async () => {
      clearedCount += 1;
    });

    const now = registerDateNow();
    const result = await saveGoal(deps, { uid: OWNER_UID, draft: examDraft(examDateAfter(now)), now });

    const goalSnapshot = await getDoc(doc(firestore, 'users', OWNER_UID, 'goals', result.goalId));
    expect(goalSnapshot.exists()).toBe(true);
    expect(goalSnapshot.data()).toEqual(result.goal);

    const userSnapshot = await getDoc(doc(firestore, 'users', OWNER_UID));
    expect(userSnapshot.data()).toEqual({ createdAt: 0, activeGoalId: result.goalId });
    expect(clearedCount).toBe(1);
  });

  it('資格(一覧): 保存に成功する', async () => {
    const firestore = testEnv.authenticatedContext(OWNER_UID).firestore();
    const deps = createDeps(OWNER_UID, async () => {});

    const now = registerDateNow();
    const result = await saveGoal(deps, { uid: OWNER_UID, draft: certDraft(examDateAfter(now)), now });

    const goalSnapshot = await getDoc(doc(firestore, 'users', OWNER_UID, 'goals', result.goalId));
    expect(goalSnapshot.data()).toEqual(
      expect.objectContaining({ type: 'cert', certId: 'it-passport' }),
    );
  });

  it('資格(その他): 保存に成功する', async () => {
    const firestore = testEnv.authenticatedContext(OWNER_UID).firestore();
    const deps = createDeps(OWNER_UID, async () => {});

    const now = registerDateNow();
    const result = await saveGoal(deps, {
      uid: OWNER_UID,
      draft: certDraft(examDateAfter(now), { certId: OTHER_CERTIFICATION_ID, certOtherName: '自作資格' }),
      now,
    });

    const goalSnapshot = await getDoc(doc(firestore, 'users', OWNER_UID, 'goals', result.goalId));
    expect(goalSnapshot.data()).toEqual(
      expect.objectContaining({
        type: 'cert',
        certId: OTHER_CERTIFICATION_ID,
        certOtherName: '自作資格',
        estimatedHours: null,
      }),
    );
  });

  it('既に有効な目標がある場合は ActiveGoalAlreadyExistsError になり、goal を作成しない', async () => {
    // 3-5b(ユーザー作成)が既に activeGoalId を設定済みの状態を bypass で用意する
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID), { activeGoalId: 'existing-goal' });
    });
    let clearedCount = 0;
    const deps = createDeps(OWNER_UID, async () => {
      clearedCount += 1;
    });

    const now = registerDateNow();
    await expect(
      saveGoal(deps, { uid: OWNER_UID, draft: examDraft(examDateAfter(now)), now }),
    ).rejects.toBeInstanceOf(ActiveGoalAlreadyExistsError);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const goalsSnapshot = await getDoc(doc(context.firestore(), 'users', OWNER_UID, 'goals', 'exam-goal'));
      expect(goalsSnapshot.exists()).toBe(false);
    });
    expect(clearedCount).toBe(0);
  });

  it('他人の uid で保存しようとするとルールに拒否され、goal も users も書き込まれない', async () => {
    // 認証済みだが本人ではないコンテキスト(isOwner が false になる状況)から OWNER_UID 宛に保存しようとする
    const deps = createDeps('attacker-uid', async () => {});

    const now = registerDateNow();
    await expect(
      saveGoal(deps, { uid: OWNER_UID, draft: examDraft(examDateAfter(now)), now }),
    ).rejects.toThrow();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      // beforeEach で用意した 3-5b 相当の初期ドキュメントから変化していないこと(activeGoalId が追加されていない)
      const userSnapshot = await getDoc(doc(context.firestore(), 'users', OWNER_UID));
      expect(userSnapshot.data()).toEqual({ createdAt: 0 });
    });
  });

  it('端末の時計がサーバーとずれていると GoalRejectedByServerError になり、goal も users も書き込まれない(problem P-021)', async () => {
    // 端末の時計が10日進んでいる状況を再現する: buildGoalDocument が計算する startDate(now 基準)が
    // サーバー(request.time)の日本時間の今日と一致しなくなり、ルールに拒否される
    let clearedCount = 0;
    const deps = createDeps(OWNER_UID, async () => {
      clearedCount += 1;
    });

    const skewedNow = Date.now() + 10 * 24 * 60 * 60 * 1000;
    await expect(
      saveGoal(deps, { uid: OWNER_UID, draft: examDraft(examDateAfter(skewedNow)), now: skewedNow }),
    ).rejects.toBeInstanceOf(GoalRejectedByServerError);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const userSnapshot = await getDoc(doc(context.firestore(), 'users', OWNER_UID));
      expect(userSnapshot.data()).toEqual({ createdAt: 0 });
    });
    expect(clearedCount).toBe(0);
  });
});
