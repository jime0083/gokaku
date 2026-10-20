import type { AsyncStorageStatic } from '@react-native-async-storage/async-storage';
import { DEVICE_TOKEN_META_STORAGE_KEY } from '../deviceToken/deviceTokenStorage';
import { ONBOARDING_DRAFT_STORAGE_KEY } from '../onboarding/storage';
import { INITIAL_ONBOARDING_DRAFT } from '../onboarding/types';
import { AUTO_STOP_NOTICE_STORAGE_KEY } from '../timer/autoStopNotice';
import { TIMER_SESSIONS_STORAGE_KEY } from '../timer/storage';
import { STUDY_EVENT_QUEUE_STORAGE_KEY } from '../timer/studyEventQueue';

export type RawEntry = readonly [key: string, raw: string | null];
export type LocalAccountStore = Pick<AsyncStorageStatic,
  'getAllKeys' | 'getItem' | 'setItem' | 'removeItem'>;
export type LocalAccountGuard = () => Promise<void>;
export type LocalAccountInspection = {
  ownership: 'known' | 'unknown';
  /** 端末共通の計測を守るため、他UIDの計測中も含む。 */
  measuring: boolean;
  /** 同期すべき送信待ちは対象UIDだけ。 */
  pendingRecords: boolean;
  unknownKeys: readonly string[];
};

// replacementStorageの既存キー形式。checkpoint・OS通知許可の要求履歴は含めない。
const REPLACEMENT_PREFIX = 'onboarding:replacement:v1:';
const SINGLE_KEYS = [ONBOARDING_DRAFT_STORAGE_KEY, AUTO_STOP_NOTICE_STORAGE_KEY,
  DEVICE_TOKEN_META_STORAGE_KEY];
const ARRAY_KEYS = [TIMER_SESSIONS_STORAGE_KEY, STUDY_EVENT_QUEUE_STORAGE_KEY];
/** 新しい単件保存だけが使用する形式。旧形式への所有UIDの追認は行わない。 */
export const LOCAL_ACCOUNT_ENVELOPE_VERSION = 2;

type RecordValue = Record<string, unknown>;
type Mutation = { key: string; raw: string | null };
const object = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uidString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const nullableNumber = (value: unknown): boolean => value === null || finite(value);

/** 入力途中も保存するdraft。業務上の入力範囲・日付・必須入力の判定は行わない。 */
function validDraft(value: unknown): boolean {
  if (!object(value)) return false;
  // 既存draftの必須フィールドと型を再利用。補正や初期値へのフォールバックはしない。
  return Object.entries(INITIAL_ONBOARDING_DRAFT).every(([key, initial]) => {
    if (key === 'type') return value[key] === null || value[key] === 'exam' || value[key] === 'cert';
    if (key === 'certId' || key === 'autoFilledTargetHoursText' || key === 'examDate') {
      return nullableString(value[key]);
    }
    if (key === 'minDailyMinutes' || key === 'goalDailyMinutes') return nullableNumber(value[key]);
    return typeof initial === 'number' ? finite(value[key]) : typeof value[key] === typeof initial;
  });
}

function validSession(value: RecordValue): boolean {
  return uidString(value.sessionId) && finite(value.startAt) &&
    nullableNumber(value.stopAt) && typeof value.checkEnabled === 'boolean' &&
    Array.isArray(value.confirmations) && value.confirmations.every(finite);
}
function validEvent(value: RecordValue): boolean {
  return uidString(value.sessionId) && uidString(value.idempotencyKey) && finite(value.clientTimeMs) &&
    (value.action === 'start' || value.action === 'stop' || value.action === 'confirm') &&
    (value.action === 'start' ? typeof value.checkEnabled === 'boolean' :
      value.checkEnabled === undefined || typeof value.checkEnabled === 'boolean');
}
function validReplacement(key: string, value: RecordValue): boolean {
  // decodeURIComponentは壊れたキーでthrowする。呼出側でunknownとして扱う。
  return decodeURIComponent(key.slice(REPLACEMENT_PREFIX.length)) === value.uid &&
    uidString(value.expectedGoalId) && validDraft(value.draft) &&
    (value.committedGoalId === undefined || uidString(value.committedGoalId)) &&
    (value.oldSessionIds === undefined ||
      (Array.isArray(value.oldSessionIds) && value.oldSessionIds.every(uidString)));
}
function managedKey(key: string): boolean {
  return ARRAY_KEYS.includes(key) || SINGLE_KEYS.includes(key) || key.startsWith(REPLACEMENT_PREFIX);
}
function requireUid(uid: string): void {
  if (!uidString(uid)) throw new Error('local-account-invalid-uid');
}

/** 検査とcleanup計画は同じ純粋parserを通す。壊れ値を捨てる既存loaderは呼ばない。 */
function analyze(uid: string, entries: readonly RawEntry[]): {
  inspection: LocalAccountInspection;
  mutations: Mutation[];
} {
  requireUid(uid);
  const unknownKeys = new Set<string>();
  const seen = new Set<string>();
  const mutations: Mutation[] = [];
  let measuring = false;
  let pendingRecords = false;
  for (const [key, raw] of entries) {
    if (!managedKey(key)) continue;
    if (seen.has(key)) unknownKeys.add(key);
    seen.add(key);
    if (raw === null) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (ARRAY_KEYS.includes(key)) {
        if (!Array.isArray(value)) { unknownKeys.add(key); continue; }
        const valid = (item: unknown): item is RecordValue => object(item) && uidString(item.uid) &&
          (key === TIMER_SESSIONS_STORAGE_KEY ? validSession(item) : validEvent(item));
        if (!value.every(valid)) { unknownKeys.add(key); continue; }
        if (key === TIMER_SESSIONS_STORAGE_KEY) {
          measuring ||= value.some((item) => item.stopAt === null);
        } else {
          pendingRecords ||= value.some((item) => item.uid === uid);
        }
        const kept = value.filter((item) => item.uid !== uid);
        if (kept.length !== value.length) {
          mutations.push({ key, raw: kept.length ? JSON.stringify(kept) : null });
        }
        continue;
      }
      if (!object(value) || !uidString(value.uid)) { unknownKeys.add(key); continue; }
      let valid: boolean;
      if (key === DEVICE_TOKEN_META_STORAGE_KEY) {
        valid = finite(value.expiresAt);
      } else if (key.startsWith(REPLACEMENT_PREFIX)) {
        valid = validReplacement(key, value);
      } else {
        valid = value.version === LOCAL_ACCOUNT_ENVELOPE_VERSION &&
          (key === ONBOARDING_DRAFT_STORAGE_KEY ? validDraft(value.value) :
            object(value.value) && finite(value.value.stoppedAt));
      }
      if (!valid) { unknownKeys.add(key); continue; }
      if (value.uid === uid) mutations.push({ key, raw: null });
    } catch {
      unknownKeys.add(key);
    }
  }
  return {
    inspection: { ownership: unknownKeys.size ? 'unknown' : 'known', measuring,
      pendingRecords, unknownKeys: [...unknownKeys] },
    mutations,
  };
}

export function parseLocalAccountData(uid: string, entries: readonly RawEntry[]): LocalAccountInspection {
  return analyze(uid, entries).inspection;
}

/** 呼出側は全通常writerの停止と進行中書込の完了を保証し、blockを終了まで保持する。 */
async function readEntries(store: LocalAccountStore, guard: LocalAccountGuard): Promise<RawEntry[]> {
  await guard();
  const keys = await store.getAllKeys();
  await guard();
  const entries: RawEntry[] = [];
  for (const key of keys) {
    if (!managedKey(key)) continue;
    await guard();
    const raw = await store.getItem(key);
    await guard();
    entries.push([key, raw]);
  }
  return entries;
}

/** cloud処理より前に実行。unknownなら同期・cloud処理へ進まない。 */
export async function inspectLocalAccountData(
  uid: string, store: LocalAccountStore, guard: LocalAccountGuard,
): Promise<LocalAccountInspection> {
  requireUid(uid);
  const entries = await readEntries(store, guard);
  await guard();
  return parseLocalAccountData(uid, entries);
}

/**
 * acquireOperationBlock済みが前提。guardは対象UIDとblockの有効性を検証する。
 * 保存形式の移行・UIDの追認・同期・block取得は行わない。
 * 毎回再読込し、全対象の検査後に対象UIDだけ消去。失敗は伝播し再実行可能。
 * pendingRecordsの同期完了確認はcloud処理前の呼出側の責務。
 */
export async function cleanupLocalAccountData(
  uid: string, store: LocalAccountStore, guard: LocalAccountGuard,
): Promise<void> {
  requireUid(uid);
  const entries = await readEntries(store, guard);
  await guard();
  const { inspection, mutations } = analyze(uid, entries);
  if (inspection.ownership === 'unknown') throw new Error('local-account-data-unknown');
  if (inspection.measuring) throw new Error('local-account-data-measuring');
  for (const { key, raw } of mutations) {
    await guard();
    if (raw === null) await store.removeItem(key);
    else await store.setItem(key, raw);
    await guard();
  }
}
