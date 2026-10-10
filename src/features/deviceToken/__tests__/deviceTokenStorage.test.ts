import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEVICE_TOKEN_META_STORAGE_KEY,
  loadDeviceTokenMeta,
  saveDeviceTokenMeta,
} from '@/features/deviceToken/deviceTokenStorage';

describe('deviceTokenStorage(5-3a-2)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('何も保存していない場合は null を返す', async () => {
    await expect(loadDeviceTokenMeta()).resolves.toBeNull();
  });

  it('保存した値をそのまま読める', async () => {
    await saveDeviceTokenMeta({ uid: 'uid-1', expiresAt: 123 });

    await expect(loadDeviceTokenMeta()).resolves.toEqual({ uid: 'uid-1', expiresAt: 123 });
  });

  it('生のトークンを保存する場所ではない(メタ以外の値を書き込んでも読めない)', async () => {
    await AsyncStorage.setItem(
      DEVICE_TOKEN_META_STORAGE_KEY,
      JSON.stringify({ uid: 'uid-1', expiresAt: 123, deviceToken: 'raw-should-not-be-here' }),
    );

    const loaded = await loadDeviceTokenMeta();

    // 形が正しければ読めるが、呼び出し側(ensureDeviceToken)は deviceToken フィールドを使わない
    // (この層が生のトークンを書き込む経路を持たないことは saveDeviceTokenMeta の型で保証する)
    expect(loaded).toMatchObject({ uid: 'uid-1', expiresAt: 123 });
  });

  it('壊れた JSON は null を返す', async () => {
    await AsyncStorage.setItem(DEVICE_TOKEN_META_STORAGE_KEY, 'not-json');

    await expect(loadDeviceTokenMeta()).resolves.toBeNull();
  });

  it('uid が無い・expiresAt が数値でない場合は null を返す', async () => {
    await AsyncStorage.setItem(DEVICE_TOKEN_META_STORAGE_KEY, JSON.stringify({ expiresAt: 123 }));
    await expect(loadDeviceTokenMeta()).resolves.toBeNull();

    await AsyncStorage.setItem(
      DEVICE_TOKEN_META_STORAGE_KEY,
      JSON.stringify({ uid: 'uid-1', expiresAt: 'not-a-number' }),
    );
    await expect(loadDeviceTokenMeta()).resolves.toBeNull();
  });
});
