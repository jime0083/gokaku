import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, setLogLevel } from 'firebase/firestore';
import { parseSettings, saveSettings } from '../../src/features/settings/settings';

let env: RulesTestEnvironment;
const uid = 'settings-owner';
const initial = { createdAt: 1, activeGoalId: 'goal', subscription: { status: 'active' }, xLinked: true,
  xUsername: 'owner', xNotice: null };
beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({ projectId: `demo-gokaku-settings-${process.pid}-${Date.now()}`,
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), initial);
    await setDoc(doc(context.firestore(), 'users', uid, 'sessions', 'active'), {
      startAt: 1, stopAt: null, checkEnabled: true, confirmations: [2],
    });
  });
});
afterEach(async () => { await env.clearFirestore(); });
afterAll(async () => { if (env) await env.cleanup(); });
function ref(auth: string | null = uid) {
  return doc((auth === null ? env.unauthenticatedContext() : env.authenticatedContext(auth)).firestore(), 'users', uid);
}
it('actual save layer atomically saves two booleans and preserves server fields and active session', async () => {
  expect(parseSettings((await getDoc(ref())).data()!)).toEqual({ checkEnabled: true, xPostEnabled: false });
  const remember = jest.fn();
  const update = async (owner: string, patch: object) => {
    const db = env.authenticatedContext(uid).firestore();
    await updateDoc(doc(db, 'users', owner), patch);
  };
  await saveSettings({ update, remember }, uid, () => uid, { checkEnabled: false, xPostEnabled: true });
  expect((await getDoc(ref())).data()).toEqual({ ...initial, checkEnabled: false, xPostEnabled: true });
  expect(remember).toHaveBeenCalledWith(false);
  expect((await getDoc(doc(env.authenticatedContext(uid).firestore(), 'users', uid, 'sessions', 'active'))).data())
    .toEqual({ startAt: 1, stopAt: null, checkEnabled: true, confirmations: [2] });
});
it.each([null, 'other-owner'])('rejects non-owner %s without committing or native sync', async (auth) => {
  const remember = jest.fn();
  await expect(saveSettings({ update: async (_uid, patch) => { await updateDoc(ref(auth), patch); }, remember },
    uid, () => uid, { checkEnabled: false, xPostEnabled: true })).rejects.toThrow();
  expect((await getDoc(ref())).data()).toEqual(initial);
  expect(remember).not.toHaveBeenCalled();
});
it.each(['checkEnabled', 'xPostEnabled'])('rejects nonboolean %s atomically', async (field) => {
  for (const value of [0, 1, 'true', null]) {
    await assertFails(updateDoc(ref(), { checkEnabled: false, xPostEnabled: true, [field]: value }));
    expect((await getDoc(ref())).data()).toEqual(initial);
  }
});
it.each(['subscription', 'xLinked', 'xUsername', 'xNotice', 'createdAt', 'extra'])('rejects server field %s mixed with settings', async (field) => {
  await assertFails(updateDoc(ref(), { checkEnabled: false, xPostEnabled: true, [field]: 'changed' }));
  expect((await getDoc(ref())).data()).toEqual(initial);
});
it('does not create a missing user document', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await deleteDoc(doc(context.firestore(), 'users', uid));
  });
  const remember = jest.fn();
  await expect(saveSettings({ update: async (_uid, patch) => { await updateDoc(ref(), patch); }, remember },
    uid, () => uid, { checkEnabled: true, xPostEnabled: false })).rejects.toThrow();
  expect((await getDoc(ref())).exists()).toBe(false);
  expect(remember).not.toHaveBeenCalled();
});
