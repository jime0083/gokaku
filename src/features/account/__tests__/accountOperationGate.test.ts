import {
  createAccountOperationGate,
  type AccountOperationLease,
} from '../accountOperationGate';

const UID = 'owner';
const OTHER = 'other';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let uid: string | null = UID;
  let blocked = false;
  const readDurableBlocked = jest.fn(async () => blocked);
  const gate = createAccountOperationGate({
    getCurrentUid: () => uid,
    getAccountCompletionConfirmed: () => false,
    readDurableBlocked,
  });
  return {
    gate,
    readDurableBlocked,
    setUid: (value: string | null) => { uid = value; },
    setBlocked: (value: boolean) => { blocked = value; },
  };
}

it('blocks new roots synchronously, drains nested work, and preserves durable blocking', async () => {
  const h = harness();
  const entered = deferred();
  const finish = deferred();
  const nested = jest.fn(async (lease: AccountOperationLease) => {
    lease.assertCurrentUid();
  });
  const normal = h.gate.runNormal(UID, async (lease) => {
    entered.resolve();
    await finish.promise;
    lease.assertCurrentUid();
    await h.gate.runNormal(UID, nested, lease);
  });
  await entered.promise;
  let acquired = false;
  const account = h.gate.acquireAccount(UID).then((permit) => {
    acquired = true;
    return permit;
  });
  await expect(h.gate.runNormal(UID, nested)).rejects.toThrow('normal-blocked');
  await expect(h.gate.acquireAccount(UID)).rejects.toThrow('account-busy');
  await expect(h.gate.releaseAccount(UID)).rejects.toThrow('account-busy');
  expect(acquired).toBe(false);
  h.setBlocked(true);
  finish.resolve();
  await normal;
  const permit = await account;
  expect(nested).toHaveBeenCalledTimes(1);
  permit.assertCurrentUid();
  await expect(h.gate.acquireAccount(UID)).rejects.toThrow('account-busy');
  await expect(h.gate.releaseAccount(OTHER)).rejects.toThrow('account-owner');
  permit.assertCurrentUid();
  await h.gate.releaseAccount(UID);
  expect(() => permit.assertCurrentUid()).toThrow('expired-lease');
  await expect(h.gate.runNormal(UID, nested)).rejects.toThrow('normal-blocked');
  h.setBlocked(false);
  await h.gate.runNormal(UID, nested);
});

it('tracks a root while its initial durable read is pending', async () => {
  const h = harness();
  const read = deferred();
  h.readDurableBlocked.mockImplementationOnce(async () => {
    await read.promise;
    return false;
  });
  const task = jest.fn(async (lease: AccountOperationLease) => {
    lease.assertCurrentUid();
  });
  const normal = h.gate.runNormal(UID, task);
  const account = h.gate.acquireAccount(UID);
  await expect(h.gate.runNormal(UID, task)).rejects.toThrow('normal-blocked');
  expect(task).not.toHaveBeenCalled();
  read.resolve();
  await normal;
  const permit = await account;
  expect(task).toHaveBeenCalledTimes(1);
  permit.assertCurrentUid();
  await h.gate.releaseAccount(UID);
});

it.each([false, true])('awaits the whole writer, including failure=%s', async (fail) => {
  const h = harness();
  const entered = deferred();
  const response = deferred();
  const normal = h.gate.runNormal(UID, async (lease) => {
    entered.resolve();
    await response.promise;
    lease.assertCurrentUid();
    if (fail) throw new Error('writer-failed');
    return 'saved';
  });
  const outcome = normal.then(
    (value) => value,
    (error: Error) => error.message,
  );
  await entered.promise;
  let acquired = false;
  const account = h.gate.acquireAccount(UID).then((permit) => {
    acquired = true;
    return permit;
  });
  await expect(h.gate.runNormal(UID, async () => {})).rejects.toThrow('normal-blocked');
  expect(acquired).toBe(false);
  response.resolve();
  expect(await outcome).toBe(fail ? 'writer-failed' : 'saved');
  (await account).assertCurrentUid();
  await h.gate.releaseAccount(UID);
});

it.each([null, OTHER])('rejects UID changes while acquisition waits: %s', async (uid) => {
  const h = harness();
  const entered = deferred();
  const finish = deferred();
  const effect = jest.fn();
  const normal = h.gate.runNormal(UID, async (lease) => {
    entered.resolve();
    await finish.promise;
    lease.assertCurrentUid();
    effect();
  });
  const normalResult = expect(normal).rejects.toThrow('uid-changed');
  await entered.promise;
  const accountResult = expect(h.gate.acquireAccount(UID)).rejects.toThrow('uid-changed');
  h.setUid(uid);
  finish.resolve();
  await normalResult;
  await accountResult;
  expect(effect).not.toHaveBeenCalled();
  h.setUid(UID);
  (await h.gate.acquireAccount(UID)).assertCurrentUid();
  await h.gate.releaseAccount(UID);
});

it('rechecks UID after the durable read before invoking a root', async () => {
  const h = harness();
  h.readDurableBlocked.mockImplementationOnce(async () => {
    h.setUid(OTHER);
    return false;
  });
  const task = jest.fn(async () => {});
  await expect(h.gate.runNormal(UID, task)).rejects.toThrow('uid-changed');
  expect(task).not.toHaveBeenCalled();
});

it.each([null, OTHER])('rejects unauthenticated or other-UID admission: %s', async (uid) => {
  const h = harness();
  h.setUid(uid);
  const task = jest.fn(async () => {});
  await expect(h.gate.runNormal(UID, task)).rejects.toThrow('uid-changed');
  await expect(h.gate.acquireAccount(UID)).rejects.toThrow('uid-changed');
  expect(task).not.toHaveBeenCalled();
  expect(h.readDurableBlocked).not.toHaveBeenCalled();
});

it.each(['throw', undefined, null, 'false'])('fails closed for durable unknown: %s', async (value) => {
  const h = harness();
  h.readDurableBlocked.mockImplementation(async () => {
    if (value === 'throw') throw new Error('private-storage-error');
    return value as never;
  });
  const task = jest.fn(async () => {});
  await expect(h.gate.runNormal(UID, task)).rejects.toThrow('durable-unknown');
  const permit = await h.gate.acquireAccount(UID);
  await expect(h.gate.releaseAccount(UID)).rejects.toThrow('durable-unknown');
  expect(() => permit.assertCurrentUid()).toThrow('expired-lease');
  await expect(h.gate.runNormal(UID, task)).rejects.toThrow('durable-unknown');
  expect(task).not.toHaveBeenCalled();
  h.readDurableBlocked.mockResolvedValue(false);
  await h.gate.runNormal(UID, task);
});

it('rejects forged, foreign, expired, other-UID and account leases as nested writers', async () => {
  const h = harness();
  const foreign = harness();
  const task = jest.fn(async () => {});
  let expired!: AccountOperationLease;
  await h.gate.runNormal(UID, async (lease) => {
    expired = lease;
    await expect(h.gate.runNormal(OTHER, task, lease)).rejects.toThrow('invalid-lease');
    await expect(foreign.gate.runNormal(UID, task, lease)).rejects.toThrow('invalid-lease');
    h.setUid(null);
    await expect(h.gate.runNormal(UID, task, lease)).rejects.toThrow('uid-changed');
    h.setUid(UID);
  });
  expect(() => expired.assertCurrentUid()).toThrow('expired-lease');
  await expect(h.gate.runNormal(UID, task, expired)).rejects.toThrow('invalid-lease');
  await expect(h.gate.runNormal(UID, task, {
    assertCurrentUid: () => {},
  })).rejects.toThrow('invalid-lease');
  const account = await h.gate.acquireAccount(UID);
  await expect(h.gate.runNormal(UID, task, account)).rejects.toThrow('invalid-lease');
  await h.gate.releaseAccount(UID);
  expect(task).not.toHaveBeenCalled();
});

it('permits null only with current completion evidence for the bound account UID', async () => {
  let uid: string | null = UID;
  let confirmedUid: string | null = null;
  const gate = createAccountOperationGate({
    getCurrentUid: () => uid,
    getAccountCompletionConfirmed: (expectedUid) => confirmedUid === expectedUid,
    readDurableBlocked: async () => false,
  });

  // Issued before cloud deletion; evidence is checked dynamically afterward.
  const permit = await gate.acquireAccount(UID);
  uid = null;
  expect(() => permit.assertCurrentUid()).toThrow('uid-changed');
  confirmedUid = OTHER;
  expect(() => permit.assertCurrentUid()).toThrow('uid-changed');
  confirmedUid = UID;
  permit.assertCurrentUid();

  uid = OTHER;
  expect(() => permit.assertCurrentUid()).toThrow('uid-changed');
  await gate.releaseAccount(UID);
  await expect(gate.acquireAccount(UID)).rejects.toThrow('uid-changed');

  // Confirmed checkpoint permits restart/resume with null auth.
  uid = null;
  const resumed = await gate.acquireAccount(UID);
  resumed.assertCurrentUid();
  confirmedUid = null;
  expect(() => resumed.assertCurrentUid()).toThrow('uid-changed');
  await gate.releaseAccount(UID);
  await expect(gate.acquireAccount(UID)).rejects.toThrow('uid-changed');

  // Completion evidence never authorizes a normal writer with null auth.
  confirmedUid = UID;
  const task = jest.fn(async () => {});
  await expect(gate.runNormal(UID, task)).rejects.toThrow('uid-changed');
  expect(task).not.toHaveBeenCalled();
});

it('never permits a normal nested lease after auth becomes null', async () => {
  let uid: string | null = UID;
  const gate = createAccountOperationGate({
    getCurrentUid: () => uid,
    getAccountCompletionConfirmed: () => true,
    readDurableBlocked: async () => false,
  });
  const task = jest.fn(async () => {});
  await gate.runNormal(UID, async (lease) => {
    uid = null;
    expect(() => lease.assertCurrentUid()).toThrow('uid-changed');
    await expect(gate.runNormal(UID, task, lease)).rejects.toThrow('uid-changed');
  });
  expect(task).not.toHaveBeenCalled();
});

it.each(['throw', undefined, 'true'])('fails closed for unknown account confirmation: %s', async (value) => {
  const gate = createAccountOperationGate({
    getCurrentUid: () => null,
    getAccountCompletionConfirmed: () => {
      if (value === 'throw') throw new Error('confirmation-unavailable');
      return value as never;
    },
    readDurableBlocked: async () => false,
  });
  await expect(gate.acquireAccount(UID)).rejects.toThrow();
});
