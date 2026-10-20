import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, jstStartOfDay, MS_PER_DAY } from '@shared/index';

import { parseLocalAccountData } from '../../account/localAccountData';

import {
  addLocalConfirmation,
  adoptRemoteActiveSession,
  findActiveSession,
  loadLocalSessions,
  startLocalSession,
  stopLocalSession,
  TIMER_SESSIONS_STORAGE_KEY,
} from '../storage';

describe('タイマーの端末内保存(requirements 3-2。サーバー保存は 5-1b-1・5-1b-2・5-2a)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  describe.each(['', '  ', '\t\n', null, 42, false, {}, []])('不正UID %p', (uid) => {
    it.each(['start', 'adopt'] as const)('%sは書込前にrejectし既存legacyを保持する', async (action) => {
      await startLocalSession(1000, 'legacy', true);
      await stopLocalSession(2000);
      const before = await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY);
      const writeCount = jest.mocked(AsyncStorage.setItem).mock.calls.length;
      const operation = action === 'start'
        ? startLocalSession(3000, 'new', true, uid as string)
        : adoptRemoteActiveSession(3000, {
          sessionId: 'remote', startAt: 3000, checkEnabled: true, confirmations: [], uid: uid as string,
        });
      await expect(operation).rejects.toThrow();
      expect(jest.mocked(AsyncStorage.setItem).mock.calls).toHaveLength(writeCount);
      expect(await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY)).toBe(before);
    });
  });

  it('新規sessionだけにUIDを設定し、停止・応答・再読込でも保持する', async () => {
    await startLocalSession(1000, 'owned', true, 'user-a');
    expect((await loadLocalSessions())[0]).toMatchObject({ uid: 'user-a' });
    await startLocalSession(2000, 'ignored', true, 'user-b');
    expect((await addLocalConfirmation(3000))[0]).toMatchObject({ uid: 'user-a', confirmations: [3000] });
    expect((await stopLocalSession(4000))[0]).toMatchObject({ uid: 'user-a', stopAt: 4000 });
    expect((await loadLocalSessions())[0]).toMatchObject({ uid: 'user-a' });
  });

  it('既存legacyを新規開始時・停止・応答時にも追認しない', async () => {
    await startLocalSession(1000, 'legacy', true);
    await startLocalSession(2000, 'ignored', true, 'user-a');
    await addLocalConfirmation(3000);
    await stopLocalSession(4000);
    await startLocalSession(5000, 'owned', true, 'user-a');
    const sessions = await loadLocalSessions();
    expect(sessions[0]).not.toHaveProperty('uid');
    expect(sessions[1]).toMatchObject({ uid: 'user-a' });
  });

  it('remoteの所有UIDをそのまま取り込む', async () => {
    await adoptRemoteActiveSession(5000, {
      sessionId: 'remote', startAt: 1000, checkEnabled: false, confirmations: [], uid: 'user-b',
    });
    expect((await loadLocalSessions())[0]).toMatchObject({ uid: 'user-b' });
  });

  it('cleanup parserはUIDありをknown、legacy非空をunknownと判定する', async () => {
    await startLocalSession(1000, 'owned', true, 'user-a');
    await stopLocalSession(2000);
    const owned = await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY);
    expect(parseLocalAccountData('user-a', [[TIMER_SESSIONS_STORAGE_KEY, owned]]).ownership).toBe('known');
    await startLocalSession(3000, 'legacy', true);
    const mixed = await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY);
    expect(parseLocalAccountData('user-a', [[TIMER_SESSIONS_STORAGE_KEY, mixed]]).ownership).toBe('unknown');
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
        { startAt: 300, stopAt: 400, sessionId: 's2', checkEnabled: true, confirmations: [] },
      ]),
    );
    expect(await loadLocalSessions()).toEqual([
      { startAt: 300, stopAt: 400, sessionId: 's2', checkEnabled: true, confirmations: [] },
    ]);
  });

  it('checkEnabled・confirmations が無い(5-2b 以前の形)場合は初期値(ON・応答なし)で補う', async () => {
    await AsyncStorage.setItem(
      TIMER_SESSIONS_STORAGE_KEY,
      JSON.stringify([{ startAt: 300, stopAt: 400, sessionId: 's2' }]),
    );
    expect(await loadLocalSessions()).toEqual([
      { startAt: 300, stopAt: 400, sessionId: 's2', checkEnabled: true, confirmations: [] },
    ]);
  });

  it('開始すると stopAt が null のセッションが、渡した sessionId・checkEnabled で追加される', async () => {
    const sessions = await startLocalSession(1000, 'session-1', true);
    expect(sessions).toEqual([
      { startAt: 1000, stopAt: null, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
    expect(findActiveSession(sessions)).toEqual({
      startAt: 1000,
      stopAt: null,
      sessionId: 'session-1',
      checkEnabled: true,
      confirmations: [],
    });
  });

  it('checkEnabled に false を渡すと false で保存される', async () => {
    const sessions = await startLocalSession(1000, 'session-1', false);
    expect(sessions[0]?.checkEnabled).toBe(false);
  });

  it('既に計測中の場合、開始しても二重に追加されない', async () => {
    await startLocalSession(1000, 'session-1', true);
    const sessions = await startLocalSession(2000, 'session-2', true);
    expect(sessions).toEqual([
      { startAt: 1000, stopAt: null, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
  });

  it('停止すると計測中のセッションの stopAt が確定し、sessionId は変わらない', async () => {
    await startLocalSession(1000, 'session-1', true);
    const sessions = await stopLocalSession(5000);
    expect(sessions).toEqual([
      { startAt: 1000, stopAt: 5000, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
    expect(findActiveSession(sessions)).toBeNull();
  });

  it('stopAt を省略すると now で停止する(通常の手動停止)', async () => {
    await startLocalSession(1000, 'session-1', true);
    const sessions = await stopLocalSession(5000);
    expect(sessions[0]?.stopAt).toBe(5000);
  });

  it('stopAt を指定すると、その時刻で停止する(5-2b: 無応答による自動停止。now とは別の値)', async () => {
    await startLocalSession(1000, 'session-1', true);
    const sessions = await stopLocalSession(9000, 4000);
    expect(sessions).toEqual([
      { startAt: 1000, stopAt: 4000, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
  });

  it('計測中のセッションがない場合、停止しても何も変わらない', async () => {
    await startLocalSession(1000, 'session-1', true);
    await stopLocalSession(5000);
    const sessions = await stopLocalSession(9000);
    expect(sessions).toEqual([
      { startAt: 1000, stopAt: 5000, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
  });

  it('保存は AsyncStorage を介して永続化される(再読み込みでも同じ内容)', async () => {
    await startLocalSession(1000, 'session-1', true);
    await stopLocalSession(5000);
    const reloaded = await loadLocalSessions();
    expect(reloaded).toEqual([
      { startAt: 1000, stopAt: 5000, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
    ]);
  });

  describe('「勉強中？」への応答(5-2b)', () => {
    it('計測中のセッションの confirmations に応答時刻が追加される', async () => {
      await startLocalSession(1000, 'session-1', true);
      const sessions = await addLocalConfirmation(4000);
      expect(sessions).toEqual([
        { startAt: 1000, stopAt: null, sessionId: 'session-1', checkEnabled: true, confirmations: [4000] },
      ]);
    });

    it('複数回応答すると confirmations に積み重なる', async () => {
      await startLocalSession(1000, 'session-1', true);
      await addLocalConfirmation(4000);
      const sessions = await addLocalConfirmation(8000);
      expect(sessions[0]?.confirmations).toEqual([4000, 8000]);
    });

    it('計測中のセッションがない場合、応答しても何も変わらない', async () => {
      await startLocalSession(1000, 'session-1', true);
      await stopLocalSession(5000);
      const sessions = await addLocalConfirmation(9000);
      expect(sessions).toEqual([
        { startAt: 1000, stopAt: 5000, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
      ]);
    });
  });

  describe('ロック画面で始まった計測の取り込み(5-3c-5b)', () => {
    it('端末に計測中のセッションが無ければ、渡した値で計測中のセッションを追加する', async () => {
      const sessions = await adoptRemoteActiveSession(5000, {
        sessionId: 'lockscreen-session',
        startAt: 1000,
        checkEnabled: false,
        confirmations: [2000],
      });
      expect(sessions).toEqual([
        { startAt: 1000, stopAt: null, sessionId: 'lockscreen-session', checkEnabled: false, confirmations: [2000] },
      ]);
      expect(await loadLocalSessions()).toEqual(sessions);
    });

    it('端末にすでに計測中のセッションがある場合は何もしない(保険)', async () => {
      await startLocalSession(1000, 'session-1', true);
      const sessions = await adoptRemoteActiveSession(5000, {
        sessionId: 'lockscreen-session',
        startAt: 2000,
        checkEnabled: true,
        confirmations: [],
      });
      expect(sessions).toEqual([
        { startAt: 1000, stopAt: null, sessionId: 'session-1', checkEnabled: true, confirmations: [] },
      ]);
    });
  });

  describe('一覧の整理(5-1b-2。今日と昨日にかかる分だけ残す)', () => {
    it('一昨日より前に停止したセッションは、新しい操作の保存時に取り除かれる', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const twoDaysAgoStopAt = jstStartOfDay(addDays(today, -2)) + 1000; // 一昨日の早い時間に停止

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([
          {
            startAt: twoDaysAgoStopAt - 500,
            stopAt: twoDaysAgoStopAt,
            sessionId: 'old',
            checkEnabled: true,
            confirmations: [],
          },
        ]),
      );

      const sessions = await startLocalSession(todayStart + 1000, 'today-session', true);
      expect(sessions).toEqual([
        {
          startAt: todayStart + 1000,
          stopAt: null,
          sessionId: 'today-session',
          checkEnabled: true,
          confirmations: [],
        },
      ]);
    });

    it('昨日停止したセッションは残る(0:00 をまたいだ計測が今日にも加算されるため)', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const yesterdayStopAt = todayStart - 1000; // 昨日の最後(今日 0:00 の少し前)に停止

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([
          {
            startAt: yesterdayStopAt - MS_PER_DAY,
            stopAt: yesterdayStopAt,
            sessionId: 'yesterday',
            checkEnabled: true,
            confirmations: [],
          },
        ]),
      );

      const sessions = await startLocalSession(todayStart + 1000, 'today-session', true);
      expect(sessions.map((session) => session.sessionId)).toEqual(['yesterday', 'today-session']);
    });

    it('計測中(stopAt が null)のセッションは何日前に開始していても残る', async () => {
      const today = '2026-10-10';
      const todayStart = jstStartOfDay(today);
      const longAgoStartAt = todayStart - 10 * MS_PER_DAY;

      await AsyncStorage.setItem(
        TIMER_SESSIONS_STORAGE_KEY,
        JSON.stringify([
          { startAt: longAgoStartAt, stopAt: null, sessionId: 'still-running', checkEnabled: true, confirmations: [] },
        ]),
      );

      const sessions = await stopLocalSession(todayStart + 1000);
      expect(sessions).toEqual([
        {
          startAt: longAgoStartAt,
          stopAt: todayStart + 1000,
          sessionId: 'still-running',
          checkEnabled: true,
          confirmations: [],
        },
      ]);
    });
  });
});
