import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseLocalAccountData } from '../../account/localAccountData';

import {
  appendStudyEvent,
  loadStudyEventQueue,
  removeStudyEvent,
  STUDY_EVENT_QUEUE_STORAGE_KEY,
  type PendingStudyEvent,
} from '../studyEventQueue';

const EVENT_A: PendingStudyEvent = {
  sessionId: 'session-a',
  action: 'start',
  clientTimeMs: 1000,
  idempotencyKey: 'key-a',
  checkEnabled: true,
};
const EVENT_B: PendingStudyEvent = {
  sessionId: 'session-a',
  action: 'stop',
  clientTimeMs: 2000,
  idempotencyKey: 'key-b',
};
const EVENT_C: PendingStudyEvent = {
  sessionId: 'session-a',
  action: 'confirm',
  clientTimeMs: 3000,
  idempotencyKey: 'key-c',
};

describe('studyEventQueue(5-1b-2。送信待ちの列)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('新規eventにUIDを設定しても既存legacy・別UIDのqueueを補完しない', async () => {
    await appendStudyEvent(EVENT_A);
    await appendStudyEvent({ ...EVENT_B, uid: 'user-b' });
    await appendStudyEvent(EVENT_C, 'user-a');
    expect(await loadStudyEventQueue()).toEqual([
      EVENT_A, { ...EVENT_B, uid: 'user-b' }, { ...EVENT_C, uid: 'user-a' },
    ]);
  });

  it('eventのUIDを保持し、一致するownerUidを受け付ける', async () => {
    await appendStudyEvent({ ...EVENT_A, uid: 'user-a' }, 'user-a');
    expect(await loadStudyEventQueue()).toEqual([{ ...EVENT_A, uid: 'user-a' }]);
  });

  it.each([
    ['user-a', 'user-b'], ['', undefined], ['  ', undefined], [null, undefined],
    [42, undefined], [undefined, ''], [undefined, '  '], [undefined, null], [undefined, 42],
  ])('不一致・不正UIDを保存前に拒否する(%p / %p)', async (uid, ownerUid) => {
    await appendStudyEvent(EVENT_B);
    const before = await AsyncStorage.getItem(STUDY_EVENT_QUEUE_STORAGE_KEY);
    const writeCount = jest.mocked(AsyncStorage.setItem).mock.calls.length;
    await expect(appendStudyEvent(
      { ...EVENT_A, uid } as PendingStudyEvent, ownerUid as string | undefined,
    )).rejects.toThrow();
    expect(jest.mocked(AsyncStorage.setItem).mock.calls).toHaveLength(writeCount);
    expect(await AsyncStorage.getItem(STUDY_EVENT_QUEUE_STORAGE_KEY)).toBe(before);
  });

  it('cleanup parserはUIDありの待機を認識しlegacy混在はunknownで停止する', async () => {
    await appendStudyEvent(EVENT_A, 'user-a');
    const owned = await AsyncStorage.getItem(STUDY_EVENT_QUEUE_STORAGE_KEY);
    expect(parseLocalAccountData('user-a', [[STUDY_EVENT_QUEUE_STORAGE_KEY, owned]]))
      .toMatchObject({ ownership: 'known', pendingRecords: true });
    await appendStudyEvent(EVENT_B);
    const mixed = await AsyncStorage.getItem(STUDY_EVENT_QUEUE_STORAGE_KEY);
    expect(parseLocalAccountData('user-a', [[STUDY_EVENT_QUEUE_STORAGE_KEY, mixed]]).ownership).toBe('unknown');
  });

  it('保存がない場合は空配列', async () => {
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('壊れたデータ(JSON でない)の場合は空配列にフォールバックする', async () => {
    await AsyncStorage.setItem(STUDY_EVENT_QUEUE_STORAGE_KEY, '{不正なJSON');
    expect(await loadStudyEventQueue()).toEqual([]);
  });

  it('壊れた要素(idempotencyKey がない)を取り除く', async () => {
    await AsyncStorage.setItem(
      STUDY_EVENT_QUEUE_STORAGE_KEY,
      JSON.stringify([{ sessionId: 's', action: 'start', clientTimeMs: 1 }, EVENT_A]),
    );
    expect(await loadStudyEventQueue()).toEqual([EVENT_A]);
  });

  it('start なのに checkEnabled がない要素は取り除く(5-2b)', async () => {
    await AsyncStorage.setItem(
      STUDY_EVENT_QUEUE_STORAGE_KEY,
      JSON.stringify([
        { sessionId: 's', action: 'start', clientTimeMs: 1, idempotencyKey: 'k' },
        EVENT_A,
      ]),
    );
    expect(await loadStudyEventQueue()).toEqual([EVENT_A]);
  });

  it('confirm(5-2a・5-2b)の要素も保存・読み込みできる', async () => {
    await appendStudyEvent(EVENT_C);
    expect(await loadStudyEventQueue()).toEqual([EVENT_C]);
  });

  it('追加した順(古い順)で読める', async () => {
    await appendStudyEvent(EVENT_A);
    await appendStudyEvent(EVENT_B);
    expect(await loadStudyEventQueue()).toEqual([EVENT_A, EVENT_B]);
  });

  it('idempotencyKey が一致する要素だけを取り除く', async () => {
    await appendStudyEvent(EVENT_A);
    await appendStudyEvent(EVENT_B);
    await removeStudyEvent(EVENT_A.idempotencyKey);
    expect(await loadStudyEventQueue()).toEqual([EVENT_B]);
  });

  it('同時に追加と削除を行っても、どちらの変更も失われない(排他制御)', async () => {
    await appendStudyEvent(EVENT_A);
    // 削除と追加を同時に始める(await せずに並行させる)
    await Promise.all([removeStudyEvent(EVENT_A.idempotencyKey), appendStudyEvent(EVENT_B)]);
    expect(await loadStudyEventQueue()).toEqual([EVENT_B]);
  });

  it('UID指定削除は同keyの別UIDとlegacyを保持する', async () => {
    await appendStudyEvent(EVENT_A);
    await appendStudyEvent({ ...EVENT_A, uid: 'user-b' });
    await appendStudyEvent({ ...EVENT_A, uid: 'user-a' });
    await removeStudyEvent(EVENT_A.idempotencyKey, 'user-a');
    expect(await loadStudyEventQueue()).toEqual([EVENT_A, { ...EVENT_A, uid: 'user-b' }]);
  });

});
