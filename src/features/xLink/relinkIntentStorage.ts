import AsyncStorage from '@react-native-async-storage/async-storage';

import { getCurrentUid } from '@/config/firebase';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';

import { parseRelinkIntent, relinkIntentKey } from './relinkIntentData';

const operations = new Map<string, Promise<void>>();

async function runIntentOperation(
  uid: string,
  operation: 'load' | 'save' | 'clear',
): Promise<boolean> {
  const key = relinkIntentKey(uid);
  const assertUid = () => {
    if (getCurrentUid() !== uid) throw new Error('relink-intent-uid-changed');
  };
  assertUid();

  // Reserve ordering at invocation, before asynchronous durable gate admission.
  const previous = operations.get(uid) ?? Promise.resolve();
  const result = accountOperationGate.runNormal(uid, async (lease) => {
    const assertCurrent = () => {
      lease.assertCurrentUid();
      assertUid();
    };
    assertCurrent();
    try {
      await previous;
    } finally {
      assertCurrent();
    }

    let raw: string | null;
    assertCurrent();
    try {
      raw = await AsyncStorage.getItem(key);
    } finally {
      assertCurrent();
    }
    if (raw !== null && parseRelinkIntent(key, raw) === null) {
      throw new Error('relink-intent-data-unknown');
    }
    if (operation === 'load') return raw !== null;

    assertCurrent();
    try {
      if (operation === 'save') {
        await AsyncStorage.setItem(key, JSON.stringify({ version: 1, uid }));
      } else if (raw !== null) {
        await AsyncStorage.removeItem(key);
      }
    } finally {
      assertCurrent();
    }
    return operation === 'save';
  });

  // A rejected later root must not let subsequent calls bypass an earlier root.
  // allSettled attaches rejection handlers immediately and waits for both.
  const settled = Promise.allSettled([previous, result]).then(() => undefined);
  operations.set(uid, settled);
  void settled.then(() => {
    if (operations.get(uid) === settled) operations.delete(uid);
  });

  try {
    return await result;
  } finally {
    assertUid();
  }
}

export function loadRelinkIntent(uid: string): Promise<boolean> {
  return runIntentOperation(uid, 'load');
}

export async function saveRelinkIntent(uid: string): Promise<void> {
  await runIntentOperation(uid, 'save');
}

export async function clearRelinkIntent(uid: string): Promise<void> {
  await runIntentOperation(uid, 'clear');
}
