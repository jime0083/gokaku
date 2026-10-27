import type { EnsurePostingJobResult } from '../createPostingJob';
import type { PostResult } from '../postTransport';
import type { createPostingJobStore } from '../postingJobStore';
import type { createPostingTokenProvider } from '../postingToken';
import {
  createPostingJob, transitionPostingJob, type PostingJob,
} from '../postingJobState';
import { processPostingDate } from '../postingWorker';

type Store = ReturnType<typeof createPostingJobStore>;
type Tokens = ReturnType<typeof createPostingTokenProvider>;
type Action = Parameters<Store['apply']>[2];
type ApplyResult = Awaited<ReturnType<Store['apply']>>;
type TokenResult = Awaited<ReturnType<Tokens['acquire']>>;
type Hook = (action: Action) => Promise<ApplyResult>;
type Payload = { readonly text: string; readonly mediaIds: readonly string[] };

const uid = 'worker-user';
const date = '2026-10-25';
const cutoff = Date.UTC(2026, 9, 25, 15);
const leaseMs = 120000;
const failureMessage = 'X posting worker operation failed';
const raw = 'synthetic-private-provider-value';

function initial(): PostingJob {
  return createPostingJob({
    goalId: 'worker-goal', date, linkRevision: 7, now: cutoff,
    post: {
      text: 'frozen approved material', mediaIds: ['123'],
      counts: { monthlyMissedDays: 2, totalMissedDays: 4 },
    },
  });
}

function preparing(id = 'owner'): PostingJob {
  return transitionPostingJob(initial(), {
    kind: 'claim', claimId: id, now: cutoff, leaseMs,
  }).job;
}

function sending(id = 'owner'): PostingJob {
  return transitionPostingJob(preparing(id), {
    kind: 'begin_send', claimId: id, now: cutoff,
  }).job;
}

function available(
  job: PostingJob, changed = false, authorizeHttp = false, forceRefresh = false,
): ApplyResult {
  return { status: 'available', job, changed, authorizeHttp, forceRefresh };
}

function cancelled(): PostingJob {
  return transitionPostingJob(initial(), {
    kind: 'cancel', reason: 'posting_disabled', now: cutoff,
  }).job;
}

function terminal(status: 'posted' | 'failed' | 'unknown'): PostingJob {
  return transitionPostingJob(sending(), {
    kind: 'complete', claimId: 'owner', now: cutoff,
    outcome: status === 'posted' ? { kind: 'posted', postId: '99' }
      : { kind: status === 'failed' ? 'permanent' : 'unknown' },
  }).job;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const events: string[] = [];
  const model = { job: initial(), now: cutoff, forceRefresh: false };
  const hooks: Partial<Record<Action['kind'], Hook>> = {};
  const ready: TokenResult = {
    kind: 'ready', accessToken: 'synthetic-access', linkRevision: 7, candidateId: 'candidate',
  };
  const ensureJob = jest.fn<Promise<EnsurePostingJobResult>, [string, string]>(async () => {
    events.push('ensure');
    return { status: 'created' };
  });
  const newClaimId = jest.fn<string, []>(() => { events.push('id'); return 'owner'; });
  const apply = jest.fn<ReturnType<Store['apply']>, Parameters<Store['apply']>>(
    async (_uid, _date, action) => {
      events.push(`${action.kind}:start`);
      const hook = hooks[action.kind];
      let result: ApplyResult;
      if (hook) result = await hook(action);
      else {
        const before = model.job;
        const base = action.kind === 'claim'
          ? transitionPostingJob(before, { kind: 'recover', now: model.now }).job : before;
        const next = transitionPostingJob(base, { ...action, now: model.now });
        result = available(next.job, next.job !== before, next.authorizeHttp, model.forceRefresh);
      }
      if (result.status === 'available') model.job = result.job;
      events.push(`${action.kind}:commit`);
      return result;
    },
  );
  const cancelUncreated = jest.fn<
    ReturnType<Store['cancelUncreated']>, Parameters<Store['cancelUncreated']>
  >(async () => ({ status: 'cancelled' }));
  const acquire = jest.fn<ReturnType<Tokens['acquire']>, Parameters<Tokens['acquire']>>(
    async () => { events.push('tokens'); return ready; },
  );
  const post = jest.fn<Promise<PostResult>, [string, Payload]>(async () => {
    events.push('post');
    return { kind: 'posted', postId: '99' };
  });
  const deps = { ensureJob, store: { apply, cancelUncreated }, tokens: { acquire }, post, newClaimId };
  return {
    model, hooks, events, ready, ensureJob, apply, cancelUncreated, acquire, post, newClaimId,
    run: (user = uid, day = date) => processPostingDate(user, day, deps),
  };
}

async function genericFailure(operation: () => Promise<unknown>) {
  const error: unknown = await operation().then(() => undefined, (value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(failureMessage);
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(raw);
  expect(JSON.stringify(error)).not.toContain(raw);
}

function noHttp(h: ReturnType<typeof fixture>) {
  expect(h.post).not.toHaveBeenCalled();
  expect(h.apply.mock.calls.some((call) => call[2].kind === 'complete')).toBe(false);
}

function expectComplete(
  h: ReturnType<typeof fixture>,
  outcome: Extract<Action, { kind: 'complete' }>['outcome'],
  feedback: NonNullable<Parameters<Store['apply']>[3]>,
) {
  expect(h.post).toHaveBeenCalledTimes(1);
  expect(h.acquire).toHaveBeenCalledTimes(1);
  expect(h.apply.mock.calls.map((call) => call[2].kind)).toEqual(['claim', 'begin_send', 'complete']);
  expect(h.apply.mock.calls[2]).toEqual([uid, date, {
    kind: 'complete', claimId: 'owner', outcome,
  }, feedback]);
}

describe('processPostingDate injected dependencies', () => {
  test('invalid UID/date fails generically before any dependency', async () => {
    const inputs: [string, string][] = [
      ...['', ' ', '.', '..', 'a/b', '__reserved__', '\ud800', 'a'.repeat(129)]
        .map((value): [string, string] => [value, date]),
      ...['', '../bad', '2026-02-30', '2026-1-01', `${date}/bad`]
        .map((value): [string, string] => [uid, value]),
    ];
    for (const [user, day] of inputs) {
      const h = fixture();
      await genericFailure(() => h.run(user, day));
      expect(h.events).toEqual([]);
      expect(h.cancelUncreated).not.toHaveBeenCalled();
      noHttp(h);
    }
  });

  test('ensure no work and unavailable results stop before claim or tokens', async () => {
    const cases: [EnsurePostingJobResult, string][] = [
      [{ status: 'no_pending' }, 'skipped'], [{ status: 'beforeCoverage' }, 'skipped'],
      [{ status: 'noAccount' }, 'unavailable'], [{ status: 'deleting' }, 'unavailable'],
    ];
    for (const [result, expected] of cases) {
      const h = fixture();
      h.ensureJob.mockResolvedValue(result);
      expect(await h.run()).toEqual({ status: expected });
      expect(h.ensureJob).toHaveBeenCalledWith(uid, date);
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.newClaimId).not.toHaveBeenCalled();
      expect(h.cancelUncreated).not.toHaveBeenCalled();
      noHttp(h);
    }
  });

  test('ensure cancellation persists once; opaque unchanged means skipped', async () => {
    const cases: [Awaited<ReturnType<Store['cancelUncreated']>>, string][] = [
      [{ status: 'cancelled' }, 'cancelled'], [{ status: 'unchanged' }, 'skipped'],
      [{ status: 'missing' }, 'unavailable'], [{ status: 'noAccount' }, 'unavailable'],
      [{ status: 'deleting' }, 'unavailable'],
    ];
    for (const [result, expected] of cases) {
      const h = fixture();
      h.ensureJob.mockResolvedValue({ status: 'cancelled', reason: 'posting_disabled' });
      h.cancelUncreated.mockResolvedValue(result);
      expect(await h.run()).toEqual({ status: expected });
      expect(h.cancelUncreated.mock.calls).toEqual([[uid, date]]);
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.newClaimId).not.toHaveBeenCalled();
      noHttp(h);
    }
  });

  test.each(['created', 'existing'] as const)('%s connects durable stages in order', async (status) => {
    const h = fixture();
    h.ensureJob.mockResolvedValueOnce({ status });
    expect(await h.run()).toEqual({ status: 'posted' });
    expect(h.newClaimId).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0]).toEqual([uid, date, { kind: 'claim', claimId: 'owner', leaseMs }]);
    expect(h.acquire.mock.calls).toEqual([[uid, 7, false]]);
    expect(h.apply.mock.calls[1]).toEqual([uid, date, { kind: 'begin_send', claimId: 'owner' }]);
    expect(h.post.mock.calls).toEqual([['synthetic-access', { text: initial().post.text, mediaIds: ['123'] }]]);
    expectComplete(h, { kind: 'posted', postId: '99' }, { lastHttpStatus: 201 });
    expect(h.events).toEqual(['id', 'claim:start', 'claim:commit', 'tokens',
      'begin_send:start', 'begin_send:commit', 'post', 'complete:start', 'complete:commit']);
    expect(h.cancelUncreated).not.toHaveBeenCalled();
  });

  test('claim returns actual terminal, ready and waiting dispositions', async () => {
    const cases: [PostingJob, string][] = [
      [terminal('posted'), 'posted'], [terminal('failed'), 'failed'],
      [terminal('unknown'), 'unknown'], [cancelled(), 'cancelled'],
      [initial(), 'retry_wait'], [preparing('other'), 'waiting'], [sending('other'), 'waiting'],
    ];
    for (const [job, expected] of cases) {
      const h = fixture();
      h.hooks.claim = async () => available(job);
      expect(await h.run()).toEqual({ status: expected });
      expect(h.apply).toHaveBeenCalledTimes(1);
      expect(h.acquire).not.toHaveBeenCalled();
      noHttp(h);
    }
  });

  test('changed preparation and matching owner are both required before token access', async () => {
    for (const result of [available(preparing()), available(preparing('other'), true),
      available(sending(), true, true)]) {
      const h = fixture();
      h.hooks.claim = async () => result;
      expect(await h.run()).toEqual({ status: 'waiting' });
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.apply).toHaveBeenCalledTimes(1);
      noHttp(h);
    }
  });

  test('claim unavailable results never acquire credentials', async () => {
    for (const status of ['missing', 'noAccount', 'deleting'] as const) {
      const h = fixture();
      h.hooks.claim = async () => ({ status });
      expect(await h.run()).toEqual({ status: 'unavailable' });
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.apply).toHaveBeenCalledTimes(1);
      noHttp(h);
    }
  });

  test('busy credentials retain preparing without consuming a POST attempt', async () => {
    const h = fixture();
    h.acquire.mockResolvedValue({ kind: 'busy' });
    expect(await h.run()).toEqual({ status: 'waiting' });
    expect(h.model.job).toMatchObject({ status: 'preparing', attempt: 0, claim: { id: 'owner' } });
    expect(h.acquire.mock.calls).toEqual([[uid, 7, false]]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    noHttp(h);
  });

  test.each<TokenResult>([
    { kind: 'rejected', status: 429 },
    { kind: 'rejected', status: 503, oauthError: 'server_error' },
    { kind: 'rejected', status: 400, oauthError: 'temporarily_unavailable' },
  ])('known temporary token refusal waits without POST: %j', async (result) => {
    const h = fixture();
    h.acquire.mockResolvedValue(result);
    expect(await h.run()).toEqual({ status: 'waiting' });
    expect(h.model.job).toMatchObject({ status: 'preparing', attempt: 0 });
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledTimes(1);
    noHttp(h);
  });

  test('relink-required token outcomes abort with fixed feedback and no HTTP status', async () => {
    for (const reason of ['unlinked', 'blocked', 'invalid_grant', 'unknown_refresh'] as const) {
      const h = fixture();
      h.acquire.mockResolvedValue({ kind: 'relink_required', reason });
      expect(await h.run()).toEqual({ status: 'failed' });
      expect(h.apply.mock.calls[1]).toEqual([uid, date,
        { kind: 'abort_preparation', claimId: 'owner' }, { failureReason: 'relink_required' }]);
      expect(h.apply).toHaveBeenCalledTimes(2);
      expect(h.acquire).toHaveBeenCalledTimes(1);
      noHttp(h);
    }
  });

  test('changed token generation, including inconsistent ready, cancels before begin', async () => {
    const h0 = fixture();
    const results: TokenResult[] = [
      { kind: 'link_changed' }, { ...h0.ready, kind: 'ready', linkRevision: 8 },
    ];
    for (const result of results) {
      const h = fixture();
      h.acquire.mockResolvedValue(result);
      expect(await h.run()).toEqual({ status: 'cancelled' });
      expect(h.apply.mock.calls[1]).toEqual([uid, date, { kind: 'cancel', reason: 'link_changed' }]);
      expect(h.apply).toHaveBeenCalledTimes(2);
      noHttp(h);
    }
  });

  test('other known OAuth refusal aborts with generic classification', async () => {
    const h = fixture();
    h.acquire.mockResolvedValue({ kind: 'rejected', status: 401, oauthError: 'invalid_client' });
    expect(await h.run()).toEqual({ status: 'failed' });
    expect(h.apply.mock.calls[1]).toEqual([uid, date,
      { kind: 'abort_preparation', claimId: 'owner' }, { failureReason: 'post_failed' }]);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    noHttp(h);
  });

  test('token SDK exception is generic and leaves durable preparation untouched', async () => {
    const h = fixture();
    h.acquire.mockRejectedValue(Object.assign(new Error(raw), { credential: raw }));
    await genericFailure(h.run);
    expect(h.model.job).toMatchObject({ status: 'preparing', attempt: 0 });
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    noHttp(h);
  });

  test('token acquisition awaits claim commit and receives persisted forceRefresh', async () => {
    const h = fixture();
    const entered = deferred<void>();
    const gate = deferred<ApplyResult>();
    h.hooks.claim = async () => { entered.resolve(); return gate.promise; };
    const running = h.run();
    await entered.promise;
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    gate.resolve(available(preparing(), true, false, true));
    expect(await running).toEqual({ status: 'posted' });
    expect(h.acquire.mock.calls).toEqual([[uid, 7, true]]);
  });

  test('begin requires changed, authorizeHttp and an owned sending state together', async () => {
    const cases: [ApplyResult, string][] = [
      [available(sending(), false, true), 'waiting'],
      [available(sending(), true, false), 'waiting'],
      [available(sending('other'), true, true), 'waiting'],
      [available(preparing(), true, true), 'waiting'],
      [available(initial(), false, false), 'retry_wait'],
    ];
    for (const [result, expected] of cases) {
      const h = fixture();
      h.hooks.begin_send = async () => result;
      expect(await h.run()).toEqual({ status: expected });
      expect(h.apply).toHaveBeenCalledTimes(2);
      noHttp(h);
    }
  });

  test('OFF, relink and unavailable begin results win over acquired credentials', async () => {
    const cases: [ApplyResult, string][] = [
      [available(cancelled(), true), 'cancelled'],
      ...(['missing', 'noAccount', 'deleting'] as const)
        .map((status): [ApplyResult, string] => [{ status }, 'unavailable']),
    ];
    for (const [result, expected] of cases) {
      const h = fixture();
      h.hooks.begin_send = async () => result;
      expect(await h.run()).toEqual({ status: expected });
      expect(h.acquire).toHaveBeenCalledTimes(1);
      expect(h.apply).toHaveBeenCalledTimes(2);
      noHttp(h);
    }
  });

  test('POST awaits begin commit and uses only its committed material', async () => {
    const h = fixture();
    const entered = deferred<void>();
    const gate = deferred<ApplyResult>();
    h.hooks.begin_send = async () => { entered.resolve(); return gate.promise; };
    const running = h.run();
    await entered.promise;
    expect(h.post).not.toHaveBeenCalled();
    const committed: PostingJob = {
      ...sending(), post: { ...initial().post, text: 'committed material', mediaIds: ['456', '789'] },
    };
    gate.resolve(available(committed, true, true));
    expect(await running).toEqual({ status: 'posted' });
    expect(h.post.mock.calls).toEqual([['synthetic-access',
      { text: 'committed material', mediaIds: ['456', '789'] }]]);
    expect(h.post.mock.calls[0][1]).not.toHaveProperty('counts');
    expectComplete(h, { kind: 'posted', postId: '99' }, { lastHttpStatus: 201 });
  });

  test('begin commit response failure never authorizes HTTP or releases a claim', async () => {
    const h = fixture();
    h.hooks.begin_send = async () => { throw new Error(raw); };
    await genericFailure(h.run);
    expect(h.apply.mock.calls.map((call) => call[2].kind)).toEqual(['claim', 'begin_send']);
    noHttp(h);
  });

  test('HTTP classifications persist precise receipts with no immediate refresh or retry', async () => {
    const cases: [number, 'retryable' | 'permanent' | 'unknown', string][] = [
      [401, 'retryable', 'retry_wait'], [429, 'retryable', 'retry_wait'],
      [400, 'permanent', 'failed'], [403, 'permanent', 'failed'],
      [408, 'unknown', 'unknown'], [500, 'unknown', 'unknown'],
      [200, 'unknown', 'unknown'], [204, 'unknown', 'unknown'], [302, 'unknown', 'unknown'],
    ];
    for (const [status, kind, expected] of cases) {
      const h = fixture();
      h.post.mockResolvedValue({ kind: 'http_error', status, retryAfterSeconds: 1 });
      expect(await h.run()).toEqual({ status: expected });
      expectComplete(h, { kind }, { lastHttpStatus: status,
        failureReason: status === 401 ? 'relink_required'
          : kind === 'unknown' ? 'unknown_post' : 'post_failed' });
      if (kind === 'retryable') expect(h.model.job).toMatchObject({
        status: 'ready', attempt: 1, nextAt: cutoff + 300000, lastClaimId: 'owner',
      });
    }
  });

  test('transport unknown outcomes terminate without inventing an HTTP status', async () => {
    for (const reason of ['network', 'timeout', 'invalid_response'] as const) {
      const h = fixture();
      h.post.mockResolvedValue({ kind: 'unknown', reason });
      expect(await h.run()).toEqual({ status: 'unknown' });
      expectComplete(h, { kind: 'unknown' }, { failureReason: 'unknown_post' });
    }
  });

  test('thrown POST transport is unknown, not a retry or leaked exception', async () => {
    const h = fixture();
    h.post.mockRejectedValue(Object.assign(new Error(raw), { credential: raw }));
    expect(await h.run()).toEqual({ status: 'unknown' });
    expectComplete(h, { kind: 'unknown' }, { failureReason: 'unknown_post' });
    expect(JSON.stringify(h.apply.mock.calls)).not.toContain(raw);
  });

  test('third known rejection returns core failure rather than promising another retry', async () => {
    for (const status of [401, 429]) {
      const h = fixture();
      h.model.job = { ...initial(), status: 'ready', attempt: 2, nextAt: cutoff, lastClaimId: 'old' };
      h.post.mockResolvedValue({ kind: 'http_error', status });
      expect(await h.run()).toEqual({ status: 'failed' });
      expectComplete(h, { kind: 'retryable' }, { lastHttpStatus: status,
        failureReason: status === 401 ? 'relink_required' : 'post_failed' });
      expect(h.model.job).toMatchObject({ status: 'failed', attempt: 3 });
    }
  });

  test('completion result determines return even when a different disposition wins', async () => {
    const cases: [ApplyResult, string][] = [
      [available(terminal('posted')), 'posted'], [available(terminal('failed')), 'failed'],
      [available(terminal('unknown')), 'unknown'], [available(cancelled()), 'cancelled'],
      [available(initial()), 'retry_wait'], [available(sending('other')), 'waiting'],
      ...(['missing', 'noAccount', 'deleting'] as const)
        .map((status): [ApplyResult, string] => [{ status }, 'unavailable']),
    ];
    for (const [result, expected] of cases) {
      const h = fixture();
      h.hooks.complete = async () => result;
      expect(await h.run()).toEqual({ status: expected });
      expectComplete(h, { kind: 'posted', postId: '99' }, { lastHttpStatus: 201 });
    }
  });

  test('abort and cancel also return the committed race disposition', async () => {
    const cases: [ApplyResult, string][] = [
      [available(cancelled(), true), 'cancelled'], [available(initial()), 'retry_wait'],
      [available(preparing('other')), 'waiting'], [{ status: 'deleting' }, 'unavailable'],
    ];
    for (const kind of ['abort_preparation', 'cancel'] as const) {
      for (const [result, expected] of cases) {
        const h = fixture();
        h.acquire.mockResolvedValue(kind === 'cancel' ? { kind: 'link_changed' }
          : { kind: 'relink_required', reason: 'blocked' });
        h.hooks[kind] = async () => result;
        expect(await h.run()).toEqual({ status: expected });
        expect(h.apply).toHaveBeenCalledTimes(2);
        noHttp(h);
      }
    }
  });

  test.each([false, true])('lost receipt response: committed=%s never reposts', async (committed) => {
    const h = fixture();
    h.hooks.complete = async (action) => {
      if (committed) h.model.job = transitionPostingJob(h.model.job, { ...action, now: h.model.now }).job;
      throw new Error(raw);
    };
    await genericFailure(h.run);
    expect(h.apply.mock.calls.map((call) => call[2].kind)).toEqual(['claim', 'begin_send', 'complete']);
    expect(h.model.job.status).toBe(committed ? 'posted' : 'sending');
    h.model.now += leaseMs;
    h.newClaimId.mockReturnValue('next_owner');
    expect(await h.run()).toEqual({ status: committed ? 'posted' : 'unknown' });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls.map((call) => call[2].kind)).toEqual(['claim', 'begin_send', 'complete', 'claim']);
  });

  test('earlier dependency exceptions are sanitized without fallback work', async () => {
    for (const stage of ['ensure', 'id', 'claim', 'cancelUncreated'] as const) {
      const h = fixture();
      const error = Object.assign(new Error(raw), { token: raw });
      if (stage === 'ensure') h.ensureJob.mockRejectedValue(error);
      if (stage === 'id') h.newClaimId.mockImplementation(() => { throw error; });
      if (stage === 'claim') h.hooks.claim = async () => { throw error; };
      if (stage === 'cancelUncreated') {
        h.ensureJob.mockResolvedValue({ status: 'cancelled', reason: 'link_changed' });
        h.cancelUncreated.mockRejectedValue(error);
      }
      await genericFailure(h.run);
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.apply.mock.calls.every((call) => call[2].kind === 'claim')).toBe(true);
      noHttp(h);
    }
  });
});
