import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { createAuthorizationFlow, type AuthorizationFlow } from './authorizationFlow';
import { createCandidateFlow, type CandidateFlow, type PublicPendingCandidate } from './candidateFlow';
import { createCandidateStore } from './candidateStore';
import {
  AuthorizationConfigError,
  readAuthorizationConfig,
  X_OAUTH_CLIENT_ID,
  X_OAUTH_CLIENT_SECRET,
  X_TOKEN_ENCRYPTION_KEY,
} from './config';
import { createStateStore } from './stateStore';
import { createTokenStore } from './tokenStore';

type Input =
  | { action: 'begin' }
  | { action: 'complete'; state: string; code: string }
  | { action: 'pending' }
  | { action: 'confirm'; candidateId: string; postEnabled: boolean }
  | { action: 'discard'; candidateId: string };
type Result =
  | { authorizationUrl: string }
  | { candidateId: string }
  | { pending: PublicPendingCandidate | null }
  | { ok: true };
export type AuthorizationFlowFactory = () => Promise<AuthorizationFlow>;
export type CandidateFlowFactory = () => Promise<CandidateFlow>;

function validCandidateId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 1500 && /^[A-Za-z0-9_-]+$/.test(value) &&
    !/^__.*__$/.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 4096 && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}

function parseInput(data: unknown): Input {
  try {
    if (data === null || typeof data !== 'object') throw new Error();
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    // Reject accessors, symbols, hidden extra fields and inherited properties.
    const fields = Object.getOwnPropertyDescriptors(data);
    const keys = Reflect.ownKeys(data);
    if (keys.some((key) => typeof key !== 'string' ||
      !Object.hasOwn(fields[key], 'value'))) throw new Error();
    const action: unknown = fields.action?.value;
    let allowed: string[];
    switch (action) {
      case 'begin':
      case 'pending':
        allowed = ['action'];
        break;
      case 'complete':
        allowed = ['action', 'state', 'code'];
        break;
      case 'confirm':
        allowed = ['action', 'candidateId', 'postEnabled'];
        break;
      case 'discard':
        allowed = ['action', 'candidateId'];
        break;
      default:
        throw new Error();
    }
    if (keys.length !== allowed.length ||
      !allowed.every((key) => Object.hasOwn(fields, key))) throw new Error();
    if (action === 'begin' || action === 'pending') return { action };
    if (action === 'confirm' || action === 'discard') {
      const candidateId: unknown = fields.candidateId.value;
      if (!validCandidateId(candidateId)) throw new Error();
      if (action === 'discard') return { action, candidateId };
      const postEnabled: unknown = fields.postEnabled.value;
      if (typeof postEnabled !== 'boolean') throw new Error();
      return { action, candidateId, postEnabled };
    }
    const state: unknown = fields.state.value;
    const code: unknown = fields.code.value;
    if (action !== 'complete' || !validText(state) || !validText(code)) {
      throw new Error();
    }
    return { action, state, code };
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid X authorization request');
  }
}

export async function createProductionAuthorizationFlow(): Promise<AuthorizationFlow> {
  const config = readAuthorizationConfig();
  const now = () => Date.now();
  try {
    const expiresAt = now() + config.stateTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error();
    Timestamp.fromMillis(expiresAt);
  } catch {
    throw new AuthorizationConfigError();
  }
  ensureAdminApp();
  const firestore = getFirestore();
  const stores = { firestore, now, encryptionKey: config.encryptionKey };
  const tokenStore = createTokenStore(stores);
  return createAuthorizationFlow({
    stateStore: createStateStore(stores),
    now,
    credentials: config.credentials,
    redirectUri: config.redirectUri,
    stateTtlMs: config.stateTtlMs,
    fetch: (url, init) => globalThis.fetch(url, init),
    stage: (input) => tokenStore.stage(input),
  });
}

export async function createProductionCandidateFlow(): Promise<CandidateFlow> {
  const config = readAuthorizationConfig();
  ensureAdminApp();
  return createCandidateFlow({
    store: createCandidateStore({
      firestore: getFirestore(),
      now: () => Date.now(),
      encryptionKey: config.encryptionKey,
    }),
    fetch: (url, init) => globalThis.fetch(url, init),
    encryptionKey: config.encryptionKey,
  });
}

export async function handleAuthorizationRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  asyncFlowFactory: AuthorizationFlowFactory,
  candidateFactory: CandidateFlowFactory = createProductionCandidateFlow,
): Promise<Result> {
  const uid = request.auth?.uid;
  if (!validText(uid) || uid.length > 128 || uid.includes('/') ||
    uid === '.' || uid === '..' || /^__.*__$/.test(uid)) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const input = parseInput(request.data);
  if (input.action === 'pending' || input.action === 'confirm' ||
    input.action === 'discard') {
    let candidateFlow: CandidateFlow;
    try {
      candidateFlow = await candidateFactory();
    } catch (error) {
      if (error instanceof AuthorizationConfigError) {
        throw new HttpsError('failed-precondition', 'X authorization is not configured');
      }
      throw new HttpsError('internal', 'X authorization failed');
    }
    try {
      if (input.action === 'pending') {
        const pending = await candidateFlow.getPending(uid);
        return {
          pending: pending === null ? null : {
            candidateId: pending.candidateId,
            profile: {
              id: pending.profile.id,
              username: pending.profile.username,
              profileImageUrl: pending.profile.profileImageUrl,
            },
            expiresAt: pending.expiresAt,
          },
        };
      }
      if (input.action === 'confirm') {
        await candidateFlow.confirm(uid, input.candidateId, input.postEnabled);
      } else {
        await candidateFlow.discard(uid, input.candidateId);
      }
      return { ok: true };
    } catch {
      throw new HttpsError('internal', 'X authorization failed');
    }
  }
  let flow: AuthorizationFlow;
  try {
    flow = await asyncFlowFactory();
  } catch (error) {
    if (error instanceof AuthorizationConfigError) {
      throw new HttpsError('failed-precondition', 'X authorization is not configured');
    }
    throw new HttpsError('internal', 'X authorization failed');
  }
  try {
    if (input.action === 'begin') {
      return { authorizationUrl: await flow.begin(uid) };
    }
    const result = await flow.complete(uid, { state: input.state, code: input.code });
    return { candidateId: result.candidateId };
  } catch {
    throw new HttpsError('internal', 'X authorization failed');
  }
}

export const xAuthorization = onCall({
  region: FUNCTIONS_REGION,
  secrets: [X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, X_TOKEN_ENCRYPTION_KEY],
}, (request) => handleAuthorizationRequest(request, createProductionAuthorizationFlow));
