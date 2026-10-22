import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  Timestamp, collection, deleteDoc, doc, getDoc, getDocs,
  runTransaction, serverTimestamp, setDoc, setLogLevel, updateDoc, writeBatch,
} from 'firebase/firestore';

const UID = 'settings-history-owner';
const counters = { goal: 1, settings: 2, xLink: 3, subscription: 4 };
const metadata = () => ({
  judgementHistoryStartedAt: Timestamp.fromMillis(1),
  judgementRevisions: { ...counters },
});
const settings = { checkEnabled: false, xPostEnabled: true };
const initial = {
  createdAt: 1, activeGoalId: 'current', checkEnabled: true, xPostEnabled: false,
  xLinked: true, subscription: { status: 'active' },
};
let env: RulesTestEnvironment;
const dbFor = (auth: string | null = UID) =>
  (auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore();
type Db = ReturnType<typeof dbFor>;
const userRef = (db: Db) => doc(db, 'users', UID);
const entryRef = (db: Db, id = '3', stream = 'settings') =>
  doc(db, 'users', UID, 'judgementHistory', stream, 'entries', id);
const sessionRef = (db: Db) => doc(db, 'users', UID, 'sessions', 'active');
const session = { startAt: 1, stopAt: null, checkEnabled: true, confirmations: [2] };

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: `demo-gokaku-settings-history-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => {
  if (env) {
    try { await env.clearFirestore(); } finally { await env.cleanup(); }
  }
});

async function seed(extra: Record<string, unknown> = metadata(), exists = true) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    if (exists) await setDoc(userRef(db), { ...initial, ...extra });
    await setDoc(sessionRef(db), session);
  });
}

type Attempt = {
  auth?: string | null;
  parent?: boolean;
  entry?: boolean;
  entryId?: string;
  stream?: string;
  userPatch?: Record<string, unknown>;
  entryPatch?: Record<string, unknown>;
  extraEntry?: boolean;
};
async function attempt(options: Attempt = {}) {
  const db = dbFor(options.auth);
  const batch = writeBatch(db);
  if (options.parent !== false) batch.update(userRef(db), {
    ...settings, judgementRevisions: { ...counters, settings: 3 },
    ...options.userPatch,
  });
  const payload = {
    schemaVersion: 1, revision: 3, committedAt: serverTimestamp(),
    before: { xPostEnabled: false }, after: { xPostEnabled: true },
    ...options.entryPatch,
  };
  if (options.entry !== false) {
    batch.set(entryRef(db, options.entryId, options.stream), payload);
  }
  if (options.extraEntry) {
    batch.set(entryRef(db, '4'), { ...payload, revision: 4 });
  }
  return batch.commit();
}

async function expectUnchangedAfterRejection(options: Attempt = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const before = (await getDoc(userRef(db))).data();
    await expect(attempt(options)).rejects.toThrow();
    expect((await getDoc(userRef(db))).data()).toEqual(before);
    expect((await getDoc(sessionRef(db))).data()).toEqual(session);
    for (const stream of ['goal', 'settings', 'xLink', 'subscription']) {
      expect((await getDocs(collection(
        db, 'users', UID, 'judgementHistory', stream, 'entries',
      ))).empty).toBe(true);
    }
  });
}

it('normal transaction succeeds under actual expression and 10/20 access limits', async () => {
  const meta = metadata();
  await seed(meta);
  const db = dbFor();
  await runTransaction(db, async (tx) => {
    const user = (await tx.get(userRef(db))).data()!;
    const revision = user.judgementRevisions.settings + 1;
    tx.update(userRef(db), {
      ...settings, judgementRevisions: { ...user.judgementRevisions, settings: revision },
    });
    tx.set(entryRef(db, String(revision)), {
      schemaVersion: 1, revision, committedAt: serverTimestamp(),
      before: { xPostEnabled: user.xPostEnabled },
      after: { xPostEnabled: settings.xPostEnabled },
    });
  });
  expect((await getDoc(userRef(db))).data()).toEqual({
    ...initial, ...meta, ...settings,
    judgementRevisions: { ...counters, settings: 3 },
  });
  expect((await getDoc(entryRef(db))).data()).toEqual({
    schemaVersion: 1, revision: 3, committedAt: expect.any(Timestamp),
    before: { xPostEnabled: false }, after: { xPostEnabled: true },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    expect((await getDoc(sessionRef(context.firestore()))).data()).toEqual(session);
  });
});

it('normal two-write batch succeeds within actual limits', async () => {
  await seed();
  await expect(attempt()).resolves.toBeUndefined();
});

it.each([true, false])('accepts equal snapshots with checkEnabled=%s', async (checkEnabled) => {
  await seed();
  await expect(attempt({
    userPatch: { checkEnabled, xPostEnabled: false },
    entryPatch: { after: { xPostEnabled: false } },
  })).resolves.toBeUndefined();
  const entry = (await getDoc(entryRef(dbFor()))).data()!;
  expect(entry.before).toEqual(entry.after);
});

const invalid: [string, Attempt][] = [
  ['missing entry', { entry: false }],
  ['entry without parent', { parent: false }],
  ['no actual counter change', { userPatch: { judgementRevisions: counters } }],
  ['counter without entry', { entry: false, userPatch: {
    checkEnabled: true, xPostEnabled: false,
  } }],
  ['extra entry', { extraEntry: true }],
  ['other user', { auth: 'other' }],
  ['unauthenticated', { auth: null }],
  ['noncanonical ID', { entryId: '03' }],
  ['wrong ID', { entryId: '4' }],
  ['goal stream', { stream: 'goal' }],
  ['xLink stream', { stream: 'xLink' }],
  ['subscription stream', { stream: 'subscription' }],
  ['revision jump', { entryPatch: { revision: 4 } }],
  ['revision type', { entryPatch: { revision: '3' } }],
  ['schema', { entryPatch: { schemaVersion: 2 } }],
  ['client time', { entryPatch: { committedAt: Timestamp.fromMillis(0) } }],
  ['forged before', { entryPatch: { before: { xPostEnabled: true } } }],
  ['forged after', { entryPatch: { after: { xPostEnabled: false } } }],
  ['null before', { entryPatch: { before: null } }],
  ['extra snapshot field', { entryPatch: {
    after: { xPostEnabled: true, checkEnabled: false },
  } }],
  ['extra entry field', { entryPatch: { extra: true } }],
  ['counter jump', { userPatch: {
    judgementRevisions: { ...counters, settings: 4 },
  } }],
  ['startedAt mutation', { userPatch: {
    judgementHistoryStartedAt: Timestamp.fromMillis(2),
  } }],
  ['pointer mutation', { userPatch: { activeGoalId: 'other' } }],
  ['server field mutation', { userPatch: { xLinked: false } }],
  ['nonboolean checkEnabled', { userPatch: { checkEnabled: 'false' } }],
  ['nonboolean xPostEnabled', { userPatch: { xPostEnabled: 'true' } }],
  ...(['goal', 'xLink', 'subscription'] as const).map((stream): [string, Attempt] => [
    `other counter ${stream}`, { userPatch: {
      judgementRevisions: { ...counters, settings: 3, [stream]: 9 },
    } },
  ]),
];
it.each(invalid)('rejects %s atomically', async (_label, options) => {
  await seed();
  await expectUnchangedAfterRejection(options);
});

it('initialized settings cannot bypass history by direct update', async () => {
  await seed();
  await expect(updateDoc(userRef(dbFor()), settings)).rejects.toThrow();
  expect((await getDoc(userRef(dbFor()))).data()).toEqual({ ...initial, ...metadata() });
});

const badMetadata: Record<string, unknown>[] = [
  { judgementHistoryStartedAt: Timestamp.fromMillis(1) },
  { judgementRevisions: counters },
  { ...metadata(), judgementHistoryStartedAt: null },
  { ...metadata(), judgementHistoryStartedAt: { seconds: 1, nanoseconds: 0 } },
  { ...metadata(), judgementRevisions: null },
  { ...metadata(), judgementRevisions: {} },
  ...(['goal', 'settings', 'xLink', 'subscription'] as const).map((stream) => ({
    ...metadata(), judgementRevisions: { ...counters, [stream]: 0 },
  })),
  ...[1.5, '2', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER].map((settings) => ({
    ...metadata(), judgementRevisions: { ...counters, settings },
  })),
];
it.each(badMetadata)('rejects malformed metadata on direct and history paths: %#', async (bad) => {
  await seed(bad);
  await expect(updateDoc(userRef(dbFor()), settings)).rejects.toThrow();
  await expectUnchangedAfterRejection();
});

it('legacy preserves direct two-setting updates only when both metadata fields are absent', async () => {
  await seed({});
  await expect(updateDoc(userRef(dbFor()), settings)).resolves.toBeUndefined();
  expect((await getDoc(userRef(dbFor()))).data()).toEqual({ ...initial, ...settings });
  expect((await getDoc(entryRef(dbFor()))).exists()).toBe(false);
});

it('legacy cannot manufacture history or initialize metadata', async () => {
  await seed({});
  await expectUnchangedAfterRejection();
});

it.each(['missing', 'deleting', 'legacy-deleting'])(
  'rejects %s user on direct and history paths', async (state) => {
    await seed(
      state === 'legacy-deleting'
        ? { deletionInProgress: true }
        : { ...metadata(), ...(state === 'deleting' ? { deletionInProgress: true } : {}) },
      state !== 'missing',
    );
    await expect(updateDoc(userRef(dbFor()), settings)).rejects.toThrow();
    await expectUnchangedAfterRejection();
  },
);

it('rejects an initialized missing source setting instead of inventing before', async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (context) => {
    const { xPostEnabled: omitted, ...withoutSetting } = initial;
    expect(omitted).toBe(false);
    await setDoc(userRef(context.firestore()), { ...withoutSetting, ...metadata() });
  });
  await expectUnchangedAfterRejection();
});

it('cannot overwrite an occupied canonical entry', async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(entryRef(context.firestore()), { occupied: true });
  });
  await expect(attempt()).rejects.toThrow();
  expect((await getDoc(userRef(dbFor()))).data()).toEqual({ ...initial, ...metadata() });
  expect((await getDoc(entryRef(dbFor()))).data()).toEqual({ occupied: true });
});

it.each(['update', 'delete'] as const)('history is create-only: %s', async (operation) => {
  await seed();
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(entryRef(context.firestore(), '2'), {
      schemaVersion: 1, revision: 2, committedAt: Timestamp.fromMillis(1),
      before: { xPostEnabled: false }, after: { xPostEnabled: false },
    });
  });
  const ref = entryRef(dbFor(), '2');
  const before = (await getDoc(ref)).data();
  await expect(operation === 'update'
    ? updateDoc(ref, { committedAt: serverTimestamp() })
    : deleteDoc(ref)).rejects.toThrow();
  expect((await getDoc(ref)).data()).toEqual(before);
});
