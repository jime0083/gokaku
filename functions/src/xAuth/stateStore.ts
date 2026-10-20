/**
 * Server-only internal persistence. 認証済みUIDだけを呼び出し元から渡す。
 * TTL・試行回数・認可フローは決めず、expiresAtを明示的に受け取る。
 * xTokens/{uid}.oauthStatesのみを更新し、既存tokenと別stateを保持する。
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import { getWritableAccount } from '../account/accountWriteGuard';
import { createPkceChallenge, decrypt, encrypt, hashState } from './crypto';

const FAILURE = 'X auth state operation failed';
// UIDごとの内部resource上限。製品TTL・ユーザー入力の制約ではない。
const MAX_PENDING_STATES = 16;

export interface StateStoreDeps {
  readonly firestore: Firestore;
  /** epoch milliseconds。transactionの再実行ごとに呼び直す。 */
  readonly now: () => number;
  /** canonical base64 AES-256 key。設定の取得は呼び出し元の責務。 */
  readonly encryptionKey: string;
}

export interface StartStateInput {
  readonly uid: string;
  readonly state: string;
  readonly pkceVerifier: string;
  readonly redirectUri: string;
  /** epoch milliseconds。製品のTTLはこのrepositoryで定めない。 */
  readonly expiresAt: number;
}

export interface ConsumeStateInput {
  readonly uid: string;
  readonly state: string;
  readonly expectedRedirectUri: string;
}

export interface StateStore {
  start(input: StartStateInput): Promise<void>;
  consume(input: ConsumeStateInput): Promise<string>;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireText(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.from(value, 'utf8').toString('utf8') === value,
  );
}

function requireUid(uid: unknown): asserts uid is string {
  requireText(uid);
  requireValue(
    uid.length <= 128 &&
    !uid.includes('/') &&
    uid !== '.' &&
    uid !== '..' &&
    !/^__.*__$/.test(uid),
  );
}

function requireMap(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null),
  );
}

function stateMap(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (data === undefined || !Object.hasOwn(data, 'oauthStates')) return {};
  const value = data.oauthStates;
  requireMap(value);
  return { ...value };
}

function timestamp(milliseconds: number): Timestamp {
  requireValue(Number.isSafeInteger(milliseconds));
  // Firestoreが保存可能な西暦1〜9999年の範囲もここで検証する。
  return Timestamp.fromMillis(milliseconds);
}

function storedMillis(value: unknown): number {
  requireValue(value instanceof Timestamp);
  const milliseconds = value.toMillis();
  requireValue(Number.isSafeInteger(milliseconds));
  requireValue(timestamp(milliseconds).isEqual(value));
  return milliseconds;
}

/** 壊れた/未知のrecordは保持して容量に数える。期限切れでも復号は不要。 */
function isExpiredState(key: string, record: unknown, now: number): boolean {
  try {
    requireMap(record);
    requireValue(/^[a-f0-9]{64}$/.test(key) && record.stateHash === key);
    requireText(record.encryptedVerifier);
    requireText(record.redirectUri);
    const createdAt = storedMillis(record.createdAt);
    const expiresAt = storedMillis(record.expiresAt);
    return createdAt < expiresAt && expiresAt <= now;
  } catch {
    return false;
  }
}

/** 入力値・復号内容・SDK例外・account reasonを外へ漏らさない。 */
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(FAILURE);
  }
}

export function createStateStore(deps: StateStoreDeps): StateStore {
  return {
    start: (input) => guarded(async () => {
      requireUid(input.uid);
      requireText(input.redirectUri);
      createPkceChallenge(input.pkceVerifier);
      const stateHash = hashState(input.state);
      const expiresAt = timestamp(input.expiresAt);
      const userRef = deps.firestore.doc(`users/${input.uid}`);
      const tokenRef = deps.firestore.doc(`xTokens/${input.uid}`);
      const encryptedVerifier = encrypt(input.pkceVerifier, deps.encryptionKey, {
        uid: input.uid, purpose: 'pkceVerifier',
      });

      await deps.firestore.runTransaction(async (tx) => {
        await getWritableAccount(tx, userRef);
        const snapshot = await tx.get(tokenRef);
        const nextStates = stateMap(snapshot.data());
        requireValue(!Object.hasOwn(nextStates, stateHash));
        const now = deps.now();
        const createdAt = timestamp(now);
        requireValue(input.expiresAt > now);
        // 同じhashは期限切れでも上で拒否し、再利用させない。
        for (const [key, record] of Object.entries(nextStates)) {
          if (isExpiredState(key, record, now)) delete nextStates[key];
        }
        requireValue(Object.keys(nextStates).length < MAX_PENDING_STATES);
        nextStates[stateHash] = {
          stateHash,
          encryptedVerifier,
          redirectUri: input.redirectUri,
          createdAt,
          expiresAt,
        };
        // updateはoauthStatesフィールド全体を置換する。merge setによる再帰mergeはしない。
        if (snapshot.exists) tx.update(tokenRef, { oauthStates: nextStates });
        else tx.create(tokenRef, { oauthStates: nextStates });
      });
    }),

    consume: (input) => guarded(async () => {
      requireUid(input.uid);
      requireText(input.expectedRedirectUri);
      const stateHash = hashState(input.state);
      const userRef = deps.firestore.doc(`users/${input.uid}`);
      const tokenRef = deps.firestore.doc(`xTokens/${input.uid}`);

      // callback内の値を外に保持しない。commit成功後の結果だけを返す。
      return deps.firestore.runTransaction(async (tx) => {
        await getWritableAccount(tx, userRef);
        const snapshot = await tx.get(tokenRef);
        requireValue(snapshot.exists);
        const nextStates = stateMap(snapshot.data());
        requireValue(Object.hasOwn(nextStates, stateHash));
        const record = nextStates[stateHash];
        requireMap(record);
        requireValue(record.stateHash === stateHash);
        requireText(record.redirectUri);
        requireValue(record.redirectUri === input.expectedRedirectUri);
        const createdAt = storedMillis(record.createdAt);
        const expiresAt = storedMillis(record.expiresAt);
        const now = deps.now();
        timestamp(now);
        requireValue(createdAt <= now && createdAt < expiresAt && expiresAt > now);
        requireText(record.encryptedVerifier);
        const verifier = decrypt(record.encryptedVerifier, deps.encryptionKey, {
          uid: input.uid, purpose: 'pkceVerifier',
        });
        createPkceChallenge(verifier);
        delete nextStates[stateHash];
        tx.update(tokenRef, { oauthStates: nextStates });
        return verifier;
      });
    }),
  };
}
