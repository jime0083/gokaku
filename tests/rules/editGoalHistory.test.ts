import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp, deleteDoc, doc, getDoc, runTransaction, serverTimestamp,
  setDoc, setLogLevel, updateDoc, writeBatch,
} from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';

const UID = 'edit-history-owner';
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
const patch = { targetHours: 2000, minDailyMinutes: 90, goalDailyMinutes: 180 };
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
    projectId: `demo-gokaku-edit-history-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => {
  if (env) {
    try { await env.clearFirestore(); } finally { await env.cleanup(); }
  }
});

type Attempt = {
  auth?: string | null;
  goal?: boolean;
  parent?: boolean;
  entry?: boolean;
  goalId?: string;
  entryId?: string;
  stream?: string;
  goalPatch?: Record<string, unknown>;
  userPatch?: Record<string, unknown>;
  entryPatch?: Record<string, unknown>;
  extraEntry?: boolean;
};

async function attempt(options: Attempt = {}) {
  const db = dbFor(options.auth);
  const before = makeGoal();
  const change = options.goalPatch ?? patch;
  const batch = writeBatch(db);
  if (options.goal !== false) batch.update(goalRef(db, options.goalId), change);
  if (options.parent !== false) batch.update(userRef(db), {
    judgementRevisions: { ...revisions, goal: 2 }, ...options.userPatch,
  });
  if (options.entry !== false) batch.set(historyRef(db, options.entryId, options.stream), {
    schemaVersion: 1, revision: 2, committedAt: serverTimestamp(),
    before: projection(before), after: projection({ ...before, ...change }),
    ...options.entryPatch,
  });
  if (options.extraEntry) batch.set(historyRef(db, '3'), {
    schemaVersion: 1, revision: 3, committedAt: serverTimestamp(),
    before: projection(before), after: projection({ ...before, ...change }),
  });
  return batch.commit();
}

describe('7-2-D numeric edit history rules', () => {
  it.each(['cert', 'exam'] as const)(
    'normal %s transaction succeeds within actual document-access/expression limits', async (type) => {
      const initial = metadata();
      const goal = makeGoal(type);
      await seed(initial, goal);
      const db = dbFor();
      await runTransaction(db, async (tx) => {
        const user = (await tx.get(userRef(db))).data()!;
        const current = (await tx.get(goalRef(db))).data()!;
        tx.update(goalRef(db), patch);
        tx.update(userRef(db), {
          judgementRevisions: { ...user.judgementRevisions, goal: 2 },
        });
        tx.set(historyRef(db), {
          schemaVersion: 1, revision: 2, committedAt: serverTimestamp(),
          before: projection(current), after: projection({ ...current, ...patch }),
        });
      });
      expect((await getDoc(goalRef(db))).data()).toEqual({ ...goal, ...patch });
      expect((await getDoc(userRef(db))).data()).toEqual({
        activeGoalId: ID, createdAt: 1, checkEnabled: true, xPostEnabled: true,
        ...initial, judgementRevisions: { ...revisions, goal: 2 },
      });
      expect((await getDoc(historyRef(db))).data()).toEqual({
        schemaVersion: 1, revision: 2, committedAt: expect.any(Timestamp),
        before: projection(goal), after: projection({ ...goal, ...patch }),
      });
    },
  );

  it('normal three-write batch succeeds under actual 10/20-access limits', async () => {
    await seed();
    await expect(attempt()).resolves.toBeUndefined();
  });

  it.each([{}, { targetHours: 2000 }])('allows equal snapshots with numeric patch %p', async (change) => {
    await seed();
    await expect(attempt({ goalPatch: change })).resolves.toBeUndefined();
    const entry = (await getDoc(historyRef(dbFor()))).data()!;
    expect(entry.before).toEqual(entry.after);
  });

  const invalid: [string, Attempt][] = [
    ['entry omitted', { entry: false }],
    ['parent omitted', { parent: false }],
    ['goal omitted with changed after', { goal: false }],
    ['counter only', { goal: false, entry: false }],
    ['entry only', { parent: false, goal: false }],
    ['other goal', { goalId: 'other' }],
    ['other user', { auth: 'other' }],
    ['unauthenticated', { auth: null }],
    ['noncanonical ID', { entryId: '02' }],
    ['wrong ID', { entryId: '3' }],
    ['extra canonical-looking entry', { extraEntry: true }],
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
    ['counter unchanged', { userPatch: { judgementRevisions: revisions } }],
    ['counter jump', { userPatch: { judgementRevisions: { ...revisions, goal: 3 } } }],
    ['counter rewind', { userPatch: { judgementRevisions: { ...revisions, goal: 0 } } }],
    ['startedAt mutation', { userPatch: { judgementHistoryStartedAt: Timestamp.fromMillis(0) } }],
    ['pointer mutation', { userPatch: { activeGoalId: 'other' } }],
    ['settings mixed', { userPatch: { xPostEnabled: false } }],
    ['checkEnabled mixed', { userPatch: { checkEnabled: false } }],
    ['root extra field', { userPatch: { extra: true } }],
    ...(['settings', 'xLink', 'subscription'] as const).map((stream): [string, Attempt] => [
      `other counter ${stream}`, {
        userPatch: { judgementRevisions: { ...revisions, goal: 2, [stream]: 9 } },
      },
    ]),
    ...['createdAt', 'startDate', 'estimatedHours', 'type', 'status', 'certId', 'certOtherName']
      .map((field): [string, Attempt] => [
        `immutable ${field}`, { goalPatch: { ...patch, [field]: 'forged' } },
      ]),
    ...[
      ['targetHours', 0], ['targetHours', 20001], ['targetHours', 1.5],
      ['minDailyMinutes', 0], ['minDailyMinutes', 15],
      ['goalDailyMinutes', 970], ['goalDailyMinutes', 60], ['examDate', 'bad'],
    ].map(([field, value]): [string, Attempt] => [
      `invalid numeric ${field}=${value}`, { goalPatch: { ...patch, [String(field)]: value } },
    ]),
  ];

  it.each(invalid)('rejects %s with no partial writes', async (_label, options) => {
    await seed();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const initialUser = (await getDoc(userRef(db))).data();
      const initialGoal = (await getDoc(goalRef(db))).data();
      await expect(attempt(options)).rejects.toThrow();
      expect((await getDoc(userRef(db))).data()).toEqual(initialUser);
      expect((await getDoc(goalRef(db))).data()).toEqual(initialGoal);
      expect((await getDoc(goalRef(db, 'other'))).data()).toEqual(initialGoal);
      expect((await getDoc(historyRef(db, options.entryId, options.stream))).exists()).toBe(false);
      expect((await getDoc(historyRef(db, '3'))).exists()).toBe(false);
    });
  });

  it.each(['before', 'after'] as const)('checks every %s projection field and excludes extras', async (side) => {
    await seed();
    const value = side === 'before' ? makeGoal() : { ...makeGoal(), ...patch };
    for (const field of ['goalId', 'startDate', 'examDate', 'minDailyMinutes', 'goalDailyMinutes']) {
      await expect(attempt({
        entryPatch: { [side]: { ...projection(value), [field]: 'forged' } },
      })).rejects.toThrow();
    }
    await expect(attempt({
      entryPatch: { [side]: { ...projection(value), targetHours: 1000 } },
    })).rejects.toThrow();
  });

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
    { ...metadata(), judgementRevisions: { ...revisions, goal: Number.MAX_SAFE_INTEGER } },
  ];

  it.each(badMetadata)('rejects invalid metadata on direct and history paths: %#', async (bad) => {
    await seed(bad);
    await expect(updateDoc(goalRef(dbFor()), patch)).rejects.toThrow();
    await expect(attempt()).rejects.toThrow();
  });

  it('legacy direct numeric update remains valid without history', async () => {
    await seed({});
    const db = dbFor();
    await expect(updateDoc(goalRef(db), patch)).resolves.toBeUndefined();
    expect((await getDoc(historyRef(db))).exists()).toBe(false);
  });

  it('legacy cannot manufacture initialized history', async () => {
    await seed({});
    await expect(attempt()).rejects.toThrow();
  });

  it.each(['deleting', 'missing', 'replaced', 'finished', 'wrong-pointer'])(
    'rejects invalid parent/current-goal state %s', async (state) => {
      await seed(
        { ...metadata(),
          ...(state === 'deleting' ? { deletionInProgress: true } : {}),
          ...(state === 'wrong-pointer' ? { activeGoalId: 'other' } : {}) },
        { ...makeGoal(),
          ...(state === 'replaced' || state === 'finished' ? { status: state } : {}) },
        state !== 'missing',
      );
      await expect(attempt()).rejects.toThrow();
      await expect(updateDoc(goalRef(dbFor()), patch)).rejects.toThrow();
    },
  );

  it('cannot overwrite an existing canonical entry as part of an edit', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(historyRef(context.firestore()), { occupied: true });
    });
    await expect(attempt()).rejects.toThrow();
    expect((await getDoc(goalRef(dbFor()))).data()).toEqual(makeGoal());
    expect((await getDoc(historyRef(dbFor()))).data()).toEqual({ occupied: true });
  });

  it.each(['update', 'delete'] as const)('history is create-only: %s', async (operation) => {
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
