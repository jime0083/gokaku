import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, jstStartOfDay, toJstDateKey, type StudySession } from '@shared/index';

/**
 * 計測セッションの端末内保存(requirements 3-2)。
 * サーバーへの保存(users/{uid}/sessions)は 5-1b-1(Function)・5-1b-2(この保存からの送信)で行う。
 * 開始時刻(startAt)と停止時刻(stopAt)を保存し、アプリを閉じても
 * 「今 − 開始時刻」で経過時間を計算できるようにする(stopAt が null のセッションが計測中)。
 *
 * sessionId は計測開始時に作る ID(5-1b-2)。サーバーへの送信(停止時)で、開始と同じ sessionId を
 * 使うために、アプリを再起動しても分かるよう保存しているセッションに含める
 */
export const TIMER_SESSIONS_STORAGE_KEY = 'timer:sessions:v1';

export type LocalStudySession = StudySession & { sessionId: string };

function isValidSession(value: unknown): value is LocalStudySession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const startAtOk = typeof record.startAt === 'number' && Number.isFinite(record.startAt);
  const stopAtOk =
    record.stopAt === null || (typeof record.stopAt === 'number' && Number.isFinite(record.stopAt));
  const sessionIdOk = typeof record.sessionId === 'string' && record.sessionId.length > 0;
  return startAtOk && stopAtOk && sessionIdOk;
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
    return parsed.filter(isValidSession);
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
 * sessionId は呼び出し側(useTimerSession)が作った値を渡す(サーバーへの送信に使うため)
 */
export async function startLocalSession(now: number, sessionId: string): Promise<LocalStudySession[]> {
  const sessions = await loadLocalSessions();
  if (findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions([...sessions, { startAt: now, stopAt: null, sessionId }], now);
  await saveLocalSessions(updated);
  return updated;
}

/** 計測を停止する。計測中のセッションがなければ何もしない */
export async function stopLocalSession(now: number): Promise<LocalStudySession[]> {
  const sessions = await loadLocalSessions();
  if (!findActiveSession(sessions)) {
    return sessions;
  }
  const updated = pruneOldSessions(
    sessions.map((session) => (session.stopAt === null ? { ...session, stopAt: now } : session)),
    now,
  );
  await saveLocalSessions(updated);
  return updated;
}
