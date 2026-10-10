import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  findActiveSession,
  loadLocalSessions,
  startLocalSession,
  stopLocalSession,
  TIMER_SESSIONS_STORAGE_KEY,
} from '../storage';

describe('タイマーの端末内保存(requirements 3-2。サーバー保存は 5-1b)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('保存がない場合は空配列', async () => {
    expect(await loadLocalSessions()).toEqual([]);
  });

  it('壊れたデータ(JSON でない)の場合は空配列にフォールバックする', async () => {
    await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, '{不正なJSON');
    expect(await loadLocalSessions()).toEqual([]);
  });

  it('壊れた要素(startAt が数値でない)を取り除く', async () => {
    await AsyncStorage.setItem(
      TIMER_SESSIONS_STORAGE_KEY,
      JSON.stringify([{ startAt: 'oops', stopAt: null }, { startAt: 100, stopAt: 200 }]),
    );
    expect(await loadLocalSessions()).toEqual([{ startAt: 100, stopAt: 200 }]);
  });

  it('開始すると stopAt が null のセッションが追加される', async () => {
    const sessions = await startLocalSession(1000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: null }]);
    expect(findActiveSession(sessions)).toEqual({ startAt: 1000, stopAt: null });
  });

  it('既に計測中の場合、開始しても二重に追加されない', async () => {
    await startLocalSession(1000);
    const sessions = await startLocalSession(2000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: null }]);
  });

  it('停止すると計測中のセッションの stopAt が確定する', async () => {
    await startLocalSession(1000);
    const sessions = await stopLocalSession(5000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: 5000 }]);
    expect(findActiveSession(sessions)).toBeNull();
  });

  it('計測中のセッションがない場合、停止しても何も変わらない', async () => {
    await startLocalSession(1000);
    await stopLocalSession(5000);
    const sessions = await stopLocalSession(9000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: 5000 }]);
  });

  it('保存は AsyncStorage を介して永続化される(再読み込みでも同じ内容)', async () => {
    await startLocalSession(1000);
    await stopLocalSession(5000);
    const reloaded = await loadLocalSessions();
    expect(reloaded).toEqual([{ startAt: 1000, stopAt: 5000 }]);
  });
});
