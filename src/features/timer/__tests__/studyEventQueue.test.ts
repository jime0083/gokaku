import AsyncStorage from '@react-native-async-storage/async-storage';

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
};
const EVENT_B: PendingStudyEvent = {
  sessionId: 'session-a',
  action: 'stop',
  clientTimeMs: 2000,
  idempotencyKey: 'key-b',
};

describe('studyEventQueue(5-1b-2。送信待ちの列)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
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
});
