import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { createAccountOperationGate } from '../../account/accountOperationGate';

import * as timerNotice from '../autoStopNotice';
import * as timerStorage from '../storage';

let mockAccountGate: ReturnType<typeof createAccountOperationGate>;
const mockReadBlocked = jest.fn<Promise<boolean>, []>();

const mockGetCurrentUid = jest.fn<string | null, []>();
const mockFetchCheckEnabled = jest.fn();
const mockRequestPermission = jest.fn();
const mockEnqueue = jest.fn();
const mockFlush = jest.fn();
const mockNativeStart = jest.fn();
const mockScheduleNotification = jest.fn();

jest.mock('@/config/firebase', () => ({ getCurrentUid: mockGetCurrentUid }));
jest.mock('@/features/account/accountOperationRuntime', () => ({
  get accountOperationGate() { return mockAccountGate; },
}));
jest.mock('../checkEnabledRepository', () => ({ fetchCheckEnabled: mockFetchCheckEnabled }));
jest.mock('../studyEventSender', () => ({
  enqueueAndSendStudyEvent: mockEnqueue, flushStudyEventQueue: mockFlush,
}));
jest.mock('../lockscreenSync', () => ({
  addNativeConfirmation: jest.fn(),
  notifyNativeMeasurementStart: mockNativeStart,
  notifyNativeMeasurementStop: jest.fn(async () => undefined),
  reconcileWithLockscreen: jest.fn(async (sessions: unknown) => ({ sessions, changed: false })),
  rememberCheckEnabledSetting: jest.fn(),
}));
jest.mock('../studyCheckDevOverride', () => ({
  getStudyCheckTiming: () => ({ intervalMs: 60 * 60_000, responseWindowMs: 10 * 60_000 }),
}));
jest.mock('../studyCheckNotifications', () => ({
  addStudyCheckConfirmListener: jest.fn(() => ({ remove: jest.fn() })),
  cancelStudyCheckNotification: jest.fn(async () => undefined),
  configureStudyCheckNotifications: jest.fn(),
  consumeLastStudyCheckConfirmOnLaunch: jest.fn(() => null),
  requestNotificationPermissionOnce: mockRequestPermission,
  scheduleStudyCheckNotification: mockScheduleNotification,
}));

// factoryが参照するmock初期化後にhookを読む。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useTimerSession } = require('../useTimerSession') as typeof import('../useTimerSession');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startLocalSession, loadLocalSessions } = require('../storage') as typeof import('../storage');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadAutoStopNotice } = require('../autoStopNotice') as typeof import('../autoStopNotice');

const START_AT = new Date('2026-10-17T10:00:00+09:00').getTime();

beforeEach(() => {
  jest.clearAllMocks();
  mockReadBlocked.mockReset().mockResolvedValue(false);
  mockAccountGate = createAccountOperationGate({
    getCurrentUid: mockGetCurrentUid,
    getAccountCompletionConfirmed: () => false,
    readDurableBlocked: mockReadBlocked,
  });
  jest.useFakeTimers();
  jest.setSystemTime(START_AT);
  mockGetCurrentUid.mockReset().mockReturnValue('user-a');
  mockFetchCheckEnabled.mockReset().mockResolvedValue(true);
  mockRequestPermission.mockReset().mockResolvedValue(undefined);
  mockEnqueue.mockReset().mockResolvedValue(undefined);
  mockFlush.mockReset().mockResolvedValue(undefined);
  mockNativeStart.mockReset().mockResolvedValue(undefined);
  mockScheduleNotification.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await cleanup();
  await AsyncStorage.clear();
  jest.useRealTimers();
});

async function openHook() {
  const hook = await renderHook(() => useTimerSession());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

it('開始UIDをsessionと開始eventで共有する', async () => {
  const hook = await openHook();
  await act(async () => { await hook.result.current.start(); });
  const session = (await loadLocalSessions())[0];
  expect(session?.uid).toBe('user-a');
  expect(mockEnqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
    sessionId: session?.sessionId, action: 'start', clientTimeMs: START_AT, uid: 'user-a',
  }));
});

it.each(['permission', 'settings'])('開始の%s await中にUID変更ならsession/eventを書かない', async (boundary) => {
  mockGetCurrentUid.mockReturnValue('user-a');
  const hook = await openHook();
  const switchUid = async () => { mockGetCurrentUid.mockReturnValue('user-b'); return true; };
  if (boundary === 'permission') mockRequestPermission.mockImplementationOnce(switchUid);
  else mockFetchCheckEnabled.mockImplementationOnce(switchUid);
  await act(async () => { await expect(hook.result.current.start()).rejects.toThrow(); });
  expect(await loadLocalSessions()).toEqual([]);
  expect(mockNativeStart).not.toHaveBeenCalled();
  expect(mockEnqueue).not.toHaveBeenCalled();
});

it.each(['user-a', undefined])('停止eventは元session UID %pを保持し現在UIDで補完しない', async (uid) => {
  await startLocalSession(START_AT, 'seed', false, uid);
  mockGetCurrentUid.mockReturnValue('user-a');
  const hook = await openHook();
  await act(async () => { await hook.result.current.stop(); });
  expect(mockEnqueue.mock.calls[mockEnqueue.mock.calls.length - 1]?.[0]).toEqual({
    sessionId: 'seed', action: 'stop', clientTimeMs: START_AT,
    ...(uid === undefined ? {} : { uid }),
  });
  expect((await loadLocalSessions())[0]?.uid).toBe(uid);
});

it.each(['user-a', undefined])('確認eventは元session UID %pを保持する', async (uid) => {
  await startLocalSession(START_AT, 'seed', true, uid);
  jest.setSystemTime(START_AT + 65 * 60_000);
  mockGetCurrentUid.mockReturnValue('user-a');
  const hook = await openHook();
  await act(async () => { await hook.result.current.confirm(); });
  expect(mockEnqueue.mock.calls[mockEnqueue.mock.calls.length - 1]?.[0]).toEqual({
    sessionId: 'seed', action: 'confirm', clientTimeMs: START_AT + 65 * 60_000,
    ...(uid === undefined ? {} : { uid }),
  });
});

it.each(['user-a', undefined])('自動停止event/noticeは元session UID %pを保持する', async (uid) => {
  await startLocalSession(START_AT, 'seed', true, uid);
  jest.setSystemTime(START_AT + 71 * 60_000);
  mockGetCurrentUid.mockReturnValue('user-a');
  const hook = await openHook();
  await waitFor(() => expect(hook.result.current.autoStopNotice).not.toBeNull());
  const expected = { stoppedAt: START_AT + 60 * 60_000, ...(uid === undefined ? {} : { uid }) };
  expect(hook.result.current.autoStopNotice).toEqual(expected);
  expect(await loadAutoStopNotice()).toEqual(expected);
  expect(mockEnqueue.mock.calls[mockEnqueue.mock.calls.length - 1]?.[0]).toEqual({
    sessionId: 'seed', action: 'stop', clientTimeMs: START_AT + 60 * 60_000,
    ...(uid === undefined ? {} : { uid }),
  });
});

it('session保存await中にUID変更でも保存UIDを改変せず、native/start eventへ進まない', async () => {
  mockGetCurrentUid.mockReturnValue('user-a');
  const hook = await openHook();
  const originalStart = timerStorage.startLocalSession;
  const startSpy = jest.spyOn(timerStorage, 'startLocalSession').mockImplementation(async (...args) => {
    const sessions = await originalStart(...args);
    mockGetCurrentUid.mockReturnValue('user-b');
    return sessions;
  });
  try {
    await act(async () => { await expect(hook.result.current.start()).rejects.toThrow(); });
    expect((await loadLocalSessions())[0]?.uid).toBe('user-a');
    expect(mockNativeStart).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  } finally {
    startSpy.mockRestore();
  }
});

it.each(['user-a', undefined])('確認通知は元session UID %pのみを使い現在UIDで補完しない', async (uid) => {
  await startLocalSession(START_AT, 'seed', true, uid);
  mockGetCurrentUid.mockReturnValue('user-a');
  await openHook();
  await waitFor(() => expect(mockScheduleNotification).toHaveBeenCalledWith(
    START_AT + 60 * 60_000, uid,
  ));
  expect((await loadLocalSessions())[0]?.uid).toBe(uid);
});

describe('normal producer gate', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function prepare(operation: 'start' | 'stop' | 'confirm') {
    if (operation !== 'start') {
      await startLocalSession(START_AT, 'seed', operation === 'confirm', 'user-a');
    }
    if (operation === 'confirm') jest.setSystemTime(START_AT + 65 * 60_000);
    return openHook();
  }

  it.each(['start', 'stop', 'confirm'] as const)(
    'account waits for %s and refuses new roots while waiting',
    async (operation) => {
      const hook = await prepare(operation);
      const send = deferred();
      mockEnqueue.mockClear().mockReturnValueOnce(send.promise);
      let running!: Promise<void>;
      await act(async () => { running = hook.result.current[operation](); });
      let entered = false;
      let acquired: Promise<unknown> | undefined;
      try {
        await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(1));
        const lease = mockEnqueue.mock.calls[0][1];
        expect(lease).toBeDefined();
        expect(() => lease.assertCurrentUid()).not.toThrow();
        expect(hook.result.current.isRunning).toBe(operation !== 'stop');
        if (operation === 'confirm') expect(hook.result.current.pendingCheck).toBe(false);
        if (operation === 'start' || operation === 'confirm') {
          expect(mockScheduleNotification).toHaveBeenCalledWith(
            START_AT + (operation === 'start' ? 60 : 120) * 60_000, 'user-a',
          );
        } else {
          const notifications = jest.requireMock('../studyCheckNotifications');
          expect(notifications.cancelStudyCheckNotification).toHaveBeenCalled();
        }
        acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
        await act(async () => { await Promise.resolve(); });
        expect(entered).toBe(false);
        await act(async () => {
          await expect(hook.result.current[operation]()).rejects.toThrow('normal-blocked');
        });
        await act(async () => { send.resolve(); await running; });
        await acquired;
        expect(entered).toBe(true);
        expect(() => lease.assertCurrentUid()).toThrow('expired-lease');
      } finally {
        send.resolve();
        await running.catch(() => undefined);
        if (acquired) {
          await acquired;
          await mockAccountGate.releaseAccount('user-a');
        }
      }
    },
  );

  it.each(['start', 'stop', 'confirm'] as const)(
    'auth null %s has no mutation effects',
    async (operation) => {
      const hook = await prepare(operation);
      const before = await loadLocalSessions();
      mockGetCurrentUid.mockReturnValue(null);
      jest.clearAllMocks();
      await act(async () => { await hook.result.current[operation](); });
      expect(await loadLocalSessions()).toEqual(before);
      expect(mockRequestPermission).not.toHaveBeenCalled();
      expect(mockFetchCheckEnabled).not.toHaveBeenCalled();
      expect(mockNativeStart).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockScheduleNotification).not.toHaveBeenCalled();
      const native = jest.requireMock('../lockscreenSync');
      expect(native.notifyNativeMeasurementStop).not.toHaveBeenCalled();
      expect(native.addNativeConfirmation).not.toHaveBeenCalled();
      expect(native.rememberCheckEnabledSetting).not.toHaveBeenCalled();
      const notifications = jest.requireMock('../studyCheckNotifications');
      expect(notifications.cancelStudyCheckNotification).not.toHaveBeenCalled();
    },
  );

  it.each(['start', 'stop', 'confirm'] as const)(
    'durable block refuses %s before effects',
    async (operation) => {
      const hook = await prepare(operation);
      const before = await loadLocalSessions();
      jest.clearAllMocks();
      mockReadBlocked.mockResolvedValue(true);
      await act(async () => {
        await expect(hook.result.current[operation]()).rejects.toThrow('normal-blocked');
      });
      expect(await loadLocalSessions()).toEqual(before);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockRequestPermission).not.toHaveBeenCalled();
      expect(mockNativeStart).not.toHaveBeenCalled();
      expect(mockScheduleNotification).not.toHaveBeenCalled();
    },
  );

  it('native failure preserves the ordinary start record', async () => {
    const hook = await openHook();
    mockNativeStart.mockRejectedValueOnce(new Error('native unavailable'));
    await act(async () => { await hook.result.current.start(); });
    expect((await loadLocalSessions())[0]?.uid).toBe('user-a');
    expect(hook.result.current.isRunning).toBe(true);
    expect(mockEnqueue).toHaveBeenCalled();
    expect(mockScheduleNotification).toHaveBeenCalled();
  });

  it('a failed sender still settles the native child before releasing its root', async () => {
    const hook = await openHook();
    const native = deferred();
    const failure = new Error('sender failure');
    mockNativeStart.mockReturnValueOnce(native.promise);
    mockEnqueue.mockRejectedValueOnce(failure);
    let outcome!: Promise<unknown>;
    await act(async () => {
      outcome = hook.result.current.start().then(
        () => undefined,
        (error: unknown) => error,
      );
    });
    let entered = false;
    const acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
    try {
      await act(async () => { await Promise.resolve(); });
      expect(entered).toBe(false);
      expect(hook.result.current.isRunning).toBe(true);
      expect(mockScheduleNotification).toHaveBeenCalled();
      await act(async () => { native.resolve(); });
      expect(await outcome).toBe(failure);
      await acquired;
      expect(entered).toBe(true);
    } finally {
      native.resolve();
      await outcome;
      await acquired;
      await mockAccountGate.releaseAccount('user-a');
    }
  });
});

describe('P077 public ownership', () => {
  async function finishStartup() {
    await act(async () => {
      await mockAccountGate.acquireAccount('user-a');
      await mockAccountGate.releaseAccount('user-a');
    });
  }

  function expectNoMutationEffects() {
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockFetchCheckEnabled).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockNativeStart).not.toHaveBeenCalled();
    expect(mockScheduleNotification).not.toHaveBeenCalled();
    const native = jest.requireMock('../lockscreenSync');
    expect(native.notifyNativeMeasurementStop).not.toHaveBeenCalled();
    expect(native.addNativeConfirmation).not.toHaveBeenCalled();
    expect(native.rememberCheckEnabledSetting).not.toHaveBeenCalled();
    const notifications = jest.requireMock('../studyCheckNotifications');
    expect(notifications.cancelStudyCheckNotification).not.toHaveBeenCalled();
  }

  it.each(['start', 'stop', 'confirm'] as const)(
    'known owner mismatch rejects %s before every mutation effect',
    async (operation) => {
      await startLocalSession(START_AT, 'owned-a', operation === 'confirm', 'user-a');
      if (operation === 'confirm') jest.setSystemTime(START_AT + 65 * 60_000);
      const hook = await openHook();
      await finishStartup();
      const before = await loadLocalSessions();
      const pendingBefore = hook.result.current.pendingCheck;
      const startSpy = jest.spyOn(timerStorage, 'startLocalSession');
      const stopSpy = jest.spyOn(timerStorage, 'stopLocalSession');
      const confirmSpy = jest.spyOn(timerStorage, 'addLocalConfirmation');
      try {
        mockGetCurrentUid.mockReturnValue('user-b');
        jest.clearAllMocks();
        await act(async () => {
          await expect(hook.result.current[operation]()).rejects.toThrow(
            'timer-session-owner-mismatch',
          );
        });
        expect(await loadLocalSessions()).toEqual(before);
        expect(hook.result.current.isRunning).toBe(true);
        expect(hook.result.current.pendingCheck).toBe(pendingBefore);
        expect(startSpy).not.toHaveBeenCalled();
        expect(stopSpy).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        expectNoMutationEffects();
      } finally {
        startSpy.mockRestore();
        stopSpy.mockRestore();
        confirmSpy.mockRestore();
      }
    },
  );

  it.each(['stop', 'confirm'] as const)(
    'legacy %s under Auth B preserves undefined ownership',
    async (operation) => {
      await startLocalSession(START_AT, 'legacy', operation === 'confirm');
      if (operation === 'confirm') jest.setSystemTime(START_AT + 65 * 60_000);
      const hook = await openHook();
      await finishStartup();
      mockGetCurrentUid.mockReturnValue('user-b');
      jest.clearAllMocks();
      await act(async () => { await hook.result.current[operation](); });
      const stored = (await loadLocalSessions())[0];
      expect(stored).not.toHaveProperty('uid');
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [event, lease] = mockEnqueue.mock.calls[0];
      expect(event).toEqual({
        sessionId: 'legacy',
        action: operation,
        clientTimeMs: START_AT + (operation === 'confirm' ? 65 * 60_000 : 0),
      });
      expect(event).not.toHaveProperty('uid');
      expect(lease).toBeDefined();
      expect(() => lease.assertCurrentUid()).toThrow('expired-lease');
      if (operation === 'stop') expect(stored.stopAt).toBe(START_AT);
      else expect(stored.confirmations).toEqual([START_AT + 65 * 60_000]);
    },
  );

  it('start with an existing legacy active session has no mutation effects', async () => {
    await startLocalSession(START_AT, 'legacy', false);
    const hook = await openHook();
    await finishStartup();
    const before = await loadLocalSessions();
    mockGetCurrentUid.mockReturnValue('user-b');
    jest.clearAllMocks();
    await act(async () => { await hook.result.current.start(); });
    expect(await loadLocalSessions()).toEqual(before);
    expect((await loadLocalSessions())[0]).not.toHaveProperty('uid');
    expectNoMutationEffects();
  });
});

describe('background timer gate', () => {
  let confirmationListener: ((response: { respondedAtMs: number }) => void) | undefined;
  let foreground: (state: AppStateStatus) => void;
  let appStateSpy: jest.SpyInstance;
  const native = () => jest.requireMock('../lockscreenSync');
  const notifications = () => jest.requireMock('../studyCheckNotifications');
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  function respond() {
    if (!confirmationListener) throw new Error('Study check listener was not registered');
    confirmationListener({ respondedAtMs: Date.now() });
  }
  async function idle() {
    await act(async () => {
      await mockAccountGate.acquireAccount('user-a');
      await mockAccountGate.releaseAccount('user-a');
    });
  }
  beforeEach(() => {
    confirmationListener = undefined;
    notifications().addStudyCheckConfirmListener.mockImplementation(
      (listener: (response: { respondedAtMs: number }) => void) => {
        confirmationListener = listener;
        return {
          remove: jest.fn(() => {
            if (confirmationListener === listener) confirmationListener = undefined;
          }),
        };
      },
    );
    native().reconcileWithLockscreen.mockReset().mockImplementation(
      async (sessions: timerStorage.LocalStudySession[]) => ({ sessions, changed: false }),
    );
    native().notifyNativeMeasurementStop.mockReset().mockResolvedValue(undefined);
    notifications().consumeLastStudyCheckConfirmOnLaunch.mockReset().mockReturnValue(null);
    appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      foreground = listener;
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    appStateSpy.mockRestore();
    confirmationListener = undefined;
    notifications().addStudyCheckConfirmListener.mockImplementation(
      () => ({ remove: jest.fn() }),
    );
  });

  it.each(['startup', 'foreground'] as const)('waits for %s flush', async (mode) => {
    const hold = deferred();
    let hook;
    if (mode === 'startup') {
      mockFlush.mockReturnValueOnce(hold.promise);
      hook = await openHook();
    } else {
      hook = await openHook();
      await idle();
      jest.clearAllMocks();
      mockFlush.mockReturnValueOnce(hold.promise);
      await act(async () => { foreground('active'); });
    }
    let acquired: Promise<unknown> | undefined;
    let entered = false;
    try {
      await waitFor(() => expect(mockFlush).toHaveBeenCalledTimes(1));
      const lease = mockFlush.mock.calls[0][0];
      expect(lease).toBeDefined();
      expect(() => lease.assertCurrentUid()).not.toThrow();
      expect(native().reconcileWithLockscreen.mock.calls[0][2]).toBe('user-a');
      expect(native().reconcileWithLockscreen.mock.calls[0][3]).toBe(lease);
      acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
      await act(async () => { foreground('active'); });
      expect(entered).toBe(false);
      expect(native().reconcileWithLockscreen).toHaveBeenCalledTimes(1);
      await act(async () => {
        await expect(hook.result.current.start()).rejects.toThrow('normal-blocked');
      });
      hold.resolve();
      await act(async () => { await acquired; });
      expect(entered).toBe(true);
      expect(() => lease.assertCurrentUid()).toThrow('expired-lease');
    } finally {
      hold.resolve();
      if (acquired) {
        await acquired;
        await mockAccountGate.releaseAccount('user-a');
      }
    }
  });

  it.each([
    { mode: 'launch', uid: 'user-a' },
    { mode: 'listener', uid: 'user-a' },
    { mode: 'launch', uid: undefined },
    { mode: 'listener', uid: undefined },
  ] as const)('$mode confirmation preserves owner $uid and holds its lease', async ({ mode, uid }) => {
    await startLocalSession(START_AT, 'confirm-seed', true, uid);
    jest.setSystemTime(START_AT + 65 * 60_000);
    const hold = deferred();
    let hook;
    if (mode === 'launch') {
      notifications().consumeLastStudyCheckConfirmOnLaunch.mockReturnValueOnce({
        respondedAtMs: Date.now(),
      });
      mockEnqueue.mockReturnValueOnce(hold.promise);
      hook = await openHook();
    } else {
      hook = await openHook();
      await idle();
      mockEnqueue.mockClear().mockReturnValueOnce(hold.promise);
      await act(async () => { respond(); });
    }
    let acquired: Promise<unknown> | undefined;
    let entered = false;
    try {
      await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(1));
      const [event, lease] = mockEnqueue.mock.calls[0];
      expect(event).toEqual({
        sessionId: 'confirm-seed', action: 'confirm',
        clientTimeMs: START_AT + 65 * 60_000,
        ...(uid === undefined ? {} : { uid }),
      });
      expect((await loadLocalSessions())[0]?.uid).toBe(uid);
      if (uid === undefined) expect(event).not.toHaveProperty('uid');
      expect(lease).toBeDefined();
      if (mode === 'launch') expect(mockFlush.mock.calls[0][0]).toBe(lease);
      expect(hook.result.current.pendingCheck).toBe(false);
      expect(mockScheduleNotification).toHaveBeenCalledWith(START_AT + 120 * 60_000, uid);
      acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
      await act(async () => { respond(); });
      expect(entered).toBe(false);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      hold.resolve();
      await act(async () => { await acquired; });
      expect(entered).toBe(true);
      expect(() => lease.assertCurrentUid()).toThrow('expired-lease');
    } finally {
      hold.resolve();
      if (acquired) {
        await acquired;
        await mockAccountGate.releaseAccount('user-a');
      }
    }
  });

  it.each(['startup', 'foreground', 'listener', 'autostop', 'dismiss'] as const)(
    '%s refuses a known foreign owner before mutation effects',
    async (mode) => {
      if (mode === 'dismiss') await timerNotice.writeAutoStopNotice(START_AT, 'user-a');
      else await startLocalSession(START_AT, 'owned-a', mode === 'listener' || mode === 'autostop', 'user-a');
      if (mode === 'listener') jest.setSystemTime(START_AT + 65 * 60_000);
      const before = await loadLocalSessions();
      if (mode === 'startup') mockGetCurrentUid.mockReturnValue('user-b');
      const hook = await openHook();
      if (mode !== 'startup') await idle();
      mockGetCurrentUid.mockReturnValue('user-b');
      jest.clearAllMocks();
      await act(async () => {
        if (mode === 'foreground') foreground('active');
        if (mode === 'listener') respond();
        if (mode === 'autostop') {
          jest.setSystemTime(START_AT + 71 * 60_000);
          jest.advanceTimersByTime(1000);
        }
        if (mode === 'dismiss') {
          await expect(hook.result.current.dismissAutoStopNotice()).rejects.toThrow(
            'timer-session-owner-mismatch',
          );
        }
      });
      expect(await loadLocalSessions()).toEqual(before);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockFlush).not.toHaveBeenCalled();
      expect(native().notifyNativeMeasurementStop).not.toHaveBeenCalled();
      expect(native().addNativeConfirmation).not.toHaveBeenCalled();
      expect(mockScheduleNotification).not.toHaveBeenCalled();
      expect(notifications().cancelStudyCheckNotification).not.toHaveBeenCalled();
      if (mode === 'dismiss') {
        expect(await loadAutoStopNotice()).toEqual({ stoppedAt: START_AT, uid: 'user-a' });
      }
    },
  );

  it.each(['null', 'blocked', 'unknown'] as const)(
    'startup %s admits no mutation and handles rejection',
    async (state) => {
      await startLocalSession(START_AT, 'owned-a', true, 'user-a');
      const before = await loadLocalSessions();
      jest.clearAllMocks();
      if (state === 'null') mockGetCurrentUid.mockReturnValue(null);
      if (state === 'blocked') mockReadBlocked.mockResolvedValue(true);
      if (state === 'unknown') mockReadBlocked.mockRejectedValue(new Error('unreadable'));
      await openHook();
      expect(await loadLocalSessions()).toEqual(before);
      expect(native().reconcileWithLockscreen).not.toHaveBeenCalled();
      expect(mockFlush).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(notifications().cancelStudyCheckNotification).not.toHaveBeenCalled();
    },
  );

  it('autostop settles a pending native child after sender rejection', async () => {
    await startLocalSession(START_AT, 'auto-seed', true, 'user-a');
    jest.setSystemTime(START_AT + 71 * 60_000);
    const hold = deferred();
    native().notifyNativeMeasurementStop.mockReturnValueOnce(hold.promise);
    mockEnqueue.mockRejectedValueOnce(new Error('sender failed'));
    const hook = await openHook();
    let acquired: Promise<unknown> | undefined;
    let entered = false;
    try {
      await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(1));
      const lease = mockEnqueue.mock.calls[0][1];
      expect(lease).toBeDefined();
      expect(hook.result.current.isRunning).toBe(false);
      expect((await loadLocalSessions())[0]?.stopAt).toBe(START_AT + 60 * 60_000);
      expect(await loadAutoStopNotice()).toEqual({
        stoppedAt: START_AT + 60 * 60_000, uid: 'user-a',
      });
      expect(notifications().cancelStudyCheckNotification).toHaveBeenCalled();
      acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
      await act(async () => { await Promise.resolve(); });
      expect(entered).toBe(false);
      hold.resolve();
      await act(async () => { await acquired; });
      expect(entered).toBe(true);
      expect(() => lease.assertCurrentUid()).toThrow('expired-lease');
    } finally {
      hold.resolve();
      if (acquired) {
        await acquired;
        await mockAccountGate.releaseAccount('user-a');
      }
    }
  });

  it('dismissal holds its lease through persistence and rejects a competing dismissal', async () => {
    await timerNotice.writeAutoStopNotice(START_AT, 'user-a');
    const hook = await openHook();
    await idle();
    const hold = deferred();
    const originalClear = timerNotice.clearAutoStopNotice;
    const spy = jest.spyOn(timerNotice, 'clearAutoStopNotice').mockImplementation(async () => {
      await hold.promise;
      await originalClear();
    });
    let dismissal!: Promise<void>;
    let acquired: Promise<unknown> | undefined;
    let entered = false;
    try {
      await act(async () => { dismissal = hook.result.current.dismissAutoStopNotice(); });
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      acquired = mockAccountGate.acquireAccount('user-a').then(() => { entered = true; });
      await act(async () => {
        await expect(hook.result.current.dismissAutoStopNotice()).rejects.toThrow('normal-blocked');
      });
      expect(entered).toBe(false);
      expect(await loadAutoStopNotice()).not.toBeNull();
      hold.resolve();
      await act(async () => { await dismissal; await acquired; });
      expect(await loadAutoStopNotice()).toBeNull();
      expect(hook.result.current.autoStopNotice).toBeNull();
    } finally {
      hold.resolve();
      if (dismissal) await dismissal;
      if (acquired) {
        await acquired;
        await mockAccountGate.releaseAccount('user-a');
      }
      spy.mockRestore();
    }
  });

  it('new check setting uses the explicitly captured owner', async () => {
    const hook = await openHook();
    await idle();
    await act(async () => { await hook.result.current.start(); });
    expect(native().rememberCheckEnabledSetting).toHaveBeenCalledWith(true, 'user-a');
  });
});
