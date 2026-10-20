import {
  createAccountActionFlow,
  type AccountAction,
  type AccountActionCheckpoint,
  type AccountActionFlowDeps,
} from '../accountActionFlow';

const UID = 'owner-a';
const OTHER = 'owner-b';

function harness() {
  let currentUid: string | null = UID;
  let checkpoint: AccountActionCheckpoint | null = null;
  let blocked = false;
  let normalWritersBlocked = false;
  let measuring = false;
  let ownership: 'known' | 'unknown' = 'known';
  let pendingRecords = false;
  const events: string[] = [];
  const local = new Map([[UID, 'owner-data'], [OTHER, 'other-data']]);

  function bound(uid: string, allowNull = false): void {
    if (uid !== UID || (currentUid !== uid && !(allowNull && currentUid === null))) {
      throw new Error('uid-bound-port');
    }
  }
  function requireBlock(): void {
    if (!blocked) throw new Error('operation-block-required');
  }

  const deps: jest.Mocked<AccountActionFlowDeps> = {
    getCurrentUid: jest.fn(() => currentUid),
    acquireOperationBlock: jest.fn(async (uid: string, _action: AccountAction) => {
      bound(uid, true);
      events.push('acquire');
      blocked = true;
      normalWritersBlocked = true;
      return true;
    }),
    releaseOperationBlock: jest.fn(async (uid: string) => {
      bound(uid, true);
      events.push('release');
      blocked = false;
      // Release the execution lease, not the durable producer gate.
      normalWritersBlocked = checkpoint !== null;
    }),
    inspectLocalState: jest.fn(async (uid: string) => {
      bound(uid, true);
      requireBlock();
      events.push('inspect');
      return { measuring, ownership, pendingRecords };
    }),
    syncPendingRecords: jest.fn(async (uid: string) => {
      bound(uid);
      requireBlock();
      events.push('sync');
      pendingRecords = false;
    }),
    reauthenticateAndRevoke: jest.fn(async (uid: string) => {
      bound(uid);
      requireBlock();
      events.push('apple');
    }),
    authAccountAction: jest.fn(async (uid: string, action: 'logout' | 'delete') => {
      bound(uid);
      requireBlock();
      events.push(`cloud:${action}`);
    }),
    cleanupLocalData: jest.fn(async (uid: string) => {
      bound(uid, true);
      requireBlock();
      events.push('cleanup');
      local.delete(uid);
    }),
    signOut: jest.fn(async (uid: string) => {
      bound(uid, true);
      events.push('signOut');
      currentUid = null;
    }),
    launch: jest.fn(async () => {
      if (currentUid !== null && currentUid !== UID) throw new Error('uid-bound-port');
      events.push('launch');
    }),
    loadCheckpoint: jest.fn(async () => checkpoint ? { ...checkpoint } : null),
    saveCheckpoint: jest.fn(async (record: AccountActionCheckpoint) => {
      bound(record.uid, record.phase !== 'cloud-pending');
      checkpoint = { ...record };
    }),
    clearCheckpoint: jest.fn(async (uid: string, action: 'logout' | 'delete') => {
      bound(uid, true);
      if (checkpoint && (checkpoint.uid !== uid || checkpoint.action !== action)) {
        throw new Error('checkpoint-conflict');
      }
      checkpoint = null;
      normalWritersBlocked = blocked;
    }),
  };

  return {
    deps, events, local,
    flow: createAccountActionFlow(deps),
    setUid: (uid: string | null) => { currentUid = uid; },
    setState: (state: Partial<{
      measuring: boolean;
      ownership: 'known' | 'unknown';
      pendingRecords: boolean;
    }>) => {
      measuring = state.measuring ?? measuring;
      ownership = state.ownership ?? ownership;
      pendingRecords = state.pendingRecords ?? pendingRecords;
    },
    setCheckpoint: (record: AccountActionCheckpoint) => { checkpoint = { ...record }; },
    checkpoint: () => checkpoint ? { ...checkpoint } : null,
    blocked: () => blocked,
    normalWritersBlocked: () => normalWritersBlocked,
    writeNormally: (uid: string) => {
      bound(uid);
      if (normalWritersBlocked) return false;
      local.set(uid, 'new-local-record');
      pendingRecords = true;
      return true;
    },
  };
}

function expectBefore(events: string[], first: string, second: string): void {
  expect(events).toContain(first);
  expect(events).toContain(second);
  expect(events.indexOf(first)).toBeLessThan(events.indexOf(second));
}

it.each(['logout', 'delete'] as const)('%s follows the required order', async (action) => {
  const h = harness();
  h.setState({ pendingRecords: true });

  await expect(h.flow.run(action, UID)).resolves.toEqual({ status: 'complete' });

  expect(h.deps.acquireOperationBlock).toHaveBeenCalledWith(UID, action);
  expectBefore(h.events, 'acquire', 'inspect');
  expectBefore(h.events, 'inspect', 'sync');
  expectBefore(h.events, 'sync', `cloud:${action}`);
  expectBefore(h.events, `cloud:${action}`, 'cleanup');
  expectBefore(h.events, 'cleanup', 'signOut');
  expectBefore(h.events, 'signOut', 'launch');
  if (action === 'delete') {
    expectBefore(h.events, 'sync', 'apple');
    expectBefore(h.events, 'apple', 'cloud:delete');
  } else {
    expect(h.deps.reauthenticateAndRevoke).not.toHaveBeenCalled();
  }
  expect(h.deps.inspectLocalState.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(h.local.has(UID)).toBe(false);
  expect(h.local.get(OTHER)).toBe('other-data');
  expect(h.checkpoint()).toBeNull();
  expect(h.blocked()).toBe(false);
});

it('does nothing destructive when acquiring the native+JS block fails', async () => {
  const h = harness();
  h.deps.acquireOperationBlock.mockResolvedValueOnce(false);
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.inspectLocalState).not.toHaveBeenCalled();
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
  expect(h.deps.releaseOperationBlock).not.toHaveBeenCalled();
});

it.each([
  { measuring: true },
  { ownership: 'unknown' as const },
])('preserves data and stops before cloud for %j', async (state) => {
  const h = harness();
  h.setState(state);
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.syncPendingRecords).not.toHaveBeenCalled();
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
  expect(h.local.size).toBe(2);
  expect(h.blocked()).toBe(false);
});

it('allows explicit retry after ownership becomes known', async () => {
  const h = harness();
  h.setState({ ownership: 'unknown' });
  await expect(h.flow.run('logout', UID)).resolves.toMatchObject({ status: 'incomplete' });
  h.setState({ ownership: 'known' });
  await expect(h.flow.run('logout', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
});

it('checks remaining records instead of trusting sync resolution', async () => {
  const h = harness();
  h.setState({ pendingRecords: true });
  h.deps.syncPendingRecords.mockResolvedValueOnce(undefined);
  await expect(h.flow.run('logout', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
});

it.each([
  { measuring: true },
  { ownership: 'unknown' as const },
])('rechecks safety after synchronization: %j', async (state) => {
  const h = harness();
  h.deps.syncPendingRecords.mockImplementationOnce(async () => { h.setState(state); });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
});

it('rechecks safety after Apple authentication', async () => {
  const h = harness();
  h.deps.reauthenticateAndRevoke.mockImplementationOnce(async () => {
    h.setState({ ownership: 'unknown' });
  });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
});

it.each([null, OTHER, ''])('rejects initial UID %j', async (uid) => {
  const h = harness();
  h.setUid(uid);
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.acquireOperationBlock).not.toHaveBeenCalled();
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
});

describe.each([
  'loadCheckpoint',
  'acquireOperationBlock',
  'inspectLocalState',
  'syncPendingRecords',
  'reauthenticateAndRevoke',
] as const)('UID changes while awaiting %s', (port) => {
  it.each([null, OTHER])('rejects %j before cloud', async (uid) => {
    const h = harness();
    const original = h.deps[port].getMockImplementation()!;
    // Keep each port's existing fake behavior, then change the current identity.
    h.deps[port].mockImplementationOnce((async (...args: never[]) => {
      const result = await (original as (...args: never[]) => Promise<unknown>)(...args);
      h.setUid(uid);
      return result;
    }) as never);

    await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
    expect(h.deps.authAccountAction).not.toHaveBeenCalled();
    expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
    expect(h.local.get(OTHER)).toBe('other-data');
  });
});

it('rejects overlapping run and resume without a second destructive call', async () => {
  const h = harness();
  let finish!: () => void;
  h.deps.syncPendingRecords.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = resolve;
  }));
  const first = h.flow.run('logout', UID);
  // Await the actual port boundary without timers or timing assumptions.
  while (!finish) await Promise.resolve();

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  await expect(h.flow.resume()).resolves.toMatchObject({ status: 'incomplete' });
  finish();
  await expect(first).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
});

it('accepts null only after a successful bound cloud response', async () => {
  const h = harness();
  h.deps.authAccountAction.mockImplementationOnce(async () => { h.setUid(null); });
  await expect(h.flow.run('delete', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.cleanupLocalData).toHaveBeenCalledWith(UID);
});

it('does not infer success from null after a lost server response', async () => {
  const h = harness();
  h.deps.authAccountAction.mockImplementationOnce(async () => {
    h.setUid(null);
    throw new Error('response-lost');
  });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  await expect(createAccountActionFlow(h.deps).resume())
    .resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
  expect(h.deps.launch).not.toHaveBeenCalled();
});

it('permits explicit same-UID retry of an unconfirmed idempotent server action', async () => {
  const h = harness();
  h.deps.authAccountAction.mockRejectedValueOnce(new Error('response-lost'));
  await expect(h.flow.run('logout', UID)).resolves.toMatchObject({ status: 'incomplete' });
  await expect(h.flow.run('logout', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(2);
});

it.each(['cleanupLocalData', 'signOut', 'launch'] as const)(
  'retries %s without repeating cloud or Apple authentication',
  async (port) => {
    const h = harness();
    h.deps[port].mockRejectedValueOnce(new Error('local-failure'));
    await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
    await expect(h.flow.run('delete', UID)).resolves.toEqual({ status: 'complete' });
    expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
    expect(h.deps.reauthenticateAndRevoke).toHaveBeenCalledTimes(1);
    expect(h.deps[port]).toHaveBeenCalledTimes(2);
    expect(h.local.get(OTHER)).toBe('other-data');
  },
);

it('remembers cloud success when saving its checkpoint fails', async () => {
  const h = harness();
  const save = h.deps.saveCheckpoint.getMockImplementation()!;
  h.deps.saveCheckpoint.mockImplementation(async (record) => {
    if (record.phase === 'local-cleanup') throw new Error('storage-failed');
    await save(record);
  });

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.checkpoint()?.phase).toBe('cloud-pending');

  // A restarted instance has no success evidence and must not automatically proceed.
  await expect(createAccountActionFlow(h.deps).resume())
    .resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();

  h.deps.saveCheckpoint.mockImplementation(save);
  await expect(h.flow.run('delete', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
});

it.each(['local-cleanup', 'sign-out', 'launch'] as const)(
  'resumes durable %s after restart with null auth',
  async (phase) => {
    const h = harness();
    h.setCheckpoint({ uid: UID, action: 'delete', phase });
    h.setUid(null);

    await expect(createAccountActionFlow(h.deps).resume())
      .resolves.toEqual({ status: 'complete' });
    expect(h.deps.authAccountAction).not.toHaveBeenCalled();
    expect(h.deps.reauthenticateAndRevoke).not.toHaveBeenCalled();
    expect(h.deps.syncPendingRecords).not.toHaveBeenCalled();
    expect(h.deps.launch).toHaveBeenCalledTimes(1);
    expect(h.local.get(OTHER)).toBe('other-data');
    expect(h.checkpoint()).toBeNull();
  },
);

it.each(['cloud-pending', 'local-cleanup', 'sign-out', 'launch'] as const)(
  'does not touch another user when resuming %s',
  async (phase) => {
    const h = harness();
    h.setCheckpoint({ uid: UID, action: 'delete', phase });
    h.setUid(OTHER);

    await expect(h.flow.resume()).resolves.toMatchObject({ status: 'incomplete' });
    expect(h.deps.acquireOperationBlock).not.toHaveBeenCalled();
    expect(h.deps.authAccountAction).not.toHaveBeenCalled();
    expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
    expect(h.deps.signOut).not.toHaveBeenCalled();
    expect(h.deps.launch).not.toHaveBeenCalled();
    expect(h.local.size).toBe(2);
  },
);

it('stops local finish if a different UID appears after cloud success', async () => {
  const h = harness();
  h.deps.authAccountAction.mockImplementationOnce(async () => { h.setUid(OTHER); });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
  expect(h.deps.signOut).not.toHaveBeenCalled();
  expect(h.deps.launch).not.toHaveBeenCalled();
  expect(h.local.size).toBe(2);
});

it('does not replace an unfinished action with a different action', async () => {
  const h = harness();
  h.setCheckpoint({ uid: UID, action: 'logout', phase: 'local-cleanup' });
  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
});

it.each([
  'loadCheckpoint',
  'acquireOperationBlock',
  'inspectLocalState',
  'syncPendingRecords',
  'reauthenticateAndRevoke',
  'saveCheckpoint',
  'authAccountAction',
] as const)('sanitizes %s failure and leaves work incomplete', async (port) => {
  const h = harness();
  h.deps[port].mockRejectedValueOnce(new Error('secret-sdk-payload'));
  const result = await h.flow.run('delete', UID);
  expect(result).toMatchObject({ status: 'incomplete' });
  expect(JSON.stringify(result)).not.toContain('secret-sdk-payload');
  expect(h.deps.cleanupLocalData).not.toHaveBeenCalled();
  expect(h.deps.launch).not.toHaveBeenCalled();
});

it.each(['releaseOperationBlock', 'clearCheckpoint'] as const)(
  'does not report completion or repeat cloud after %s fails',
  async (port) => {
    const h = harness();
    h.deps[port].mockRejectedValueOnce(new Error('finish-failure'));
    await expect(h.flow.run('logout', UID)).resolves.toMatchObject({ status: 'incomplete' });
    await expect(h.flow.run('logout', UID)).resolves.toEqual({ status: 'complete' });
    expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
  },
);

it('keeps normal writers blocked after partial cloud failure and lease release', async () => {
  const h = harness();
  h.deps.authAccountAction.mockRejectedValueOnce(new Error('deletion-in-progress'));

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });

  expect(h.checkpoint()?.phase).toBe('cloud-pending');
  expect(h.deps.releaseOperationBlock).toHaveBeenCalledWith(UID);
  expect(h.blocked()).toBe(false);
  expect(h.normalWritersBlocked()).toBe(true);
  expect(h.writeNormally(UID)).toBe(false);
  expect(h.local.get(UID)).toBe('owner-data');
  expect(h.local.get(OTHER)).toBe('other-data');

  // Recreating the flow must not reopen the adapter's durable producer gate.
  await expect(createAccountActionFlow(h.deps).resume())
    .resolves.toMatchObject({ status: 'incomplete' });
  expect(h.writeNormally(UID)).toBe(false);
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);

  // Explicit retry may drain existing records while normal producers stay blocked.
  await expect(h.flow.run('delete', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(2);
  expect(h.checkpoint()).toBeNull();
  expect(h.normalWritersBlocked()).toBe(false);
});

it('keeps producers blocked when cloud succeeded but its checkpoint save failed', async () => {
  const h = harness();
  const save = h.deps.saveCheckpoint.getMockImplementation()!;
  h.deps.saveCheckpoint.mockImplementation(async (record) => {
    if (record.phase === 'local-cleanup') throw new Error('storage-failed');
    await save(record);
  });

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });

  expect(h.blocked()).toBe(false);
  expect(h.checkpoint()?.phase).toBe('cloud-pending');
  expect(h.writeNormally(UID)).toBe(false);

  h.deps.saveCheckpoint.mockImplementation(save);
  await expect(h.flow.run('delete', UID)).resolves.toEqual({ status: 'complete' });
  expect(h.deps.authAccountAction).toHaveBeenCalledTimes(1);
  expect(h.normalWritersBlocked()).toBe(false);
});

it.each([
  { measuring: true },
  { ownership: 'unknown' as const },
])('restores normal writers after stopping before checkpoint creation: %j', async (state) => {
  const h = harness();
  h.setState(state);

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });

  expect(h.checkpoint()).toBeNull();
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.blocked()).toBe(false);
  expect(h.normalWritersBlocked()).toBe(false);
  expect(h.writeNormally(UID)).toBe(true);
});

it('restores normal writers after Apple cancellation before checkpoint creation', async () => {
  const h = harness();
  h.deps.reauthenticateAndRevoke.mockRejectedValueOnce(new Error('cancelled'));

  await expect(h.flow.run('delete', UID)).resolves.toMatchObject({ status: 'incomplete' });

  expect(h.checkpoint()).toBeNull();
  expect(h.deps.authAccountAction).not.toHaveBeenCalled();
  expect(h.blocked()).toBe(false);
  expect(h.writeNormally(UID)).toBe(true);
});
