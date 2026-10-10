import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AUTO_STOP_NOTICE_STORAGE_KEY,
  clearAutoStopNotice,
  loadAutoStopNotice,
  writeAutoStopNotice,
} from '../autoStopNotice';

describe('autoStopNotice(5-2b: 無応答による自動停止のお知らせ。requirements 3-2, 2026-10-10 追記)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('保存がない場合は null', async () => {
    expect(await loadAutoStopNotice()).toBeNull();
  });

  it('壊れたデータ(JSON でない)の場合は null にフォールバックする', async () => {
    await AsyncStorage.setItem(AUTO_STOP_NOTICE_STORAGE_KEY, '{不正なJSON');
    expect(await loadAutoStopNotice()).toBeNull();
  });

  it('壊れた要素(stoppedAt が数値でない)場合は null', async () => {
    await AsyncStorage.setItem(AUTO_STOP_NOTICE_STORAGE_KEY, JSON.stringify({ stoppedAt: 'oops' }));
    expect(await loadAutoStopNotice()).toBeNull();
  });

  it('書き込んだ値をそのまま読める', async () => {
    await writeAutoStopNotice(12_345);
    expect(await loadAutoStopNotice()).toEqual({ stoppedAt: 12_345 });
  });

  it('後から書き込むと上書きされる(最新の自動停止を表す)', async () => {
    await writeAutoStopNotice(1_000);
    await writeAutoStopNotice(2_000);
    expect(await loadAutoStopNotice()).toEqual({ stoppedAt: 2_000 });
  });

  it('閉じる(clearAutoStopNotice)と消え、以後 null', async () => {
    await writeAutoStopNotice(12_345);
    await clearAutoStopNotice();
    expect(await loadAutoStopNotice()).toBeNull();
  });
});
