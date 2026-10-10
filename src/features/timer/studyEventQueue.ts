import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 送信待ちの開始・停止操作の列(5-1b-2。requirements 3-2「送れなかった操作は端末に溜め、
 * アプリ起動時・他のアプリから戻ったとき・次の操作時に再送する」)。
 * studyEventSender.ts(送信層)だけがこのモジュールを使う。
 */
export const STUDY_EVENT_QUEUE_STORAGE_KEY = 'timer:studyEventQueue:v1';

/**
 * 'start' だけ checkEnabled(計測開始時点の「勉強中？」確認の ON/OFF。5-2b)を必須で持つ
 * (recordStudyEvent が action が 'start' のときだけ checkEnabled を必須で受け取るため)
 */
export type PendingStudyEvent =
  | { sessionId: string; action: 'start'; clientTimeMs: number; idempotencyKey: string; checkEnabled: boolean }
  | { sessionId: string; action: 'stop' | 'confirm'; clientTimeMs: number; idempotencyKey: string };

function isValidPendingEvent(value: unknown): value is PendingStudyEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const baseOk =
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    (record.action === 'start' || record.action === 'stop' || record.action === 'confirm') &&
    typeof record.clientTimeMs === 'number' &&
    Number.isFinite(record.clientTimeMs) &&
    typeof record.idempotencyKey === 'string' &&
    record.idempotencyKey.length > 0;
  if (!baseOk) {
    return false;
  }
  return record.action === 'start' ? typeof record.checkEnabled === 'boolean' : true;
}

async function readQueue(): Promise<PendingStudyEvent[]> {
  const raw = await AsyncStorage.getItem(STUDY_EVENT_QUEUE_STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidPendingEvent);
  } catch {
    return [];
  }
}

async function writeQueue(queue: readonly PendingStudyEvent[]): Promise<void> {
  await AsyncStorage.setItem(STUDY_EVENT_QUEUE_STORAGE_KEY, JSON.stringify(queue));
}

/**
 * 列の読み書き(読む→変更する→書く)を直列化する。
 * 「次の操作」での追加(appendStudyEvent)と、送信の再送(removeStudyEvent)が同時に走っても、
 * 片方の書き込みが失われないようにするための排他制御(単純な Promise チェーンによるロック)
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(task, task);
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** 現在の送信待ちの列(古い順)を読む */
export function loadStudyEventQueue(): Promise<PendingStudyEvent[]> {
  return runExclusive(readQueue);
}

/** 列の末尾に操作を追加する */
export function appendStudyEvent(event: PendingStudyEvent): Promise<void> {
  return runExclusive(async () => {
    const queue = await readQueue();
    await writeQueue([...queue, event]);
  });
}

/** idempotencyKey が一致する操作を列から取り除く(送信できた・送り直しても成功しない場合に呼ぶ) */
export function removeStudyEvent(idempotencyKey: string): Promise<void> {
  return runExclusive(async () => {
    const queue = await readQueue();
    await writeQueue(queue.filter((event) => event.idempotencyKey !== idempotencyKey));
  });
}
