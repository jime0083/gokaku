import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFunctions from '@react-native-firebase/functions';
import { FUNCTIONS_REGION } from '@shared/index';

import { connectFirebaseEmulatorsIfNeeded, getCurrentUid } from '@/config/firebase';

export type XNoticeAckResult = { status: 'acknowledged' | 'unchanged' };
export type XNoticeApi = { ack: (noticeId: string) => Promise<XNoticeAckResult> };
export type XNoticeApiDependencies = {
  call: (request: { noticeId: string }) => Promise<unknown>;
  getUid: () => string | null;
};

const FAILURE = 'x-notice-api-failed';

/** Construction never loads native modules or reads authentication. */
export function createXNoticeApi({ call, getUid }: XNoticeApiDependencies): XNoticeApi {
  return {
    async ack(noticeId) {
      try {
        if (typeof noticeId !== 'string' || noticeId.length !== 64 || !/^[0-9a-f]{64}$/.test(noticeId)) {
          throw new Error();
        }
        const uid = getUid();
        if (typeof uid !== 'string' || uid.trim().length === 0) throw new Error();
        const response = await call({ noticeId });
        if (getUid() !== uid) throw new Error();
        if (typeof response !== 'object' || response === null || Array.isArray(response)) {
          throw new Error();
        }
        const status = (response as Record<string, unknown>).status;
        if (status !== 'acknowledged' && status !== 'unchanged') throw new Error();
        return { status };
      } catch {
        throw new Error(FAILURE);
      }
    },
  };
}

async function callAckXNotice(request: { noticeId: string }): Promise<unknown> {
  connectFirebaseEmulatorsIfNeeded();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getFunctions, httpsCallable } = require('@react-native-firebase/functions') as typeof RNFBFunctions;
  const callable = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), 'ackXNotice');
  const response = await callable(request);
  return response?.data;
}

export const xNoticeApi: XNoticeApi = createXNoticeApi({
  call: callAckXNotice,
  getUid: getCurrentUid,
});
