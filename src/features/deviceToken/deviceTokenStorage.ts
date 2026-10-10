/**
 * 発行したデバイストークンの期限(expiresAt)と発行先の uid を端末に保存する(5-3a-2。requirements 3-2)。
 * 生のトークンはここには保存しない(Keychain(App Group 共有)にだけ保存する。studySyncAuthContext.ts)。
 * expiresAt・uid は秘密ではないため AsyncStorage に保存してよい。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEVICE_TOKEN_META_STORAGE_KEY = 'deviceToken:meta:v1';

export type DeviceTokenMeta = {
  /** 発行先の uid。今のログインユーザーと違えば作り直す(ensureDeviceToken.ts) */
  uid: string;
  /** デバイストークンの有効期限(epoch ミリ秒。issueDeviceToken Callable が返す値) */
  expiresAt: number;
};

function isValidMeta(value: unknown): value is DeviceTokenMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.uid === 'string' &&
    record.uid.length > 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  );
}

/** 保存されていない・値の形が不正な場合は null を返す(ensureDeviceToken.ts は「期限が分からない」として扱う) */
export async function loadDeviceTokenMeta(): Promise<DeviceTokenMeta | null> {
  const raw = await AsyncStorage.getItem(DEVICE_TOKEN_META_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isValidMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveDeviceTokenMeta(meta: DeviceTokenMeta): Promise<void> {
  await AsyncStorage.setItem(DEVICE_TOKEN_META_STORAGE_KEY, JSON.stringify(meta));
}
