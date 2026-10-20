import AsyncStorage from '@react-native-async-storage/async-storage';
import StudySync from '../../../../modules/study-sync/src/StudySyncModule';
import { getCurrentUid } from '@/config/firebase';
import { accountOperationGate } from '@/features/account/accountOperationRuntime';
import { fetchActiveGoalId } from '../activeGoalRepository';
import { replaceGoal } from '../replaceGoalRepository';
import { beginGoalReplacement, submitGoalReplacement, assertReplacementStopped } from '../goalReplacementFlow';
import { loadGoalReplacement, saveGoalReplacement, clearGoalReplacement } from '@/features/onboarding/replacementStorage';
import { INITIAL_ONBOARDING_DRAFT } from '@/features/onboarding/types';
import { flushStudyEventQueue } from '@/features/timer/studyEventSender';
import { appendStudyEvent } from '@/features/timer/studyEventQueue';
import { TIMER_SESSIONS_STORAGE_KEY } from '@/features/timer/storage';

jest.mock('../../../../modules/study-sync/src/StudySyncModule');
jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('../activeGoalRepository', () => ({ fetchActiveGoalId: jest.fn() }));
jest.mock('../replaceGoalRepository', () => ({ replaceGoal: jest.fn() }));
jest.mock('@/features/timer/studyEventSender', () => ({ flushStudyEventQueue: jest.fn() }));
const uid = jest.mocked(getCurrentUid);
const active = jest.mocked(fetchActiveGoalId);
const api = jest.mocked(replaceGoal);
const draft = { ...INITIAL_ONBOARDING_DRAFT, type: 'cert' as const, certId: 'other', certOtherName: '検定', targetHoursText: '100', examDate: '2099-01-01' as const, minDailyMinutes: 10, goalDailyMinutes: 20 };
const goal = { type: 'cert' as const, certId: 'other', certOtherName: '検定', targetHours: 100, examDate: '2099-01-01' as const, minDailyMinutes: 10, goalDailyMinutes: 20, startDate: '2026-10-14' as const, status: 'active' as const, createdAt: 1, estimatedHours: null };

const storageBase = {
  setItem: jest.mocked(AsyncStorage.setItem).getMockImplementation()!,
  getItem: jest.mocked(AsyncStorage.getItem).getMockImplementation()!,
  removeItem: jest.mocked(AsyncStorage.removeItem).getMockImplementation()!,
};
if (Object.values(storageBase).some((implementation) => typeof implementation !== 'function')) {
  throw new Error('AsyncStorage base mock implementation is missing');
}
function resetStorageMocks() {
  jest.mocked(AsyncStorage.setItem).mockReset().mockImplementation(storageBase.setItem);
  jest.mocked(AsyncStorage.getItem).mockReset().mockImplementation(storageBase.getItem);
  jest.mocked(AsyncStorage.removeItem).mockReset().mockImplementation(storageBase.removeItem);
}

beforeEach(() => {
  resetStorageMocks();
  jest.clearAllMocks(); uid.mockReturnValue('flow-user'); active.mockResolvedValue('old');
  jest.mocked(StudySync.isAccountOperationBlocked).mockReturnValue(false);
  jest.mocked(StudySync.getLastLockscreenStop).mockReturnValue(null);
  jest.mocked(flushStudyEventQueue).mockReset().mockImplementation(async (parentLease) => {
    await accountOperationGate.runNormal('flow-user', async () => undefined, parentLease);
  });
  jest.mocked(StudySync.getActiveSession).mockReturnValue(null);
  api.mockImplementation(async () => { active.mockResolvedValue('new'); return { goalId: 'new', goal }; });
});
afterEach(async () => {
  try {
    await AsyncStorage.clear();
  } finally {
    jest.restoreAllMocks();
    resetStorageMocks();
  }
});

it('空欄で開始し、UIDと旧目標に結び付けて保存し、初回draftと混ぜない', async () => {
  const record = await beginGoalReplacement('old');
  expect(record.draft).toEqual(INITIAL_ONBOARDING_DRAFT);
  await saveGoalReplacement({ ...record, draft });
  expect((await loadGoalReplacement('flow-user'))?.draft).toEqual(draft);
  expect(await loadGoalReplacement('other-user')).toBeNull();
  await clearGoalReplacement('flow-user');
  expect(await loadGoalReplacement('flow-user')).toBeNull();
});
it.each(['local', 'native'])('%s計測中は開始・登録を拒否', async (kind) => {
  if (kind === 'local') await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify([{ sessionId: 's', startAt: 1, stopAt: null, checkEnabled: false, confirmations: [] }]));
  else jest.mocked(StudySync.getActiveSession).mockReturnValue({ uid: 'flow-user', goalId: 'old', sessionId: 's', startAt: 1, checkEnabled: false, confirmations: [] });
  await expect(assertReplacementStopped()).rejects.toThrow('停止');
  await expect(beginGoalReplacement('old')).rejects.toThrow('停止');
  await expect(submitGoalReplacement({ uid: 'flow-user', expectedGoalId: 'old', draft }, 1)).rejects.toThrow('停止');
  expect(api).not.toHaveBeenCalled();
});
it('flush実行中の即return・未送信残存でも切替を拒否し旧draftを保持', async () => {
  const record = await beginGoalReplacement('old'); record.draft = draft; await saveGoalReplacement(record);
  await appendStudyEvent({ sessionId: 's', action: 'stop', clientTimeMs: 1, idempotencyKey: 'k' });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow('通信');
  expect(flushStudyEventQueue).toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
  expect((await loadGoalReplacement('flow-user'))?.draft).toEqual(draft);
});
it('flush中のUID変化でAPIとローカル消去を拒否', async () => {
  const record = await beginGoalReplacement('old');
  jest.mocked(flushStudyEventQueue).mockImplementationOnce(async () => { uid.mockReturnValue('other'); });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow(); expect(api).not.toHaveBeenCalled();
});
it('API失敗は入力保持で再試行、成功後にだけローカル記録を0にしnative目標を更新', async () => {
  const record = await beginGoalReplacement('old'); record.draft = draft;
  await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, '[]');
  api.mockRejectedValueOnce(new Error('offline'));
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow('offline');
  expect(await loadGoalReplacement('flow-user')).not.toBeNull();
  await submitGoalReplacement(record, 1);
  expect(api).toHaveBeenLastCalledWith('flow-user', 'old', draft, 1);
  expect(StudySync.setCurrentGoalIdForAccount).toHaveBeenCalledWith('flow-user', 'new');
  expect(StudySync.setCurrentGoalId).not.toHaveBeenCalled();
  expect(JSON.parse((await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY))!)).toEqual([]);
  expect(await loadGoalReplacement('flow-user')).toBeNull();
});
it('commit後のローカル失敗を再commitせず後処理だけ再試行', async () => {
  const record = await beginGoalReplacement('old'); record.draft = draft;
  jest.mocked(StudySync.setCurrentGoalIdForAccount).mockImplementationOnce(() => { throw new Error('native'); });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow('native');
  active.mockResolvedValue('new');
  await submitGoalReplacement(record, 1); expect(api).toHaveBeenCalledTimes(1);
});
it('再起動後のcommitted記録もAPIを繰り返さない', async () => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft, committedGoalId: 'new' };
  await saveGoalReplacement(record); active.mockResolvedValue('new');
  await submitGoalReplacement((await loadGoalReplacement('flow-user'))!, 1);
  expect(api).not.toHaveBeenCalled();
});

const local = (sessionId: string, stopAt: number | null = 2) => ({ sessionId, startAt: 1, stopAt, checkEnabled: false, confirmations: [] });
it('commit前の旧IDsを保存し、後処理再開時に新goalの停止済み記録を保持', async () => {
  await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify([local('old-session')]));
  const record = await beginGoalReplacement('old'); record.draft = draft;
  jest.mocked(StudySync.setCurrentGoalIdForAccount).mockImplementationOnce(() => { throw new Error('native'); });
  api.mockImplementationOnce(async () => { active.mockResolvedValue('new'); return { goalId: 'new', goal }; });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow('native');
  const saved = (await loadGoalReplacement('flow-user'))!;
  expect(saved.oldSessionIds).toEqual(['old-session']);
  await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify([local('old-session'), local('new-session')]));
  jest.mocked(StudySync.getLastLockscreenStop).mockReturnValue({ sessionId: 'new-session', stopAt: 2 });
  await submitGoalReplacement(saved, 1);
  expect(api).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY))!)).toEqual([local('new-session')]);
  expect(StudySync.clearLastLockscreenStop).not.toHaveBeenCalled();
});
it('commit中に新native計測が始まったらcommittedID保存後cleanupを拒否', async () => {
  const record = await beginGoalReplacement('old'); record.draft = draft;
  api.mockImplementationOnce(async () => {
    active.mockResolvedValue('new');
    jest.mocked(StudySync.getActiveSession).mockReturnValue({ uid: 'flow-user', goalId: 'new', sessionId: 'new-session', startAt: 1, checkEnabled: false, confirmations: [] });
    return { goalId: 'new', goal };
  });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow('停止');
  expect((await loadGoalReplacement('flow-user'))?.committedGoalId).toBe('new');
  expect(StudySync.setCurrentGoalIdForAccount).not.toHaveBeenCalled();
});
it('commit後のptr変化でcacheとnative設定を変更しない', async () => {
  const record = await beginGoalReplacement('old'); record.draft = draft;
  api.mockImplementationOnce(async () => { active.mockResolvedValue('another-goal'); return { goalId: 'new', goal }; });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow();
  expect(StudySync.setCurrentGoalIdForAccount).not.toHaveBeenCalled();
});
it('cleanupのptr読込await中にUIDが変わったら他UIDのcacheを保持', async () => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft, committedGoalId: 'new', oldSessionIds: ['old-session'] };
  active.mockImplementationOnce(async () => { uid.mockReturnValue('other'); await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, JSON.stringify([local('other-session')])); return 'new'; });
  await expect(submitGoalReplacement(record, 1)).rejects.toThrow();
  expect(JSON.parse((await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY))!)).toEqual([local('other-session')]);
  expect(StudySync.setCurrentGoalIdForAccount).not.toHaveBeenCalled();
});
it('旧native停止IDのみ消し、sessionIDのないautoStopNoticeは保持', async () => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft, committedGoalId: 'new', oldSessionIds: ['old-session'] };
  active.mockResolvedValue('new');
  jest.mocked(StudySync.getLastLockscreenStop).mockReturnValue({ sessionId: 'old-session', stopAt: 2 });
  await AsyncStorage.setItem('timer:autoStopNotice:v1', JSON.stringify({ stoppedAt: 2 }));
  await submitGoalReplacement(record, 1);
  expect(StudySync.clearLastLockscreenStop).toHaveBeenCalledTimes(1);
  expect(await AsyncStorage.getItem('timer:autoStopNotice:v1')).not.toBeNull();
});
it('遅延保存を直列化し、最後の最新draft保存完了までAPIを呼ばない', async () => {
  const record = await beginGoalReplacement('old');
  const original = storageBase.setItem;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, raw) => { entered(); await barrier; return original(key, raw); });
  record.draft = { ...draft, certOtherName: '前の入力' };
  const first = saveGoalReplacement(record);
  const operations: Promise<unknown>[] = [first];
  try {
    await Promise.race([
      started,
      first.then(() => { throw new Error('storage barrier was not reached'); }),
    ]);
    record.draft = { ...draft, certOtherName: '最新入力' };
    const second = saveGoalReplacement(record);
    operations.push(second);
    const submit = submitGoalReplacement(record, 1);
    operations.push(submit);
    expect(api).not.toHaveBeenCalled();
    api.mockImplementationOnce(async (...args) => {
      expect((await loadGoalReplacement('flow-user'))?.draft.certOtherName).toBe('最新入力');
      expect(args[2].certOtherName).toBe('最新入力'); active.mockResolvedValue('new');
      return { goalId: 'new', goal };
    });
    release();
    await Promise.all(operations);
  } finally {
    release();
    await Promise.allSettled(operations);
  }
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const replacementKey = 'onboarding:replacement:v1:flow-user';

it.each([
  'begin-read', 'begin-save', 'submit-save', 'submit-http',
  'submit-clear', 'storage-save', 'storage-clear',
])('%sのawaitから最終effect完了までaccount取得を待たせる', async (phase) => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft };
  const entered = deferred();
  const release = deferred();
  const pause = async () => { entered.resolve(); await release.promise; };
  const originalSet = storageBase.setItem;
  const originalRemove = storageBase.removeItem;
  if (phase === 'begin-read') {
    active.mockImplementationOnce(async () => { await pause(); return 'old'; });
  } else if (['begin-save', 'submit-save', 'storage-save'].includes(phase)) {
    let paused = false;
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, raw) => {
      if (key === replacementKey && !paused) {
        paused = true;
        await pause();
      }
      return originalSet(key, raw);
    });
  } else if (phase === 'submit-http') {
    api.mockImplementationOnce(async () => {
      await pause();
      active.mockResolvedValue('new');
      return { goalId: 'new', goal };
    });
  } else {
    jest.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key) => {
      if (key === replacementKey) await pause();
      return originalRemove(key);
    });
  }
  const running = phase.startsWith('begin')
    ? beginGoalReplacement('old')
    : phase.startsWith('submit')
      ? submitGoalReplacement(record, 1)
      : phase === 'storage-save'
        ? saveGoalReplacement(record)
        : clearGoalReplacement('flow-user');
  let acquired = false;
  let account: ReturnType<typeof accountOperationGate.acquireAccount> | undefined;
  try {
    await Promise.race([
      entered.promise,
      running.then(() => { throw new Error('producer barrier was not reached'); }),
    ]);
    account = accountOperationGate.acquireAccount('flow-user').then((permit) => {
      acquired = true;
      return permit;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    await expect(saveGoalReplacement(record)).rejects.toThrow('normal-blocked');
    release.resolve();
    await running;
    (await account).assertCurrentUid();
    if (phase.startsWith('submit')) {
      expect(flushStudyEventQueue).toHaveBeenCalledWith(
        expect.objectContaining({ assertCurrentUid: expect.any(Function) }),
      );
      expect(StudySync.setCurrentGoalIdForAccount)
        .toHaveBeenCalledWith('flow-user', 'new');
      expect(await AsyncStorage.getItem(replacementKey)).toBeNull();
    }
  } finally {
    release.resolve();
    await Promise.allSettled([running]);
    if (account) {
      await account.then(
        () => accountOperationGate.releaseAccount('flow-user'),
        () => undefined,
      );
    }
  }
});

it.each(['native', 'checkpoint', 'corrupt'])(
  '%s block時はbegin/submitとContext用save/clearが無変更で拒否される',
  async (kind) => {
    const record = { uid: 'flow-user', expectedGoalId: 'old', draft };
    const raw = JSON.stringify(record);
    await AsyncStorage.setItem(replacementKey, raw);
    if (kind === 'native') {
      jest.mocked(StudySync.isAccountOperationBlocked).mockReturnValue(true);
    } else {
      await AsyncStorage.setItem('account:action:v1', kind === 'corrupt'
        ? '{'
        : JSON.stringify({ uid: 'flow-user', action: 'logout', phase: 'cloud-pending' }));
    }
    const error = kind === 'corrupt' ? 'durable-unknown' : 'normal-blocked';
    await expect(beginGoalReplacement('old')).rejects.toThrow(error);
    await expect(submitGoalReplacement(record, 1)).rejects.toThrow(error);
    await expect(saveGoalReplacement(record)).rejects.toThrow(error);
    await expect(clearGoalReplacement('flow-user')).rejects.toThrow(error);
    expect(await AsyncStorage.getItem(replacementKey)).toBe(raw);
    expect(api).not.toHaveBeenCalled();
    expect(StudySync.setCurrentGoalIdForAccount).not.toHaveBeenCalled();
    expect(StudySync.setCurrentGoalId).not.toHaveBeenCalled();
  },
);

it.each(['begin', 'submit'])(
  '%sのremote await後にUIDが変わると別UIDとlegacyを保持する',
  async (phase) => {
    const record = await beginGoalReplacement('old');
    let before = await AsyncStorage.getItem(replacementKey);
    const otherKey = 'onboarding:replacement:v1:other';
    const other = JSON.stringify({ uid: 'other', expectedGoalId: 'other-goal', draft });
    const legacy = JSON.stringify([local('legacy-session')]);
    await AsyncStorage.setItem(otherKey, other);
    await AsyncStorage.setItem(TIMER_SESSIONS_STORAGE_KEY, legacy);
    if (phase === 'begin') {
      active.mockImplementationOnce(async () => {
        uid.mockReturnValue('other');
        return 'old';
      });
    } else {
      api.mockImplementationOnce(async () => {
        // UID変更前の正当な保存を含め、この境界以降の不変性を検証する。
        before = await AsyncStorage.getItem(replacementKey);
        uid.mockReturnValue('other');
        active.mockResolvedValue('new');
        return { goalId: 'new', goal };
      });
    }
    await expect(phase === 'begin'
      ? beginGoalReplacement('old')
      : submitGoalReplacement(record, 1)).rejects.toThrow();
    expect(await AsyncStorage.getItem(replacementKey)).toBe(before);
    expect(await AsyncStorage.getItem(otherKey)).toBe(other);
    expect(await AsyncStorage.getItem(TIMER_SESSIONS_STORAGE_KEY)).toBe(legacy);
    expect(StudySync.setCurrentGoalIdForAccount).not.toHaveBeenCalled();
    expect(StudySync.setCurrentGoalId).not.toHaveBeenCalled();
    expect(StudySync.clearLastLockscreenStop).not.toHaveBeenCalled();
  },
);

it('保存要求時点のUID/contentを固定しloadもgate待機中の保存を待つ', async () => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft: { ...draft } };
  const entered = deferred();
  const release = deferred();
  const originalGet = storageBase.getItem;
  let paused = false;
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => {
    if (key === 'account:action:v1' && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return originalGet(key);
  });
  const saving = saveGoalReplacement(record);
  record.uid = 'other';
  record.draft.certOtherName = '後の変更';
  let loaded = false;
  let loading: ReturnType<typeof loadGoalReplacement> | undefined;
  try {
    await Promise.race([
      entered.promise,
      saving.then(() => { throw new Error('read barrier was not reached'); }),
    ]);
    loading = loadGoalReplacement('flow-user').then((value) => {
      loaded = true;
      return value;
    });
    await Promise.resolve();
    expect(loaded).toBe(false);
    release.resolve();
    await saving;
    expect((await loading)?.uid).toBe('flow-user');
    expect((await loading)?.draft.certOtherName).toBe(draft.certOtherName);
    expect(await AsyncStorage.getItem('onboarding:replacement:v1:other')).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([saving, ...(loading ? [loading] : [])]);
  }
});

it('直列化待機中にUIDが変わると後続save/clearを実行しない', async () => {
  const record = { uid: 'flow-user', expectedGoalId: 'old', draft };
  const entered = deferred();
  const release = deferred();
  const originalSet = storageBase.setItem;
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, raw) => {
    entered.resolve();
    await release.promise;
    return originalSet(key, raw);
  });
  const first = saveGoalReplacement(record);
  const operations: Promise<unknown>[] = [first];
  try {
    await Promise.race([
      entered.promise,
      first.then(() => { throw new Error('write barrier was not reached'); }),
    ]);
    const second = saveGoalReplacement({ ...record, draft: { ...draft, certOtherName: '後続' } });
    operations.push(second);
    const clearing = clearGoalReplacement('flow-user');
    operations.push(clearing);
    const settled = Promise.allSettled(operations);
    uid.mockReturnValue('other');
    release.resolve();
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(JSON.parse((await AsyncStorage.getItem(replacementKey))!).draft).toEqual(draft);
    expect(await AsyncStorage.getItem('onboarding:replacement:v1:other')).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
  }
});
