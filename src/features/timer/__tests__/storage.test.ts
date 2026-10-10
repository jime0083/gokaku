import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, jstStartOfDay, MS_PER_DAY } from '@shared/index';

import {
  findActiveSession,
  loadLocalSessions,
  startLocalSession,
  stopLocalSession,
  TIMER_SESSIONS_STORAGE_KEY,
} from '../storage';

describe('タイマーの端末内保存(requirements 3-2。サーバー保存は 5-1b-1・5-1b-2)', () => {
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

  it('壊れた要素(startAt が数値でない・sessionId がない)を取り除く', async () => {
    await AsyncStorage.setItem(
      TIMER_SESSIONS_STORAGE_KEY,
      JSON.stringify([
        { startAt: 'oops', stopAt: null, sessionId: 's1' },
        { startAt: 100, stopAt: 200 },
        { startAt: 300, stopAt: 400, sessionId: 's2' },
      ]),
    );
    expect(await loadLocalSessions()).toEqual([{ startAt: 300, stopAt: 400, sessionId: 's2' }]);
  });

  it('開始すると stopAt が null のセッションが、渡した sessionId で追加される', async () => {
    const sessions = await startLocalSession(1000, 'session-1');
    expect(sessions).toEqual([{ startAt: 1000, stopAt: null, sessionId: 'session-1' }]);
    expect(findActiveSession(sessions)).toEqual({
      startAt: 1000,
      stopAt: null,
      sessionId: 'session-1',
    });
  });

  it('既に計測中の場合、開始しても二重に追加されない', async () => {
    await startLocalSession(1000, 'session-1');
    const sessions = await startLocalSession(2000, 'session-2');
    expect(sessions).toEqual([{ startAt: 1000, stopAt: null, sessionId: 'session-1' }]);
  });

  it('停止すると計測中のセッションの stopAt が確定し、sessionId は変わらない', async () => {
    await startLocalSession(1000, 'session-1');
    const sessions = await stopLocalSession(5000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: 5000, sessionId: 'session-1' }]);
    expect(findActiveSession(sessions)).toBeNull();
  });

  it('計測中のセッションがない場合、停止しても何も変わらない', async () => {
    await startLocalSession(1000, 'session-1');
    await stopLocalSession(5000);
    const sessions = await stopLocalSession(9000);
    expect(sessions).toEqual([{ startAt: 1000, stopAt: 5000, sessionId: 'session-1' }]);
  });

  it('保存は AsyncStorage を介して永続化される(再読み込みでも同じ内容)', async () => {
    await startLocalSession(1000, 'session-1');
    await stopLocalSession(5000);
    const reloaded = await loadLocalSessions();
    expect(reloaded).toEqual([{ startAt: 1000, stopAt: 5000, sessionId: 'session-1' }]);
  });

  describe('一覧の整理(5-1b-2。今日と昨日にかかる分だけ残す)', () => {
    it('一昨日より前に停止したセッションは、新しい操作の保存時に取り除かれる', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const twoDaysAgoStopAt = jstStartOfDay(addDays(today, -2)) + 1000; // 一昨日の早い時間に停止

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([
          { startAt: twoDaysAgoStopAt - 500, stopAt: twoDaysAgoStopAt, sessionId: 'old' },
        ]),
      );

      const sessions = await startLocalSession(todayStart + 1000, 'today-session');
      expect(sessions).toEqual([{ startAt: todayStart + 1000, stopAt: null, sessionId: 'today-session' }]);
    });

    it('昨日停止したセッションは残る(0:00 をまたいだ計測が今日にも加算されるため)', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const yesterdayStopAt = todayStart - 1000; // 昨日の最後(今日 0:00 の少し前)に停止

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([
          { startAt: yesterdayStopAt - MS_PER_DAY, stopAt: yesterdayStopAt, sessionId: 'yesterday' },
        ]),
      );

      const sessions = await startLocalSession(todayStart + 1000, 'today-session');
      expect(sessions.map((session) => session.sessionId)).toEqual(['yesterday', 'today-session']);
    });

    it('計測中(stopAt が null)のセッションは何日前に開始していても残る', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const longAgoStartAt = todayStart - 10 * MS_PER_DAY;

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([{ startAt: longAgoStartAt, stopAt: null, sessionId: 'still-running' }]),
      );

      const sessions = await stopLocalSession(todayStart + 1000);
      expect(sessions).toEqual([
        { startAt: longAgoStartAt, stopAt: todayStart + 1000, sessionId: 'still-running' },
      ]);
    });
  });
});
