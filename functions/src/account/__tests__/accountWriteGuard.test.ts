import type {
  DocumentReference,
  DocumentSnapshot,
  Transaction,
} from 'firebase-admin/firestore';

import { performAccountAction, type AccountActionDeps } from '../accountAction';
import { AccountWriteBlockedError, getWritableAccount } from '../accountWriteGuard';

const userRef = { path: 'users/unit-account' } as DocumentReference;

function snapshot(exists: boolean, deleting = false): DocumentSnapshot {
  return {
    exists,
    get: (field: string) => field === 'deletionInProgress' ? deleting : undefined,
  } as unknown as DocumentSnapshot;
}

function transaction(get: jest.Mock): Transaction {
  return { get } as unknown as Transaction;
}

describe('getWritableAccountの単体検証', () => {
  it('存在する通常アカウントのsnapshotを返す', async () => {
    const current = snapshot(true);
    const get = jest.fn().mockResolvedValue(current);
    await expect(getWritableAccount(transaction(get), userRef)).resolves.toBe(current);
    expect(get).toHaveBeenCalledWith(userRef);
  });

  it.each([
    { current: snapshot(false), reason: 'missing' },
    { current: snapshot(true, true), reason: 'deleting' },
  ])('$reasonを専用エラーで拒否する', async ({ current, reason }) => {
    const get = jest.fn().mockResolvedValue(current);
    const error = await getWritableAccount(transaction(get), userRef).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AccountWriteBlockedError);
    expect(error).toMatchObject({ reason });
  });

  it('同じcallbackの再実行ごとに読み直し、古い許可を再利用しない', async () => {
    const current = snapshot(true);
    const get = jest.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(snapshot(true, true))
      .mockResolvedValueOnce(snapshot(false));
    const tx = transaction(get);
    const callback = () => getWritableAccount(tx, userRef);

    await expect(callback()).resolves.toBe(current);
    await expect(callback()).rejects.toMatchObject({ reason: 'deleting' });
    await expect(callback()).rejects.toMatchObject({ reason: 'missing' });
    expect(get).toHaveBeenCalledTimes(3);
  });
});

type Stage = Exclude<keyof AccountActionDeps, 'now'>;
const DELETE_STAGES: Stage[] = [
  'beginDeletion',
  'revokeDeviceToken',
  'deleteRelatedData',
  'deleteAuthUser',
];

function buildDeps(failingStage?: Stage): { deps: AccountActionDeps; calls: Stage[] } {
  const calls: Stage[] = [];
  const step = (stage: Stage) => async () => {
    calls.push(stage);
    if (stage === failingStage) {
      throw new Error('injected failure');
    }
  };
  return {
    calls,
    deps: {
      now: () => 0,
      beginDeletion: step('beginDeletion'),
      revokeDeviceToken: step('revokeDeviceToken'),
      deleteRelatedData: step('deleteRelatedData'),
      deleteAuthUser: step('deleteAuthUser'),
    },
  };
}

describe('performAccountActionの工程順序', () => {
  it('marker確定後に失効・データ削除を行い、Authを最後に削除する', async () => {
    const { deps, calls } = buildDeps();
    await performAccountAction('unit-account', 'delete', deps);
    expect(calls).toEqual(DELETE_STAGES);
  });

  it('logoutはmarker・データ削除・Auth削除を呼ばない', async () => {
    const { deps, calls } = buildDeps();
    await performAccountAction('unit-account', 'logout', deps);
    expect(calls).toEqual(['revokeDeviceToken']);
  });

  it.each(DELETE_STAGES)('%sで失敗したら後続工程を実行しない', async (stage) => {
    const { deps, calls } = buildDeps(stage);
    await expect(performAccountAction('unit-account', 'delete', deps))
      .rejects.toThrow('injected failure');
    expect(calls).toEqual(DELETE_STAGES.slice(0, DELETE_STAGES.indexOf(stage) + 1));
  });
});
