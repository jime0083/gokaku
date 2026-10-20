import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, jstStartOfDay, toJstDateKey, type CheckedStudySession } from '@shared/index';

/**
 * 計測セッションの端末内保存(requirements 3-2)。
 * サーバーへの保存(users/{uid}/sessions)は 5-1b-1(Function)・5-1b-2(この保存からの送信)で行う。
 * 開始時刻(startAt)と停止時刻(stopAt)を保存し、アプリを閉じても
 * 「今 − 開始時刻」で経過時間を計算できるようにする(stopAt が null のセッションが計測中)。
 *
 * sessionId は計測開始時に作る ID(5-1b-2)。サーバーへの送信(停止時)で、開始と同じ sessionId を
 * 使うために、アプリを再起動しても分かるよう保存しているセッションに含める。
 *
 * checkEnabled・confirmations(5-2b。requirements 3-2)は shared/studyCheck.ts の
 * CheckedStudySession と同じ形で持ち、resolveSessionEnd・findPendingCheckAt にそのまま渡せるようにする
 */
export const TIMER_SESSIONS_STORAGE_KEY = 'timer:sessions:v1';

export type LocalStudySession = CheckedStudySession & { sessionId: string; uid?: string };

/**
 * 保存されていた値を検査し、妥当な LocalStudySession に正規化する(妥当でなければ null)。
 * checkEnabled・confirmations が無い・壊れている場合は初期値(ON・応答なし)で補う
 * (5-2b 以前に保存されたセッションの形が残っていても壊れたものとして捨てないため)
 */
function parseSession(value: unknown): LocalStudySession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const startAtOk = typeof record.startAt === 'number' && Number.isFinite(record.startAt);
  const stopAtOk =
    record.stopAt === null || (typeof record.stopAt === 'number' && Number.isFinite(record.stopAt));
  const sessionIdOk = typeof record.sessionId === 'string' && record.sessionId.length > 0;
  if (!startAtOk || !stopAtOk || !sessionIdOk) {
    return null;
  }
  const checkEnabled = typeof record.checkEnabled === 'boolean' ? record.checkEnabled : true;
  const confirmations = Array.isArray(record.confirmations)
    ? record.confirmations.filter(
        (at): at is number => typeof at === 'number' && Number.isFinite(at),
      )
    : [];
  return {
    startAt: record.startAt as number,
    stopAt: record.stopAt as number | null,
    sessionId: record.sessionId as string,
    checkEnabled,
    confirmations,
    ...(typeof record.uid === 'string' ? { uid: record.uid } : {}),
  };
}

/**
 * 「今日の勉強時間」の計算に必要な分(今日と昨日にかかるセッション)だけを残す(5-1b-2)。
 * 0:00 をまたいだ計測は前日にも加算する(requirements 3-1)ため、昨日の開始分(今日より前に
 * 停止した昨日のセッション)まで残す。それより前に停止したセッションは今日の計算に影響しないため取り除く。
 * 計測中(stopAt が null)のセッションは常に残す
 */
function pruneOldSessions(sessions: readonly LocalStudySession[], now: number): LocalStudySession[] {
  const threshold = jstStartOfDay(addDays(toJstDateKey(now), -1));
  return sessions.filter((session) => session.stopAt === null || session.stopAt >= threshold);
}

/** 保存されていたセッション一覧を読み込む(保存がない・壊れている要素は取り除く) */
export async function loadLocalSessions(): Promise<LocalStudySession[]> {
  const raw = await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(parseSession)
      .filter((session): session is LocalStudySession => session !== null);
  } catch {
    return [];
  }
}

async function saveLocalSessions(sessions: readonly LocalStudySession[]): Promise<void> {
  await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

/** 計測中(stopAt が null)のセッションを返す(複数ある想定はしていないため最初の1件) */
export function findActiveSession(sessions: readonly LocalStudySession[]): LocalStudySession | null {
  return sessions.find((session) => session.stopAt === null) ?? null;
}

/**
 * 計測を開始する(requirements 3-2)。既に計測中の場合は何もせず現在の一覧を返す
 * (開始/停止ボタンの連打で二重に開始しないため)。
 * sessionId は呼び出し側(useTimerSession)が作った値を渡す(サーバーへの送信に使うため)。
 * checkEnabled は計測開始時点の「勉強中？」確認の ON/OFF(5-2b。users.checkEnabled を読んだ値)
 */
async function startLocalSessionUnserialized(
  now: number,
  sessionId: string,
  checkEnabled: boolean,
  ownerUid?: string,
): Promise<LocalStudySession[]> {
  if (ownerUid !== undefined && (typeof ownerUid !== 'string' || ownerUid.trim().length === 0)) {
    throw new Error('local-session-invalid-uid');
  }
  const sessions = await loadLocalSessions();
  if (findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions(
    [...sessions, { startAt: now, stopAt: null, sessionId, checkEnabled, confirmations: [],
      ...(ownerUid === undefined ? {} : { uid: ownerUid }) }],
    now,
  );
  await saveLocalSessions(updated);
  return updated;
}

/**
 * 計測を停止する。計測中のセッションがなければ何もしない。
 * stopAt(省略時は now)に停止時刻を設定する。無応答による自動停止(5-2b)では、
 * 実際に無応答が確定した確認の時刻(t_k。now より前)を stopAt に渡す
 */
async function stopLocalSessionUnserialized(
  now: number,
  stopAt: number = now,
): Promise<LocalStudySession[]> {
  const sessions = await loadLocalSessions();
  if (!findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions(
    sessions.map((session) => (session.stopAt === null ? { ...session, stopAt } : session)),
    now,
  );
  await saveLocalSessions(updated);
  return updated;
}

/**
 * ロック画面で始まった計測(App Group の計測中の状態。5-3c-3)を端末の記録に取り込む
 * (5-3c-5b。requirements 3-2「ロック画面で始めた計測は、アプリを開くと続きとして表示する」)。
 * startAt・checkEnabled・confirmations はロック画面側の値をそのまま使う。
 * 端末にすでに計測中のセッションがある場合は何もしない(呼び出し側が「端末が計測していない」ことを
 * 確認してから呼ぶ想定の保険)
 */
async function adoptRemoteActiveSessionUnserialized(
  now: number,
  remote: { sessionId: string; startAt: number; checkEnabled: boolean; confirmations: number[]; uid?: string },
): Promise<LocalStudySession[]> {
  if (remote.uid !== undefined && (typeof remote.uid !== 'string' || remote.uid.trim().length === 0)) {
    throw new Error('local-session-invalid-uid');
  }
  const sessions = await loadLocalSessions();
  if (findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions(
    [
      ...sessions,
      {
        sessionId: remote.sessionId,
        startAt: remote.startAt,
        stopAt: null,
        checkEnabled: remote.checkEnabled,
        confirmations: remote.confirmations,
        ...(remote.uid === undefined ? {} : { uid: remote.uid }),
      },
    ],
    now,
  );
  await saveLocalSessions(updated);
  return updated;
}

/**
 * 「勉強中？」確認への応答(5-2b。requirements 3-2)。計測中のセッションの confirmations に
 * 応答時刻(now)を追加する。計測中のセッションがなければ何もしない
 */
async function addLocalConfirmationUnserialized(now: number): Promise<LocalStudySession[]> {
  const sessions = await loadLocalSessions();
  if (!findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions(
    sessions.map((session) =>
      session.stopAt === null
        ? { ...session, confirmations: [...session.confirmations, now] }
        : session,
    ),
    now,
  );
  await saveLocalSessions(updated);
  return updated;
}

/** JS側の記録更新と旧IDのcleanupを直列化し、新しい開始/停止の書込を失わない。 */
let sessionMutation: Promise<unknown> = Promise.resolve();
function mutateSessions<T>(task: () => Promise<T>): Promise<T> {
  const result = sessionMutation.then(task, task);
  sessionMutation = result.catch(() => undefined);
  return result;
}

/** 置換前に保存したIDsのみ除去。読込await後にも認証・有効目標・停止状態を確認する。 */
export function removeReplacedLocalSessions(
  oldSessionIds: readonly string[],
  guard: () => Promise<void>,
): Promise<void> {
  return mutateSessions(async () => {
    await guard();
    const sessions = await loadLocalSessions();
    await guard();
    const old = new Set(oldSessionIds);
    const kept = sessions.filter((session) => !old.has(session.sessionId));
    if (kept.length !== sessions.length) await saveLocalSessions(kept);
  });
}

export function startLocalSession(...args: Parameters<typeof startLocalSessionUnserialized>): ReturnType<typeof startLocalSessionUnserialized> {
  return mutateSessions(() => startLocalSessionUnserialized(...args));
}

export function stopLocalSession(...args: Parameters<typeof stopLocalSessionUnserialized>): ReturnType<typeof stopLocalSessionUnserialized> {
  return mutateSessions(() => stopLocalSessionUnserialized(...args));
}

export function adoptRemoteActiveSession(...args: Parameters<typeof adoptRemoteActiveSessionUnserialized>): ReturnType<typeof adoptRemoteActiveSessionUnserialized> {
  return mutateSessions(() => adoptRemoteActiveSessionUnserialized(...args));
}

export function addLocalConfirmation(...args: Parameters<typeof addLocalConfirmationUnserialized>): ReturnType<typeof addLocalConfirmationUnserialized> {
  return mutateSessions(() => addLocalConfirmationUnserialized(...args));
}
