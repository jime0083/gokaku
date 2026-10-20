/**
 * studyCheckNotifications(5-2c。requirements 3-2)のユニットテスト。
 * expo-notifications は jest.setup.ts でモックする。useTimerSession・タイマー画面と組み合わせた
 * 挙動(開始・停止・確認での予約/取り消し)は timer.test.tsx で確認する。ここでは通知の層そのもの
 * (許可を1回だけ求める・識別子で予約・取り消し・アクションの絞り込み・起動時の応答の二重処理防止)を確認する
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import {
  addStudyCheckConfirmListener,
  cancelStudyCheckNotification,
  configureStudyCheckNotifications,
  consumeLastStudyCheckConfirmOnLaunch,
  isNotificationPermissionGranted,
  requestNotificationPermissionOnce,
  resetStudyCheckNotificationsConfiguredForTest,
  scheduleStudyCheckNotification,
  STUDY_CHECK_ACTION_IDENTIFIER,
  STUDY_CHECK_NOTIFICATION_IDENTIFIER,
} from '@/features/timer/studyCheckNotifications';

function makeResponse(actionIdentifier: string) {
  return {
    actionIdentifier,
    notification: { date: Date.now() / 1000, request: { identifier: 'n1', content: {}, trigger: null } },
  } as unknown as Notifications.NotificationResponse;
}

describe('configureStudyCheckNotifications(5-2c)', () => {
  beforeEach(() => {
    resetStudyCheckNotificationsConfiguredForTest();
    jest.clearAllMocks();
  });

  it('前面では通知を出さないハンドラと、「勉強中」アクション付きのカテゴリを登録する', async () => {
    configureStudyCheckNotifications();

    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
    await expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });

    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ identifier: STUDY_CHECK_ACTION_IDENTIFIER, buttonTitle: '勉強中' })],
    );
  });

  it('何度呼んでも1回だけ設定する', () => {
    configureStudyCheckNotifications();
    configureStudyCheckNotifications();
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  });
});

describe('requestNotificationPermissionOnce(requirements 3-2: 初めて計測を開始したときにだけ許可を求める)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('1回目は許可を求め、2回目以降は求めない', async () => {
    await requestNotificationPermissionOnce();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);

    await requestNotificationPermissionOnce();
    await requestNotificationPermissionOnce();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('isNotificationPermissionGranted', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getPermissionsAsync の granted を返す', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: false });
    expect(await isNotificationPermissionGranted()).toBe(false);
  });
});

describe('予約・取り消し(識別子を使う)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scheduleStudyCheckNotification は固定の識別子で予約する', async () => {
    const checkAtMs = Date.now() + 60 * 60 * 1000;
    await scheduleStudyCheckNotification(checkAtMs);

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
        content: expect.objectContaining({ title: '勉強中？' }),
        trigger: { type: 'timeInterval', seconds: 3600 },
      }),
    );
  });

  it.each(['user-a', ' user-a '])('新規予約の所有UID %pをそのままdataへ保持する', async (uid) => {
    await scheduleStudyCheckNotification(Date.now() + 60_000, uid);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      identifier: STUDY_CHECK_NOTIFICATION_IDENTIFIER,
      content: {
        title: '勉強中？', categoryIdentifier: 'STUDY_CHECK', data: { uid },
      },
    }));
  });

  it('UID省略時はlegacy形式を維持しdataを付加しない', async () => {
    await scheduleStudyCheckNotification(Date.now() + 60_000);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: { title: '勉強中？', categoryIdentifier: 'STUDY_CHECK' },
    }));
  });

  it.each(['', '   ', '\t\n', null, 0, false, {}, []])('不正UID %pはOS操作前にrejectする', async (uid) => {
    await expect(scheduleStudyCheckNotification(Date.now() + 60_000, uid as string))
      .rejects.toThrow('study-check-notification-invalid-uid');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('cancelStudyCheckNotification は同じ識別子を取り消す', async () => {
    await cancelStudyCheckNotification();
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      STUDY_CHECK_NOTIFICATION_IDENTIFIER,
    );
  });
});

describe('通知のアクションへの応答', () => {
  beforeEach(() => jest.clearAllMocks());

  it('addStudyCheckConfirmListener は「勉強中」アクションだけに反応する(既定のタップは無視)', () => {
    let handler: (response: Notifications.NotificationResponse) => void = () => undefined;
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementation((cb) => {
      handler = cb;
      return { remove: jest.fn() };
    });

    const onConfirm = jest.fn();
    addStudyCheckConfirmListener(onConfirm);

    handler(makeResponse('expo.modules.notifications.actions.DEFAULT'));
    expect(onConfirm).not.toHaveBeenCalled();

    handler(makeResponse(STUDY_CHECK_ACTION_IDENTIFIER));
    expect(onConfirm).toHaveBeenCalledWith({ respondedAtMs: expect.any(Number) });
  });

  it('consumeLastStudyCheckConfirmOnLaunch は「勉強中」アクションの応答を返し、読んだ後は消す', () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(
      makeResponse(STUDY_CHECK_ACTION_IDENTIFIER),
    );
    expect(consumeLastStudyCheckConfirmOnLaunch()).toEqual({ respondedAtMs: expect.any(Number) });
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it('同じ応答を2回読んでも2回目は処理しない(getLastNotificationResponse はモックで null を返す想定)', () => {
    (Notifications.getLastNotificationResponse as jest.Mock)
      .mockReturnValueOnce(makeResponse(STUDY_CHECK_ACTION_IDENTIFIER))
      .mockReturnValueOnce(null);

    expect(consumeLastStudyCheckConfirmOnLaunch()).not.toBeNull();
    expect(consumeLastStudyCheckConfirmOnLaunch()).toBeNull();
  });

  it('応答がない、または既定のタップ(アクションではない)なら null', () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(null);
    expect(consumeLastStudyCheckConfirmOnLaunch()).toBeNull();

    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(
      makeResponse('expo.modules.notifications.actions.DEFAULT'),
    );
    expect(consumeLastStudyCheckConfirmOnLaunch()).toBeNull();
  });
});
