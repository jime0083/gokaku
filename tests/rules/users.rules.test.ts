import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, setLogLevel } from 'firebase/firestore';

// テストごとに一意なプロジェクトIDを使い、他のテストのデータと共有しない(demo- 接頭辞で本番に接続しない)
const PROJECT_ID = `demo-gokaku-rules-${process.pid}-${Date.now()}`;
const OWNER_UID = 'owner-uid';
const OTHER_UID = 'other-uid';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  // 拒否を期待するテストで SDK が出す PERMISSION_DENIED の警告ログを抑止する
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
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', OWNER_UID), { checkEnabled: true });
    await setDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1'), { type: 'cert' });
    await setDoc(doc(db, 'xTokens', OWNER_UID), { expiresAt: 0 });
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
    await testEnv.cleanup();
  }
});

describe('users/{uid} の読み取り', () => {
  it('本人は自分のユーザードキュメントを読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID)));
  });

  it('本人は自分の配下(goals)を読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1')));
  });

  it('他人はユーザードキュメントを読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID)));
  });

  it('他人は配下(goals)を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1')));
  });

  it('未ログインは読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID)));
  });
});

describe('デフォルト拒否', () => {
  it('本人でも xTokens は読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'xTokens', OWNER_UID)));
  });

  it('本人でも自分のユーザードキュメントに書き込めない(書き込み許可は後続タスクで追加)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'users', OWNER_UID), { checkEnabled: false }));
  });
});

// Phase 1-4 技術検証(gokaku-security によるルール検証): デバイストークン(ハッシュ)と
// ネイティブ→サーバー同期のイベントログは、クライアントから一切読み書きできてはならない
// (deviceTokens はサーバー(Cloud Functions の Admin SDK)だけが読み書きし、
//  syncEvents はサーバーだけが書き込み、本人は自分の分だけ読める)
describe('deviceTokens(Phase 1-4 技術検証: ネイティブ同期用デバイストークンのハッシュ)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'dummy-hash' });
    });
  });

  it('本人でも deviceTokens を読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });

  it('他人も deviceTokens を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });

  it('本人でも deviceTokens に書き込めない(トークンのハッシュ上書き・なりすましの防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'attacker-hash' }));
  });

  it('未ログインは deviceTokens を読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });
});

describe('users/{uid}/syncEvents(Phase 1-4 技術検証: ロック画面・通知アクションからの同期イベント)', () => {
  const EVENT_ID = 'evt-1';

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'users', OWNER_UID, 'syncEvents', EVENT_ID), {
        action: 'stop',
        source: 'live_activity',
      });
    });
  });

  it('本人は自分の syncEvents を読める(サーバーが書き込んだ記録の確認用)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID, 'syncEvents', EVENT_ID)));
  });

  it('他人は syncEvents を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'syncEvents', EVENT_ID)));
  });

  it('本人でも syncEvents に書き込めない(クライアントからの偽イベント注入・改ざんの防止。記録はサーバーのnativeSyncのみ)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID, 'syncEvents', 'evt-forged'), {
        action: 'start',
        source: 'app',
      }),
    );
  });

  it('本人でも既存の syncEvents を書き換えられない(過去の記録の改ざん防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID, 'syncEvents', EVENT_ID), {
        action: 'start',
        source: 'app',
      }),
    );
  });
});
