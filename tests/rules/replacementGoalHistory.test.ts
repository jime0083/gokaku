import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp, deleteDoc, doc, getDoc, runTransaction, serverTimestamp,
  setDoc, setLogLevel, updateDoc, writeBatch,
} from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';

const UID = 'replacement-history-owner';
const ID = 'current';
const revisions = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
let env: RulesTestEnvironment;
const metadata = () => ({
  judgementHistoryStartedAt: Timestamp.fromMillis(Date.now() - 1000),
  judgementRevisions: { ...revisions },
});
const makeGoal = (type: 'exam' | 'cert' = 'cert') => ({
  ...(type === 'cert'
    ? { type, certId: 'other', certOtherName: '資格', estimatedHours: null }
    : { type, university: '大学', targetDeviation: 60.1, currentDeviation: 50.1,
      subjectCount: 3, estimatedHours: { status: 'ok', lowerHours: 900, upperHours: 1500 } }),
  targetHours: 1000, createdAt: 1, status: 'active',
  startDate: addDays(toJstDateKey(Date.now()), -30),
  examDate: addDays(toJstDateKey(Date.now()), 30),
  minDailyMinutes: 60, goalDailyMinutes: 120,
});
const projection = (data: Record<string, unknown>, goalId = ID) => ({
  goalId, startDate: data.startDate, examDate: data.examDate,
  minDailyMinutes: data.minDailyMinutes, goalDailyMinutes: data.goalDailyMinutes,
});
const dbFor = (auth: string | null = UID) =>
  (auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore();
type Db = ReturnType<typeof dbFor>;
const userRef = (db: Db) => doc(db, 'users', UID);
const goalRef = (db: Db, id = ID) => doc(db, 'users', UID, 'goals', id);
const historyRef = (db: Db, id = '2', stream = 'goal') =>
  doc(db, 'users', UID, 'judgementHistory', stream, 'entries', id);

async function seed(
  extra: Record<string, unknown> = metadata(),
  goal = makeGoal(),
  exists = true,
) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    if (exists) await setDoc(userRef(db), {
      activeGoalId: ID, createdAt: 1, checkEnabled: true, xPostEnabled: true, ...extra,
    });
    await setDoc(goalRef(db), goal);
    await setDoc(goalRef(db, 'other'), { ...goal });
  });
}

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: `demo-gokaku-replacement-history-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => {
  if (env) {
    try { await env.clearFirestore(); } finally { await env.cleanup(); }
  }
});


const NEXT = 'fresh';
const nextGoal = (type: 'exam' | 'cert' = 'cert') => ({
  ...makeGoal(type), startDate: toJstDateKey(Date.now()), createdAt: 2,
});
type Attempt = {
  auth?: string | null;
  old?: boolean;
  next?: boolean;
  parent?: boolean;
  counter?: boolean;
  entry?: boolean;
  entryId?: string;
  stream?: string;
  oldPatch?: Record<string, unknown>;
  nextPatch?: Record<string, unknown>;
  userPatch?: Record<string, unknown>;
  entryPatch?: Record<string, unknown>;
  extraEntry?: boolean;
};
async function attempt(options: Attempt = {}) {
  const db = dbFor(options.auth);
  const next = { ...nextGoal(), ...options.nextPatch };
  const batch = writeBatch(db);
  if (options.old !== false) batch.update(goalRef(db), {
    status: 'replaced', ...options.oldPatch,
  });
  if (options.next !== false) batch.set(goalRef(db, NEXT), next);
  if (options.parent !== false) batch.update(userRef(db), {
    activeGoalId: NEXT,
    ...(options.counter === false ? {} : {
      judgementRevisions: { ...revisions, goal: 2 },
    }),
    ...options.userPatch,
  });
  const entry = {
    schemaVersion: 1, revision: 2, committedAt: serverTimestamp(),
    before: projection(makeGoal()), after: projection(next, NEXT),
    ...options.entryPatch,
  };
  if (options.entry !== false) {
    batch.set(historyRef(db, options.entryId, options.stream), entry);
  }
  if (options.extraEntry) batch.set(historyRef(db, '3'), {
    ...entry, revision: 3,
  });
  return batch.commit();
}

describe('7-2 replacement history rules', () => {
  it.each(['cert', 'exam'] as const)(
    'normal %s transaction stays within actual evaluation/access limits', async (type) => {
      const initial = metadata();
      const old = makeGoal(type);
      const next = nextGoal(type);
      await seed(initial, old);
      const db = dbFor();
      await runTransaction(db, async (tx) => {
        const user = (await tx.get(userRef(db))).data()!;
        const current = (await tx.get(goalRef(db))).data()!;
        tx.update(goalRef(db), { status: 'replaced' });
        tx.set(goalRef(db, NEXT), next);
        tx.update(userRef(db), {
          activeGoalId: NEXT,
          judgementRevisions: { ...user.judgementRevisions, goal: 2 },
        });
        tx.set(historyRef(db), {
          schemaVersion: 1, revision: 2, committedAt: serverTimestamp(),
          before: projection(current), after: projection(next, NEXT),
        });
      });
      expect((await getDoc(goalRef(db))).data()).toEqual({
        ...old, status: 'replaced',
      });
      expect((await getDoc(goalRef(db, NEXT))).data()).toEqual(next);
      expect((await getDoc(userRef(db))).data()).toEqual({
        activeGoalId: NEXT, createdAt: 1, checkEnabled: true, xPostEnabled: true,
        ...initial, judgementRevisions: { ...revisions, goal: 2 },
      });
      expect((await getDoc(historyRef(db))).data()).toEqual({
        schemaVersion: 1, revision: 2, committedAt: expect.any(Timestamp),
        before: projection(old), after: projection(next, NEXT),
      });
    },
  );

  it('normal four-document batch succeeds', async () => {
    await seed();
    await expect(attempt()).resolves.toBeUndefined();
  });

  const invalid: [string, Attempt][] = [
    ['missing entry', { entry: false }],
    ['missing parent', { parent: false }],
    ['missing old update', { old: false }],
    ['missing new goal', { next: false }],
    ['missing counter', { counter: false }],
    ['legacy three-write bypass', { counter: false, entry: false }],
    ['entry alone', { old: false, next: false, parent: false }],
    ['counter alone', {
      old: false, next: false, entry: false, userPatch: { activeGoalId: ID },
    }],
    ['old alone', { next: false, parent: false, entry: false }],
    ['new alone', { old: false, parent: false, entry: false }],
    ['other owner', { auth: 'other' }],
    ['unauthenticated', { auth: null }],
    ['noncanonical ID', { entryId: '02' }],
    ['wrong ID', { entryId: '3' }],
    ['extra entry', { extraEntry: true }],
    ['settings stream', { stream: 'settings' }],
    ['xLink stream', { stream: 'xLink' }],
    ['subscription stream', { stream: 'subscription' }],
    ['revision jump', { entryPatch: { revision: 3 } }],
    ['revision rewind', { entryPatch: { revision: 1 } }],
    ['revision string', { entryPatch: { revision: '2' } }],
    ['schema', { entryPatch: { schemaVersion: 2 } }],
    ['client timestamp', { entryPatch: { committedAt: Timestamp.fromMillis(0) } }],
    ['null before', { entryPatch: { before: null } }],
    ['null after', { entryPatch: { after: null } }],
    ['extra entry field', { entryPatch: { secret: 'unexpected' } }],
    ['unchanged counter', { userPatch: { judgementRevisions: revisions } }],
    ['counter jump', {
      userPatch: { judgementRevisions: { ...revisions, goal: 3 } },
    }],
    ['counter rewind', {
      userPatch: { judgementRevisions: { ...revisions, goal: 0 } },
    }],
    ['startedAt mutation', {
      userPatch: { judgementHistoryStartedAt: Timestamp.fromMillis(0) },
    }],
    ['pointer unchanged', { userPatch: { activeGoalId: ID } }],
    ['pointer to existing goal', { userPatch: { activeGoalId: 'other' } }],
    ['unrelated root field', { userPatch: { extra: true } }],
    ['old numeric mutation', { oldPatch: { minDailyMinutes: 90 } }],
    ['old createdAt mutation', { oldPatch: { createdAt: 9 } }],
    ['old wrong status', { oldPatch: { status: 'finished' } }],
    ['new wrong status', { nextPatch: { status: 'replaced' } }],
    ['new extra field', { nextPatch: { extra: true } }],
    ['new past startDate', { nextPatch: { startDate: '2020-01-01' } }],
    ...(['settings', 'xLink', 'subscription'] as const).map((stream): [string, Attempt] => [
      `other counter ${stream}`, {
        userPatch: { judgementRevisions: { ...revisions, goal: 2, [stream]: 9 } },
      },
    ]),
    ...[
      ['targetHours', 0], ['targetHours', 20001], ['targetHours', 1.5],
      ['minDailyMinutes', 0], ['minDailyMinutes', 15],
      ['goalDailyMinutes', 970], ['goalDailyMinutes', 30],
      ['examDate', 'bad'],
    ].map(([field, value]): [string, Attempt] => [
      `invalid new ${field}=${value}`, { nextPatch: { [String(field)]: value } },
    ]),
  ];

  it.each(invalid)('rejects %s atomically', async (_label, options) => {
    await seed();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const user = (await getDoc(userRef(db))).data();
      const old = (await getDoc(goalRef(db))).data();
      await expect(attempt(options)).rejects.toThrow();
      expect((await getDoc(userRef(db))).data()).toEqual(user);
      expect((await getDoc(goalRef(db))).data()).toEqual(old);
      expect((await getDoc(goalRef(db, 'other'))).data()).toEqual(old);
      expect((await getDoc(goalRef(db, NEXT))).exists()).toBe(false);
      expect((await getDoc(historyRef(db, options.entryId, options.stream))).exists()).toBe(false);
      expect((await getDoc(historyRef(db, '3'))).exists()).toBe(false);
    });
  });

  it.each(['before', 'after'] as const)(
    'checks all %s fields, missing fields and extra fields', async (side) => {
      await seed();
      const snapshot = side === 'before'
        ? projection(makeGoal()) : projection(nextGoal(), NEXT);
      for (const field of Object.keys(snapshot)) {
        await expect(attempt({
          entryPatch: { [side]: { ...snapshot, [field]: 'forged' } },
        })).rejects.toThrow();
        const missing: Record<string, unknown> = { ...snapshot };
        delete missing[field];
        await expect(attempt({ entryPatch: { [side]: missing } })).rejects.toThrow();
      }
      await expect(attempt({
        entryPatch: { [side]: { ...snapshot, targetHours: 1000 } },
      })).rejects.toThrow();
    },
  );

  const badMetadata: Record<string, unknown>[] = [
    { judgementHistoryStartedAt: Timestamp.fromMillis(0) },
    { judgementRevisions: revisions },
    { ...metadata(), judgementHistoryStartedAt: null },
    { ...metadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
    { ...metadata(), judgementRevisions: null },
    { ...metadata(), judgementRevisions: [] },
    { ...metadata(), judgementRevisions: {} },
    ...(['goal', 'settings', 'xLink', 'subscription'] as const).flatMap((stream) =>
      [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((value) => ({
        ...metadata(), judgementRevisions: { ...revisions, [stream]: value },
      }))),
    { ...metadata(), judgementRevisions: {
      ...revisions, goal: Number.MAX_SAFE_INTEGER,
    } },
  ];

  it.each(badMetadata)('fails closed for partial/malformed metadata %#', async (bad) => {
    await seed(bad);
    await expect(attempt()).rejects.toThrow();
    await expect(attempt({ counter: false, entry: false })).rejects.toThrow();
  });

  it('keeps legacy replacement without manufacturing history', async () => {
    await seed({});
    await expect(attempt({ counter: false, entry: false })).resolves.toBeUndefined();
    expect((await getDoc(historyRef(dbFor()))).exists()).toBe(false);
  });

  it('legacy cannot create initialized history', async () => {
    await seed({});
    await expect(attempt()).rejects.toThrow();
  });

  it.each(['deleting', 'missing', 'replaced', 'finished', 'wrong-pointer'])(
    'rejects invalid state %s', async (state) => {
      await seed(
        { ...metadata(),
          ...(state === 'deleting' ? { deletionInProgress: true } : {}),
          ...(state === 'wrong-pointer' ? { activeGoalId: 'other' } : {}) },
        { ...makeGoal(),
          ...(state === 'replaced' || state === 'finished' ? { status: state } : {}) },
        state !== 'missing',
      );
      await expect(attempt()).rejects.toThrow();
    },
  );

  it('cannot overwrite an occupied canonical entry', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(historyRef(context.firestore()), { occupied: true });
    });
    await expect(attempt()).rejects.toThrow();
    expect((await getDoc(goalRef(dbFor(), NEXT))).exists()).toBe(false);
    expect((await getDoc(historyRef(dbFor()))).data()).toEqual({ occupied: true });
  });

  it.each(['update', 'delete'] as const)('history stays create-only: %s', async (operation) => {
    await seed();
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(historyRef(context.firestore(), '1'), {
        schemaVersion: 1, revision: 1, committedAt: Timestamp.fromMillis(0),
        before: projection(makeGoal()), after: projection(makeGoal()),
      });
    });
    const ref = historyRef(dbFor(), '1');
    await expect(operation === 'update'
      ? updateDoc(ref, { committedAt: serverTimestamp() })
      : deleteDoc(ref)).rejects.toThrow();
  });
});
