import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded, getCurrentUid } from '@/config/firebase';

export type XLinkRequest =
  | { action: 'begin' }
  | { action: 'complete'; state: string; code: string }
  | { action: 'pending' }
  | { action: 'confirm'; candidateId: string; postEnabled: boolean }
  | { action: 'discard'; candidateId: string };

export interface XLinkProfile {
  readonly id: string;
  readonly username: string;
  readonly profileImageUrl: string | null;
}

export interface XLinkPending {
  readonly candidateId: string;
  readonly profile: XLinkProfile;
  readonly expiresAt: number;
}

export interface XLinkApi {
  begin(): Promise<{ authorizationUrl: string }>;
  complete(state: string, code: string): Promise<{ candidateId: string }>;
  getPending(): Promise<{ pending: XLinkPending | null }>;
  confirm(candidateId: string, postEnabled: boolean): Promise<{ ok: true }>;
  discard(candidateId: string): Promise<{ ok: true }>;
}

export interface XLinkApiDependencies {
  /** Returns unwrapped callable response.data. */
  call(request: XLinkRequest): Promise<unknown>;
  getUid(): string | null;
}

const FAILURE = 'x-link-api-failed';
// Defensive transport limits, independent of server expiry policy.
const MAX_TEXT_LENGTH = 16384;
const MAX_CALLBACK_VALUE_LENGTH = 4096;
const MAX_CANDIDATE_ID_LENGTH = 1500;
const MAX_DATE_MS = 8640000000000000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function text(value: unknown, limit = MAX_TEXT_LENGTH): string {
  requireValue(
    typeof value === 'string' && value.trim().length > 0 &&
    value.length <= limit && !CONTROL.test(value),
  );
  return value;
}

function candidateId(value: unknown): string {
  const id = text(value, MAX_CANDIDATE_ID_LENGTH);
  requireValue(/^[A-Za-z0-9_-]+$/.test(id) && !/^__.*__$/.test(id));
  return id;
}

function object(value: unknown): Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function pending(value: unknown): XLinkPending | null {
  if (value === null) return null;
  const data = object(value);
  const profile = object(data.profile);
  requireValue(profile.profileImageUrl === null || typeof profile.profileImageUrl === 'string');
  const expiresAt = data.expiresAt;
  requireValue(
    typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) &&
    expiresAt > 0 && expiresAt <= MAX_DATE_MS,
  );
  return {
    candidateId: candidateId(data.candidateId),
    profile: {
      id: text(profile.id),
      username: text(profile.username),
      profileImageUrl: profile.profileImageUrl,
    },
    expiresAt,
  };
}

/** No browser, storage or native initialization occurs during construction. */
export function createXLinkApi({ call, getUid }: XLinkApiDependencies): XLinkApi {
  async function request<T>(
    build: () => XLinkRequest,
    parse: (data: Record<string, unknown>) => T,
  ): Promise<T> {
    try {
      const body = build();
      const uid = getUid();
      requireValue(typeof uid === 'string' && uid.trim().length > 0);
      const response = await call(body);
      requireValue(getUid() === uid);
      return parse(object(response));
    } catch {
      // Never retain SDK errors, callback values, tokens or causes.
      throw new Error(FAILURE);
    }
  }

  function ok(data: Record<string, unknown>): { ok: true } {
    requireValue(data.ok === true);
    return { ok: true };
  }

  return {
    // URL semantics are validated by authBrowser before opening the browser.
    begin: () => request(() => ({ action: 'begin' }), (data) => ({
      authorizationUrl: text(data.authorizationUrl),
    })),
    complete: (state, code) => request(() => ({
      action: 'complete',
      state: text(state, MAX_CALLBACK_VALUE_LENGTH),
      code: text(code, MAX_CALLBACK_VALUE_LENGTH),
    }), (data) => ({ candidateId: candidateId(data.candidateId) })),
    getPending: () => request(() => ({ action: 'pending' }), (data) => ({
      pending: pending(data.pending),
    })),
    confirm: (id, postEnabled) => request(() => {
      requireValue(typeof postEnabled === 'boolean');
      return { action: 'confirm', candidateId: candidateId(id), postEnabled };
    }, ok),
    discard: (id) => request(() => ({
      action: 'discard', candidateId: candidateId(id),
    }), ok),
  };
}

async function callXAuthorization(request: XLinkRequest): Promise<unknown> {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;
  const callable = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), 'xAuthorization');
  const response = await callable(request);
  return response?.data;
}

export const xLinkApi: XLinkApi = createXLinkApi({
  call: callXAuthorization,
  getUid: getCurrentUid,
});
