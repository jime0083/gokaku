import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, setLogLevel, updateDoc,
} from 'firebase/firestore';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(host)
  || Number(host.split(':')[1]) > 65535) {
  throw new Error('xNotice rules tests require local demo-gokaku Firestore Emulator');
}
const UID = 'notice-owner';
const ID = 'a'.repeat(64);
const initial = {
  createdAt: 1, checkEnabled: true, xPostEnabled: false,
  xNotice: {
    schemaVersion: 1, id: ID, date: '2026-10-26', linkRevision: 1,
    kind: 'post_failed', readAt: null,
  },
};
let env: RulesTestEnvironment;
const dbFor = (auth: string | null) => (auth === null
  ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore();
beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: `demo-gokaku-x-notice-${randomUUID()}`,
    firestore: {
      host: host.split(':')[0], port: Number(host.split(':')[1]),
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
});
afterAll(async () => {
  if (env) {
    try { await env.clearFirestore(); } finally { await env.cleanup(); }
  }
});

async function withUser(run: () => Promise<void>, extra: Record<string, unknown> = {}) {
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', UID), { ...initial, ...extra });
    });
    await run();
  } finally { await env.clearFirestore(); }
}

test('only owner can read the persisted notice', async () => {
  await withUser(async () => {
    const snapshot = await assertSucceeds(getDoc(doc(dbFor(UID), 'users', UID)));
    expect(snapshot.get('xNotice')).toEqual(initial.xNotice);
    await assertFails(getDoc(doc(dbFor('other'), 'users', UID)));
    await assertFails(getDoc(doc(dbFor(null), 'users', UID)));
  });
});

test.each([UID, 'other', null])('client %p cannot acknowledge, forge, erase or replace xNotice', async (auth) => {
  await withUser(async () => {
    const ref = doc(dbFor(auth), 'users', UID);
    const operations = [
      () => updateDoc(ref, { 'xNotice.readAt': 1 }),
      () => updateDoc(ref, { 'xNotice.readAt': serverTimestamp() }),
      () => updateDoc(ref, { xNotice: { ...initial.xNotice, readAt: 1 } }),
      () => updateDoc(ref, { xNotice: { ...initial.xNotice, id: 'b'.repeat(64) } }),
      () => updateDoc(ref, { xNotice: null }),
      () => updateDoc(ref, { xNotice: deleteField() }),
      () => setDoc(ref, { xNotice: { ...initial.xNotice, readAt: 1 } }, { merge: true }),
      () => setDoc(ref, { ...initial, xNotice: { ...initial.xNotice, readAt: 1 } }),
      () => setDoc(ref, { createdAt: 1 }),
      () => deleteDoc(ref),
    ];
    for (const operation of operations) {
      await assertFails(operation());
      await env.withSecurityRulesDisabled(async (context) => {
        expect((await getDoc(doc(context.firestore(), 'users', UID))).data()).toEqual(initial);
      });
    }
  });
});

test.each([UID, 'other', null])('client %p cannot manufacture a missing parent with xNotice', async (auth) => {
  try {
    const ref = doc(dbFor(auth), 'users', UID);
    await assertFails(setDoc(ref, initial));
    await env.withSecurityRulesDisabled(async (context) => {
      expect((await getDoc(doc(context.firestore(), 'users', UID))).exists()).toBe(false);
    });
  } finally { await env.clearFirestore(); }
});

test('deletion marker keeps client acknowledgement denied', async () => {
  await withUser(async () => {
    await assertFails(updateDoc(doc(dbFor(UID), 'users', UID), { 'xNotice.readAt': 1 }));
    await env.withSecurityRulesDisabled(async (context) => {
      expect((await getDoc(doc(context.firestore(), 'users', UID))).data())
        .toEqual({ ...initial, deletionInProgress: true });
    });
  }, { deletionInProgress: true });
});
