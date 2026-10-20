import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseLocalAccountData } from '../../account/localAccountData';

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

  it.each(['', '  ', '\t\n', null, 42, false, {}, []])('不正UID %pは書込前にrejectする', async (uid) => {
    await writeAutoStopNotice(1000);
    const before = await AsyncStorage.getItem(AUTO_STOP_NOTICE_STORAGE_KEY);
    const writeCount = jest.mocked(AsyncStorage.setItem).mock.calls.length;
    await expect(writeAutoStopNotice(2000, uid as string)).rejects.toThrow();
    expect(jest.mocked(AsyncStorage.setItem).mock.calls).toHaveLength(writeCount);
    expect(await AsyncStorage.getItem(AUTO_STOP_NOTICE_STORAGE_KEY)).toBe(before);
  });

  it('UIDありはv2 envelopeで保存し、loaderとcleanup parserが所有を認識する', async () => {
    await writeAutoStopNotice(12_345, 'user-a');
    const raw = await AsyncStorage.getItem(AUTO_STOP_NOTICE_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ version: 2, uid: 'user-a', value: { stoppedAt: 12_345 } });
    expect(await loadAutoStopNotice()).toEqual({ stoppedAt: 12_345, uid: 'user-a' });
    expect(parseLocalAccountData('user-a', [[AUTO_STOP_NOTICE_STORAGE_KEY, raw]]).ownership).toBe('known');
  });

  it('UIDなしはlegacy形式のままでcleanupのunknownを維持する', async () => {
    await writeAutoStopNotice(12_345);
    const raw = await AsyncStorage.getItem(AUTO_STOP_NOTICE_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ stoppedAt: 12_345 });
    expect(await loadAutoStopNotice()).toEqual({ stoppedAt: 12_345 });
    expect(parseLocalAccountData('user-a', [[AUTO_STOP_NOTICE_STORAGE_KEY, raw]]).ownership).toBe('unknown');
  });

  it.each([
    { version: 1, uid: 'user-a', value: { stoppedAt: 1000 } },
    { version: 2, uid: '', value: { stoppedAt: 1000 } },
    { version: 2, uid: '  ', value: { stoppedAt: 1000 } },
    { version: 2, value: { stoppedAt: 1000 } },
    { version: 2, uid: 'user-a', value: { stoppedAt: 'oops' } },
  ])('壊れたenvelopeは読み込まない: %p', async (value) => {
    await AsyncStorage.setItem(AUTO_STOP_NOTICE_STORAGE_KEY, JSON.stringify(value));
    expect(await loadAutoStopNotice()).toBeNull();
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
