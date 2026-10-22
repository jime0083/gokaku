import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp, collection, deleteDoc, doc, getDoc, runTransaction,
  serverTimestamp, setDoc, setLogLevel, updateDoc, writeBatch,
} from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';
import { buildGoalDocument } from '../../src/features/goals/buildGoalDocument';
import { saveGoal, type SaveGoalDeps } from '../../src/features/goals/saveGoal';
import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from '../../src/features/onboarding/types';

const PROJECT_ID = `demo-gokaku-goalhistory-${process.pid}-${Date.now()}`;
const UID = 'history-owner';
const GOAL = 'initial-goal';
let env: RulesTestEnvironment;

function metadata(): Record<string, unknown> {
  return {
    judgementHistoryStartedAt: Timestamp.fromMillis(Date.now() - 1000),
    judgementRevisions: { goal: 1, settings: 2, xLink: 3, subscription: 4 },
  };
}

function draft(now: number, type: 'exam' | 'cert' = 'cert'): OnboardingDraft {
  return {
    ...INITIAL_ONBOARDING_DRAFT,
    type,
    certId: 'it-passport',
    university: '合格大学',
    targetDeviationText: '60.0',
    currentDeviationText: '50.0',
    subjectCount: 3,
    targetHoursText: '100',
    autoFilledTargetHoursText: '100',
    examDate: addDays(toJstDateKey(now), 30),
    minDailyMinutes: 30,
    goalDailyMinutes: 60,
  };
}

function snapshot(goalId: string, goal: ReturnType<typeof buildGoalDocument>) {
  return {
    goalId, startDate: goal.startDate, examDate: goal.examDate,
    minDailyMinutes: goal.minDailyMinutes, goalDailyMinutes: goal.goalDailyMinutes,
  };
}

function ownerDb(auth: 'owner' | 'other' | 'none' = 'owner') {
  return auth === 'none'
    ? env.unauthenticatedContext().firestore()
    : env.authenticatedContext(auth === 'owner' ? UID : 'other').firestore();
}

async function seed(user: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', UID), user);
  });
}

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});

afterEach(async () => {
  await env.clearFirestore();
});

afterAll(async () => {
  if (env) {
    try { await env.clearFirestore(); } finally { await env.cleanup(); }
  }
});

type Attempt = {
  auth?: 'owner' | 'other' | 'none';
  entry?: boolean;
  goal?: boolean;
  pointer?: boolean;
  entryId?: string;
  stream?: string;
  userPatch?: Record<string, unknown>;
  entryPatch?: Record<string, unknown>;
};

async function commitAttempt(options: Attempt = {}) {
  const db = ownerDb(options.auth);
  const goal = buildGoalDocument(draft(Date.now()), Date.now());
  const batch = writeBatch(db);
  if (options.goal !== false) {
    batch.set(doc(db, 'users', UID, 'goals', GOAL), goal);
  }
  if (options.pointer !== false) {
    batch.update(doc(db, 'users', UID), {
      activeGoalId: GOAL,
      judgementRevisions: { goal: 2, settings: 2, xLink: 3, subscription: 4 },
      ...options.userPatch,
    });
  }
  if (options.entry !== false) {
    batch.set(doc(db, 'users', UID, 'judgementHistory',
      options.stream ?? 'goal', 'entries', options.entryId ?? '2'), {
      schemaVersion: 1,
      revision: 2,
      committedAt: serverTimestamp(),
      before: null,
      after: snapshot(GOAL, goal),
      ...options.entryPatch,
    });
  }
  return batch.commit();
}

describe('7-2-C initial goal history rules', () => {
  it.each(['exam', 'cert'] as const)('saveGoal %sを実transactionで保存する', async (type) => {
    const initial = metadata();
    await seed(initial);
    const db = ownerDb();
    const clearOnboardingDraft = jest.fn(async () => {});
    type Ref = ReturnType<typeof doc>;
    const base: SaveGoalDeps<Ref> = {
      getUserDocRef: (uid) => doc(db, 'users', uid),
      createGoalDocRef: (uid) => {
        const ref = doc(collection(db, 'users', uid, 'goals'));
        return { ref, id: ref.id };
      },
      runTransaction: (body) => runTransaction(db, (tx) => body({
        get: (ref) => tx.get(ref),
        set: (ref, data, options) =>
          options ? tx.set(ref, data, options) : tx.set(ref, data),
      })),
      clearOnboardingDraft,
    };
    const deps = Object.assign(base, {
      history: {
        isTimestamp: (value: unknown) => value instanceof Timestamp,
        getEntryDocRef: (uid: string, revision: number) =>
          doc(db, 'users', uid, 'judgementHistory', 'goal', 'entries', String(revision)),
        serverTimestamp,
      },
    });
    const now = Date.now();
    const result = await saveGoal(deps, { uid: UID, draft: draft(now, type), now });
    const user = (await getDoc(doc(db, 'users', UID))).data();
    const entry = (await getDoc(doc(
      db, 'users', UID, 'judgementHistory', 'goal', 'entries', '2',
    ))).data();
    expect(user).toEqual({
      ...initial,
      activeGoalId: result.goalId,
      judgementRevisions: { goal: 2, settings: 2, xLink: 3, subscription: 4 },
    });
    expect(entry).toEqual({
      schemaVersion: 1, revision: 2,
      committedAt: expect.any(Timestamp),
      before: null, after: snapshot(result.goalId, result.goal),
    });
    expect((await getDoc(doc(db, 'users', UID, 'goals', result.goalId))).data())
      .toEqual(result.goal);
    expect(clearOnboardingDraft).toHaveBeenCalledTimes(1);
  });

  it('3書込の正常batchがdocument access制限内で成功する', async () => {
    await seed(metadata());
    await expect(commitAttempt()).resolves.toBeUndefined();
  });

  const invalid: [string, Attempt][] = [
    ['履歴省略', { entry: false }],
    ['goal省略', { goal: false }],
    ['pointer省略', { pointer: false }],
    ['他人', { auth: 'other' }],
    ['未認証', { auth: 'none' }],
    ['ID不一致', { entryId: '3' }],
    ['ID非正規表現', { entryId: '02' }],
    ['revision飛越', { entryPatch: { revision: 3 } }],
    ['revision巻戻し', { entryPatch: { revision: 1 } }],
    ['revision文字列', { entryPatch: { revision: '2' } }],
    ['schema偽造', { entryPatch: { schemaVersion: 2 } }],
    ['timestamp偽造', { entryPatch: { committedAt: Timestamp.fromMillis(0) } }],
    ['before偽造', { entryPatch: { before: {} } }],
    ['after欠損', { entryPatch: { after: null } }],
    ['余計なentry field', { entryPatch: { secret: 'unexpected' } }],
    ['他stream', { stream: 'settings' }],
    ['他stream xLink', { stream: 'xLink' }],
    ['他stream subscription', { stream: 'subscription' }],
    ['counter巻戻し', { userPatch: {
      judgementRevisions: { goal: 1, settings: 2, xLink: 3, subscription: 4 },
    } }],
    ['counter飛越', { userPatch: {
      judgementRevisions: { goal: 3, settings: 2, xLink: 3, subscription: 4 },
    } }],
    ['他counter変更', { userPatch: {
      judgementRevisions: { goal: 2, settings: 3, xLink: 3, subscription: 4 },
    } }],
    ['startedAt変更', { userPatch: {
      judgementHistoryStartedAt: Timestamp.fromMillis(0),
    } }],
  ];

  it.each(invalid)('%sを拒否し元データを変更しない', async (_label, options) => {
    const initial = metadata();
    await seed(initial);
    await expect(commitAttempt(options)).rejects.toThrow();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      expect((await getDoc(doc(db, 'users', UID))).data()).toEqual(initial);
      expect((await getDoc(doc(db, 'users', UID, 'goals', GOAL))).exists()).toBe(false);
      expect((await getDoc(doc(db, 'users', UID, 'judgementHistory',
        options.stream ?? 'goal', 'entries', options.entryId ?? '2'))).exists()).toBe(false);
    });
  });

  it.each(['goalId', 'startDate', 'examDate', 'minDailyMinutes', 'goalDailyMinutes'])(
    'after.%sを元goalと照合する',
    async (field) => {
      await seed(metadata());
      const goal = buildGoalDocument(draft(Date.now()), Date.now());
      await expect(commitAttempt({
        entryPatch: { after: { ...snapshot(GOAL, goal), [field]: 'forged' } },
      })).rejects.toThrow();
    },
  );

  it('afterの余計なfieldを拒否する', async () => {
    await seed(metadata());
    const goal = buildGoalDocument(draft(Date.now()), Date.now());
    await expect(commitAttempt({
      entryPatch: { after: { ...snapshot(GOAL, goal), targetHours: goal.targetHours } },
    })).rejects.toThrow();
  });

  const badUsers: Record<string, unknown>[] = [
    { judgementHistoryStartedAt: Timestamp.fromMillis(0) },
    { judgementRevisions: { goal: 1, settings: 2, xLink: 3, subscription: 4 } },
    { ...metadata(), judgementHistoryStartedAt: null },
    { ...metadata(), judgementHistoryStartedAt: { seconds: 0, nanoseconds: 0 } },
    { ...metadata(), judgementRevisions: null },
    { ...metadata(), judgementRevisions: { goal: 1, settings: 2, xLink: 3 } },
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((goal) => ({
      ...metadata(), judgementRevisions: { goal, settings: 2, xLink: 3, subscription: 4 },
    })),
    { ...metadata(), judgementRevisions: {
      goal: 1, settings: 2, xLink: 0, subscription: 4,
    } },
  ];

  it.each(badUsers)('部分/不正metadataでlegacy保存も履歴保存も拒否: %#', async (user) => {
    await seed(user);
    await expect(commitAttempt()).rejects.toThrow();
    const db = ownerDb();
    const goal = buildGoalDocument(draft(Date.now()), Date.now());
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', UID, 'goals', GOAL), goal);
    batch.update(doc(db, 'users', UID), { activeGoalId: GOAL });
    await expect(batch.commit()).rejects.toThrow();
  });

  it('legacy初回登録は従来の2書込で成功し履歴を作らない', async () => {
    await seed({ createdAt: 0 });
    const db = ownerDb();
    const goal = buildGoalDocument(draft(Date.now()), Date.now());
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', UID, 'goals', GOAL), goal);
    batch.update(doc(db, 'users', UID), { activeGoalId: GOAL });
    await expect(batch.commit()).resolves.toBeUndefined();
    expect((await getDoc(doc(db, 'users', UID, 'judgementHistory',
      'goal', 'entries', '2'))).exists()).toBe(false);
  });

  it('legacyユーザーの履歴書込を拒否する', async () => {
    await seed({ createdAt: 0 });
    await expect(commitAttempt()).rejects.toThrow();
  });

  it.each(['deleting', 'missing'] as const)('%s親への保存を拒否する', async (state) => {
    if (state === 'deleting') await seed({ ...metadata(), deletionInProgress: true });
    await expect(commitAttempt()).rejects.toThrow();
  });

  it.each(['update', 'delete'] as const)('既存entryの%sを拒否する', async (operation) => {
    await seed(metadata());
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', UID, 'judgementHistory',
        'goal', 'entries', '1'), {
        schemaVersion: 1, revision: 1,
        committedAt: Timestamp.fromMillis(0), before: null, after: null,
      });
    });
    const ref = doc(ownerDb(), 'users', UID, 'judgementHistory', 'goal', 'entries', '1');
    await expect(operation === 'update'
      ? updateDoc(ref, { committedAt: serverTimestamp() })
      : deleteDoc(ref)).rejects.toThrow();
  });
});
