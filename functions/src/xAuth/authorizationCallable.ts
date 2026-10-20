import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from '../config';
import { ensureAdminApp } from '../firebaseAdmin';
import { createAuthorizationFlow, type AuthorizationFlow } from './authorizationFlow';
import {
  AuthorizationConfigError,
  readAuthorizationConfig,
  X_OAUTH_CLIENT_ID,
  X_OAUTH_CLIENT_SECRET,
  X_TOKEN_ENCRYPTION_KEY,
} from './config';
import { createStateStore } from './stateStore';
import { createTokenStore } from './tokenStore';

type Input = { action: 'begin' } | { action: 'complete'; state: string; code: string };
type Result = { authorizationUrl: string } | { candidateId: string };
export type AuthorizationFlowFactory = () => Promise<AuthorizationFlow>;

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
    const allowed = action === 'begin' ? ['action'] : ['action', 'state', 'code'];
    if (keys.length !== allowed.length ||
      !allowed.every((key) => Object.hasOwn(fields, key))) throw new Error();
    if (action === 'begin') return { action };
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

export async function handleAuthorizationRequest(
  request: Pick<CallableRequest<unknown>, 'auth' | 'data'>,
  asyncFlowFactory: AuthorizationFlowFactory,
): Promise<Result> {
  const uid = request.auth?.uid;
  if (!validText(uid) || uid.length > 128 || uid.includes('/') ||
    uid === '.' || uid === '..' || /^__.*__$/.test(uid)) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const input = parseInput(request.data);
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
