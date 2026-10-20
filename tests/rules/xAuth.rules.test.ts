import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  setDoc,
  setLogLevel,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

// 独立した demo プロジェクト。既存テストのデータを消去しない。
const PROJECT_ID = `demo-gokaku-xauth-${process.pid}-${randomUUID().slice(0, 8)}`;
const identities = ['owner', 'other', 'unauthenticated'] as const;
const operations = [
  'get',
  'get-missing',
  'list',
  'query-owner',
  'create',
  'overwrite',
  'merge',
  'update-access',
  'update-refresh',
  'replace-oauth-map',
  'update-oauth-nested',
  'delete-oauth-entry',
  'delete-oauth-map',
  'delete',
] as const;

type Operation = typeof operations[number];

let env: RulesTestEnvironment | undefined;

function environment(): RulesTestEnvironment {
  if (!env) throw new Error('Rules test environment is not initialized');
  return env;
}

// 暗号化処理のテストではない。実トークン・秘密鍵を使わない不透明なダミー値。
function tokenDocument() {
  return {
    accessToken: 'dummy-encrypted-access',
    refreshToken: 'dummy-encrypted-refresh',
    expiresAt: 1800000000000,
    oauthStates: {
      stateHash: {
        encryptedVerifier: 'dummy-encrypted-pkce',
        expiresAt: 1800000000000,
      },
    },
  };
}

beforeAll(async () => {
  // Emulator 指定なし・外部ホスト指定での実行を禁止する。
  const address = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('A loopback FIRESTORE_EMULATOR_HOST is required');
  }

  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1',
      port,
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  if (env) await env.cleanup();
});

describe.each(identities)('xTokens client denial: %s', (identity) => {
  it.each(operations)('denies %s and preserves server data', async (operation: Operation) => {
    const testEnv = environment();
    const suffix = randomUUID();
    const ownerUid = `xauth-owner-${suffix}`;
    const otherUid = `xauth-other-${suffix}`;
    const missingUid = `xauth-missing-${suffix}`;
    const initial = tokenDocument();
    const parent = { checkEnabled: true, xPostEnabled: false };
    const context = identity === 'unauthenticated'
      ? testEnv.unauthenticatedContext()
      : testEnv.authenticatedContext(identity === 'owner' ? ownerUid : otherUid);
    const db = context.firestore();
    const target = doc(db, 'xTokens', ownerUid);

    try {
      await testEnv.withSecurityRulesDisabled(async (admin) => {
        const adminDb = admin.firestore();
        const batch = writeBatch(adminDb);
        batch.set(doc(adminDb, 'users', ownerUid), parent);
        batch.set(doc(adminDb, 'users', otherUid), parent);
        if (operation !== 'create') {
          batch.set(doc(adminDb, 'xTokens', ownerUid), initial);
        }
        await batch.commit();

        // 拒否テストが空データだけを見て成功しないよう、前提を検証する。
        const seeded = await getDoc(doc(adminDb, 'xTokens', ownerUid));
        expect(seeded.exists()).toBe(operation !== 'create');
        if (operation !== 'create') expect(seeded.data()).toEqual(initial);
        expect((await getDoc(doc(adminDb, 'xTokens', missingUid))).exists()).toBe(false);
      });

      async function attempt() {
        switch (operation) {
          case 'get':
            return getDoc(target);
          case 'get-missing':
            return getDoc(doc(db, 'xTokens', missingUid));
          case 'list':
            return getDocs(collection(db, 'xTokens'));
          case 'query-owner':
            return getDocs(query(
              collection(db, 'xTokens'),
              where(documentId(), '==', ownerUid),
            ));
          case 'create':
            return setDoc(target, initial);
          case 'overwrite':
            return setDoc(target, { accessToken: 'dummy-replacement' });
          case 'merge':
            return setDoc(target, {
              oauthStates: { injectedState: { encryptedVerifier: 'dummy-injected' } },
            }, { merge: true });
          case 'update-access':
            return updateDoc(target, { accessToken: 'dummy-changed-access' });
          case 'update-refresh':
            return updateDoc(target, { refreshToken: 'dummy-changed-refresh' });
          case 'replace-oauth-map':
            return updateDoc(target, { oauthStates: {} });
          case 'update-oauth-nested':
            return updateDoc(target, {
              'oauthStates.stateHash.encryptedVerifier': 'dummy-changed-pkce',
            });
          case 'delete-oauth-entry':
            return updateDoc(target, { 'oauthStates.stateHash': deleteField() });
          case 'delete-oauth-map':
            return updateDoc(target, { oauthStates: deleteField() });
          case 'delete':
            return deleteDoc(target);
        }
      }

      // 接続エラー等を「ルールによる拒否」と誤認しない。
      const error = await assertFails(attempt());
      expect(error).toMatchObject({ code: 'permission-denied' });

      await testEnv.withSecurityRulesDisabled(async (admin) => {
        const adminDb = admin.firestore();
        const stored = await getDoc(doc(adminDb, 'xTokens', ownerUid));
        expect(stored.exists()).toBe(operation !== 'create');
        if (operation !== 'create') expect(stored.data()).toEqual(initial);
        expect((await getDoc(doc(adminDb, 'xTokens', missingUid))).exists()).toBe(false);
        expect((await getDoc(doc(adminDb, 'users', ownerUid))).data()).toEqual(parent);
        expect((await getDoc(doc(adminDb, 'users', otherUid))).data()).toEqual(parent);
      });
    } finally {
      // 成功・失敗を問わず、このテスト専用のドキュメントだけ削除する。
      await testEnv.withSecurityRulesDisabled(async (admin) => {
        const adminDb = admin.firestore();
        const batch = writeBatch(adminDb);
        batch.delete(doc(adminDb, 'xTokens', ownerUid));
        batch.delete(doc(adminDb, 'xTokens', missingUid));
        batch.delete(doc(adminDb, 'users', ownerUid));
        batch.delete(doc(adminDb, 'users', otherUid));
        await batch.commit();
      });
    }
  });
});
