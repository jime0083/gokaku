import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StudySession } from '@shared/index';

/**
 * 計測セッションの端末内保存(requirements 3-2)。
 * サーバーへの保存(sessions コレクション)は 5-1b で実装する。このタスクでは端末内のみ。
 * 開始時刻(startAt)と停止時刻(stopAt)を保存し、アプリを閉じても
 * 「今 − 開始時刻」で経過時間を計算できるようにする(stopAt が null のセッションが計測中)。
 */
export const TIMER_SESSIONS_STORAGE_KEY = 'timer:sessions:v1';

function isValidSession(value: unknown): value is StudySession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const startAtOk = typeof record.startAt === 'number' && Number.isFinite(record.startAt);
  const stopAtOk =
    record.stopAt === null || (typeof record.stopAt === 'number' && Number.isFinite(record.stopAt));
  return startAtOk && stopAtOk;
}

/** 保存されていたセッション一覧を読み込む(保存がない・壊れている要素は取り除く) */
export async function loadLocalSessions(): Promise<StudySession[]> {
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

async function saveLocalSessions(sessions: readonly StudySession[]): Promise<void> {
  await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

/** 計測中(stopAt が null)のセッションを返す(複数ある想定はしていないため最初の1件) */
export function findActiveSession(sessions: readonly StudySession[]): StudySession | null {
  return sessions.find((session) => session.stopAt === null) ?? null;
}

/**
 * 計測を開始する(requirements 3-2)。既に計測中の場合は何もせず現在の一覧を返す
 * (開始/停止ボタンの連打で二重に開始しないため)
 */
export async function startLocalSession(now: number): Promise<StudySession[]> {
  const sessions = await loadLocalSessions();
  if (findActiveSession(sessions)) {
    return sessions;
  }
  const updated: StudySession[] = [...sessions, { startAt: now, stopAt: null }];
  await saveLocalSessions(updated);
  return updated;
}

/** 計測を停止する。計測中のセッションがなければ何もしない */
export async function stopLocalSession(now: number): Promise<StudySession[]> {
  const sessions = await loadLocalSessions();
  if (!findActiveSession(sessions)) {
    return sessions;
  }
  const updated: StudySession[] = sessions.map((session) =>
    session.stopAt === null ? { ...session, stopAt: now } : session,
  );
  await saveLocalSessions(updated);
  return updated;
}
