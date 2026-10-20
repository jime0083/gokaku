import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 「勉強中？」への無応答で自動停止したお知らせ(5-2b。requirements 3-2, 2026-10-10 追記)。
 * タイマー画面の上部に一度だけ表示し、「閉じる」を押すと端末から消して二度と表示しない
 * (次に別の自動停止が起きるまで)。
 */
export const AUTO_STOP_NOTICE_STORAGE_KEY = 'timer:autoStopNotice:v1';

// localAccountData.tsの単件envelope契約。循環importを避け、このwriter内に保持する。
const AUTO_STOP_NOTICE_ENVELOPE_VERSION = 2;

export type AutoStopNotice = {
  uid?: string;
  /** 無応答による自動停止が確定した確認の時刻(t_k。epoch ミリ秒) */
  stoppedAt: number;
};

function isValidNotice(value: unknown): value is AutoStopNotice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.stoppedAt === 'number' && Number.isFinite(record.stoppedAt);
}

/** 保存されているお知らせを読む(保存がない・壊れている場合は null) */
export async function loadAutoStopNotice(): Promise<AutoStopNotice | null> {
  const raw = await AsyncStorage.getItem(AUTO_STOP_NOTICE_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      if (parsed.version !== AUTO_STOP_NOTICE_ENVELOPE_VERSION ||
          typeof parsed.uid !== 'string' || parsed.uid.trim().length === 0 ||
          !isValidNotice(parsed.value)) return null;
      return { stoppedAt: parsed.value.stoppedAt, uid: parsed.uid };
    }
    return isValidNotice(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 無応答による自動停止が確定したときに呼ぶ(次にタイマー画面を開いたときに表示するため保存する) */
export async function writeAutoStopNotice(stoppedAt: number, ownerUid?: string): Promise<void> {
  if (ownerUid !== undefined && (typeof ownerUid !== 'string' || ownerUid.trim().length === 0)) {
    throw new Error('auto-stop-notice-invalid-uid');
  }
  const value = { stoppedAt };
  const notice = ownerUid === undefined ? value : {
    version: AUTO_STOP_NOTICE_ENVELOPE_VERSION, uid: ownerUid, value,
  };
  await AsyncStorage.setItem(AUTO_STOP_NOTICE_STORAGE_KEY, JSON.stringify(notice));
}

/** 「閉じる」が押されたときに呼ぶ(以後、同じお知らせは表示しない) */
export async function clearAutoStopNotice(): Promise<void> {
  await AsyncStorage.removeItem(AUTO_STOP_NOTICE_STORAGE_KEY);
}
