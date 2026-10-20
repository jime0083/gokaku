import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc, deleteField, doc, getDoc, setDoc, setLogLevel, updateDoc, writeBatch,
  type DocumentData,
} from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';

import { buildGoalDocument } from '../../src/features/goals/buildGoalDocument';
import { INITIAL_ONBOARDING_DRAFT } from '../../src/features/onboarding/types';

const UID = 'deletion-owner';
const OTHER_UID = 'other-owner';
const operations = [
  'settings', 'numeric', 'initial', 'replacement', 'probeCreate', 'probeUpdate', 'probeDelete',
] as const;
type Operation = typeof operations[number];
type ParentState = 'unset' | 'false' | 'deleting' | 'missing';

let env: RulesTestEnvironment;
const databases = new Map<string | null, ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>>();

function dbFor(auth: string | null = UID) {
  let db = databases.get(auth);
  if (!db) {
    db = (auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore();
    databases.set(auth, db);
  }
  return db;
}

function goal(now: number) {
  return buildGoalDocument({
    ...INITIAL_ONBOARDING_DRAFT,
    type: 'cert',
    certId: 'other',
    certOtherName: '資格',
    targetHoursText: '100',
    examDate: addDays(toJstDateKey(now), 30),
    minDailyMinutes: 30,
    goalDailyMinutes: 60,
  }, now);
}

async function seed(state: ParentState, operation: Operation = 'settings') {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const parent = doc(db, 'users', UID);
    if (state === 'missing') {
      await deleteDoc(parent);
    } else {
      await setDoc(parent, {
        createdAt: 1, checkEnabled: true, xPostEnabled: false,
        ...(operation === 'initial' ? {} : { activeGoalId: 'old' }),
        ...(state === 'unset' ? {} : { deletionInProgress: state === 'deleting' }),
      });
    }
    // 別の正常な親では、本人の削除中/missing状態を迂回できない。
    await setDoc(doc(db, 'users', OTHER_UID), { checkEnabled: true });
    if (operation !== 'initial') {
      await setDoc(doc(db, 'users', UID, 'goals', 'old'), goal(Date.now()));
    }
    if (operation !== 'probeCreate') {
      await setDoc(doc(db, 'devProbe', UID), { checkedAt: 1 });
    }
  });
}

async function perform(operation: Operation, auth: string | null = UID) {
  const db = dbFor(auth);
  const parent = doc(db, 'users', UID);
  const old = doc(db, 'users', UID, 'goals', 'old');
  const probe = doc(db, 'devProbe', UID);
  switch (operation) {
    case 'settings':
      return updateDoc(parent, { checkEnabled: false, xPostEnabled: true });
    case 'numeric':
      return updateDoc(old, { targetHours: 200 });
    case 'probeCreate':
    case 'probeUpdate':
      return setDoc(probe, { checkedAt: 2 });
    case 'probeDelete':
      return deleteDoc(probe);
    case 'initial':
    case 'replacement': {
      const batch = writeBatch(db);
      if (operation === 'replacement') batch.update(old, { status: 'replaced' });
      batch.set(doc(db, 'users', UID, 'goals', 'new'), goal(Date.now()));
      batch.set(parent, { activeGoalId: 'new' }, { merge: true });
      return batch.commit();
    }
  }
}

async function snapshot(): Promise<(DocumentData | undefined)[]> {
  let result: (DocumentData | undefined)[] = [];
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const refs = [
      doc(db, 'users', UID), doc(db, 'users', OTHER_UID),
      doc(db, 'users', UID, 'goals', 'old'), doc(db, 'users', UID, 'goals', 'new'),
      doc(db, 'devProbe', UID),
    ];
    result = await Promise.all(refs.map(async (ref) => (await getDoc(ref)).data()));
  });
  return result;
}

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: `demo-gokaku-deletion-rules-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
beforeEach(async () => { await env.clearFirestore(); });
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => {
  if (env) {
    try {
      await env.clearFirestore();
    } finally {
      await env.cleanup();
    }
  }
});

describe.each<ParentState>(['unset', 'false'])('正常な本人親: %s', (state) => {
  it.each(operations)('%sの既存正常条件を維持する', async (operation) => {
    await seed(state, operation);
    await assertSucceeds(perform(operation));
    const [parent, , old, next, probe] = await snapshot();
    expect(parent?.deletionInProgress).toBe(state === 'false' ? false : undefined);
    if (operation === 'settings') {
      expect(parent).toEqual(expect.objectContaining({ checkEnabled: false, xPostEnabled: true }));
    } else if (operation === 'numeric') {
      expect(old?.targetHours).toBe(200);
    } else if (operation === 'initial' || operation === 'replacement') {
      expect(parent?.activeGoalId).toBe('new');
      expect(next?.status).toBe('active');
      if (operation === 'replacement') expect(old?.status).toBe('replaced');
    } else {
      expect(probe).toEqual(operation === 'probeDelete' ? undefined : { checkedAt: 2 });
    }
  });
});

describe.each<ParentState>(['deleting', 'missing'])('削除開始後の本人親: %s', (state) => {
  it.each(operations)('%sを拒否し部分書込・再作成しない', async (operation) => {
    await seed(state, operation);
    const before = await snapshot();
    await assertFails(perform(operation));
    expect(await snapshot()).toEqual(before);
  });

  it('親だけを再作成するset/mergeも拒否する', async () => {
    await seed(state);
    const parent = doc(dbFor(), 'users', UID);
    const before = await snapshot();
    await assertFails(setDoc(parent, { checkEnabled: false }));
    await assertFails(setDoc(parent, { checkEnabled: false }, { merge: true }));
    expect(await snapshot()).toEqual(before);
  });

  it('goal単独作成も拒否する', async () => {
    await seed(state);
    const before = await snapshot();
    await assertFails(setDoc(doc(dbFor(), 'users', UID, 'goals', 'new'), goal(Date.now())));
    expect(await snapshot()).toEqual(before);
  });

  it('本人の親・配下・devProbeの読み取り権限を維持する', async () => {
    await seed(state);
    const db = dbFor();
    await assertSucceeds(getDoc(doc(db, 'users', UID)));
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'goals', 'old')));
    await assertSucceeds(getDoc(doc(db, 'devProbe', UID)));
  });
});

describe('server専用marker', () => {
  const changes: { state: ParentState; value: unknown }[] = [
    { state: 'unset', value: true }, { state: 'unset', value: false },
    { state: 'unset', value: null }, { state: 'unset', value: 'true' },
    { state: 'false', value: true }, { state: 'false', value: null },
    { state: 'false', value: 'true' }, { state: 'false', value: deleteField() },
    { state: 'deleting', value: false }, { state: 'deleting', value: null },
    { state: 'deleting', value: 'true' }, { state: 'deleting', value: deleteField() },
  ];
  it.each(changes)('marker変更を設定更新と混ぜても拒否する: %p', async ({ state, value }) => {
    await seed(state);
    const before = await snapshot();
    await assertFails(updateDoc(doc(dbFor(), 'users', UID), {
      checkEnabled: false, deletionInProgress: value,
    }));
    expect(await snapshot()).toEqual(before);
  });

  it('marker削除と目標置換・devProbe書込を混ぜたbatchも全体を拒否する', async () => {
    await seed('deleting');
    const before = await snapshot();
    const db = dbFor();
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', UID), { activeGoalId: 'new', deletionInProgress: deleteField() });
    batch.update(doc(db, 'users', UID, 'goals', 'old'), { status: 'replaced' });
    batch.set(doc(db, 'users', UID, 'goals', 'new'), goal(Date.now()));
    batch.set(doc(db, 'devProbe', UID), { checkedAt: 2 });
    await assertFails(batch.commit());
    expect(await snapshot()).toEqual(before);
  });
});

describe.each([null, OTHER_UID])('本人以外: %s', (auth) => {
  it.each(operations)('%sを拒否する', async (operation) => {
    await seed('unset', operation);
    const before = await snapshot();
    await assertFails(perform(operation, auth));
    expect(await snapshot()).toEqual(before);
  });

  it('削除中も本人データを読めない', async () => {
    await seed('deleting');
    const db = dbFor(auth);
    for (const ref of [
      doc(db, 'users', UID), doc(db, 'users', UID, 'goals', 'old'), doc(db, 'devProbe', UID),
    ]) await assertFails(getDoc(ref));
  });
});
