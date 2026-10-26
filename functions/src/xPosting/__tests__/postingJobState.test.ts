import type { MissedStudyPost } from '../../../../shared/missedStudyPost';
import {
  createPostingJob,
  transitionPostingJob,
  type PostingJob,
} from '../postingJobState';

type Input = Parameters<typeof createPostingJob>[0];
type Command = Parameters<typeof transitionPostingJob>[1];

const NOW = 1_800_000_000_000;
const LEASE = 60_000;
const RETRY = 300_000;
const MIN_TIME = -62_135_596_800_000;
const MAX_TIME = 253_402_300_799_999;
const POST_ID = '123456789012345678901234567890';
const FAILURE = 'Invalid posting job input';

function material(): MissedStudyPost {
  return {
    text: '本日の最低目標学習時間を達成できませんでした\n#今月2回目\n#累計3回目',
    mediaIds: ['12345678901234567890'],
    counts: { monthlyMissedDays: 2, totalMissedDays: 3 },
  };
}

function input(): Input {
  return {
    goalId: 'goal-a',
    date: '2026-10-25',
    linkRevision: 2,
    post: material(),
    now: NOW,
  };
}

function ready(): PostingJob {
  return createPostingJob(input());
}

function claim(job: PostingJob, id = 'claim-a', now = NOW): PostingJob {
  const result = transitionPostingJob(job, {
    kind: 'claim', claimId: id, now, leaseMs: LEASE,
  });
  expect(result.authorizeHttp).toBe(false);
  return result.job;
}

function sending(): PostingJob {
  return transitionPostingJob(claim(ready()), {
    kind: 'begin_send', claimId: 'claim-a', now: NOW + 1,
  }).job;
}

function noop(job: PostingJob, command: Command): void {
  const result = transitionPostingJob(job, command);
  expect(result.job).toBe(job);
  expect(result.authorizeHttp).toBe(false);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((entry: unknown) => freeze(entry));
    Object.freeze(value);
  }
  return value;
}

function invalid(operation: () => unknown): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.constructor).toBe(Error);
  expect(error.message).toBe(FAILURE);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
}

function rawTransition(job: unknown, command: unknown): void {
  invalid(() => transitionPostingJob(job as PostingJob, command as Command));
}

describe('postingJobState', () => {
  test('creates the exact ready snapshot without consuming an attempt', () => {
    const value = input();
    expect(createPostingJob(value)).toEqual({
      goalId: value.goalId,
      date: value.date,
      linkRevision: value.linkRevision,
      createdAt: NOW,
      post: value.post,
      attempt: 0,
      status: 'ready',
      nextAt: NOW,
      lastClaimId: null,
    });
  });

  test('snapshots nested material so later caller mutation cannot change the job', () => {
    const value = input();
    const ids = ['12345678901234567890'];
    value.post.mediaIds = ids;
    const job = createPostingJob(value);
    const snapshot = material();
    value.goalId = 'another-goal';
    value.post.text = 'changed';
    value.post.counts.monthlyMissedDays = 99;
    ids.push('77');
    expect(job.goalId).toBe('goal-a');
    expect(job.post).toEqual(snapshot);
    expect(job.post).not.toBe(value.post);
    expect(job.post.counts).not.toBe(value.post.counts);
    expect(job.post.mediaIds).not.toBe(ids);
  });

  test('accepts deeply frozen inputs and changes neither job nor command', () => {
    const job = freeze(createPostingJob(freeze(input())));
    const before = JSON.stringify(job);
    const command = freeze({
      kind: 'claim' as const, claimId: 'claim-a', now: NOW, leaseMs: LEASE,
    });
    const result = transitionPostingJob(job, command);
    expect(result.job).not.toBe(job);
    expect(JSON.stringify(job)).toBe(before);
    expect(command).toEqual({
      kind: 'claim', claimId: 'claim-a', now: NOW, leaseMs: LEASE,
    });
    const prepared = freeze(result.job);
    const send = transitionPostingJob(prepared, freeze({
      kind: 'begin_send' as const, claimId: 'claim-a', now: NOW + 1,
    }));
    expect(send.authorizeHttp).toBe(true);
    expect(prepared.status).toBe('preparing');
  });

  test('claim only prepares a due job and does not authorize HTTP', () => {
    const job = ready();
    const prepared = claim(job);
    const { nextAt: _nextAt, lastClaimId: _lastClaimId, ...common } =
      job as Extract<PostingJob, { status: 'ready' }>;
    expect(prepared).toEqual({
      ...common,
      status: 'preparing',
      claim: { id: 'claim-a', expiresAt: NOW + LEASE },
    });
    expect(job.status).toBe('ready');
  });

  test('ready is claimable exactly at nextAt, never a millisecond early', () => {
    const job = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 100,
      outcome: { kind: 'retryable' },
    }).job;
    noop(job, {
      kind: 'claim', claimId: 'claim-b', now: NOW + 100 + RETRY - 1,
      leaseMs: LEASE,
    });
    expect(claim(job, 'claim-b', NOW + 100 + RETRY).status).toBe('preparing');
  });

  test('a busy preparing job rejects competing claims and completion', () => {
    const job = claim(ready());
    noop(job, { kind: 'claim', claimId: 'claim-b', now: NOW + 1, leaseMs: LEASE });
    noop(job, {
      kind: 'complete', claimId: 'claim-a', now: NOW + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    });
  });

  test('recover does not turn preparing into an authorized send', () => {
    const job = claim(ready());
    noop(job, { kind: 'recover', now: NOW + LEASE - 1 });
    const recovered = transitionPostingJob(job, { kind: 'recover', now: NOW + LEASE });
    expect(recovered.authorizeHttp).toBe(false);
    expect(recovered.job.attempt).toBe(0);
    expect(claim(recovered.job, 'claim-b', NOW + LEASE).status).toBe('preparing');
  });

  test('a different owner can replace preparing exactly at lease expiry', () => {
    const job = claim(ready());
    const replaced = claim(job, 'claim-b', NOW + LEASE);
    expect(replaced).toMatchObject({
      status: 'preparing', attempt: 0,
      claim: { id: 'claim-b', expiresAt: NOW + 2 * LEASE },
    });
    noop(replaced, { kind: 'begin_send', claimId: 'claim-a', now: NOW + LEASE });
    expect(transitionPostingJob(replaced, {
      kind: 'begin_send', claimId: 'claim-b', now: NOW + LEASE,
    }).authorizeHttp).toBe(true);
  });

  test('reusing the current or last claim ID is a no-op even after expiry', () => {
    const prepared = claim(ready());
    noop(prepared, {
      kind: 'claim', claimId: 'claim-a', now: NOW + LEASE, leaseMs: LEASE,
    });
    const retry = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 100,
      outcome: { kind: 'retryable' },
    }).job;
    noop(retry, {
      kind: 'claim', claimId: 'claim-a', now: NOW + 100 + RETRY,
      leaseMs: LEASE,
    });
  });

  test('stale owners cannot begin or complete a replacement claim', () => {
    const job = claim(claim(ready()), 'claim-b', NOW + LEASE);
    noop(job, { kind: 'begin_send', claimId: 'claim-a', now: NOW + LEASE });
    const active = transitionPostingJob(job, {
      kind: 'begin_send', claimId: 'claim-b', now: NOW + LEASE,
    }).job;
    noop(active, {
      kind: 'complete', claimId: 'claim-a', now: NOW + LEASE + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    });
    noop(active, {
      kind: 'claim', claimId: 'claim-c', now: NOW + LEASE + 1, leaseMs: LEASE,
    });
  });

  test('only a live preparing owner begins sending and consumes one attempt', () => {
    const prepared = claim(ready());
    const result = transitionPostingJob(prepared, {
      kind: 'begin_send', claimId: 'claim-a', now: NOW + LEASE - 1,
    });
    expect(result.authorizeHttp).toBe(true);
    expect(result.job).toEqual({
      ...prepared, status: 'sending', attempt: 1, startedAt: NOW + LEASE - 1,
    });
    expect(prepared.attempt).toBe(0);
  });

  test('begin_send rejects an expired owner, a foreign owner and an unclaimed job', () => {
    const job = claim(ready());
    noop(job, { kind: 'begin_send', claimId: 'claim-a', now: NOW + LEASE });
    noop(job, { kind: 'begin_send', claimId: 'claim-b', now: NOW + 1 });
    noop(ready(), { kind: 'begin_send', claimId: 'claim-a', now: NOW });
  });

  test('replaying begin_send cannot authorize a second HTTP call', () => {
    const job = sending();
    noop(job, { kind: 'begin_send', claimId: 'claim-a', now: NOW + 2 });
    noop(job, { kind: 'begin_send', claimId: 'claim-a', now: NOW + LEASE });
    expect(job.attempt).toBe(1);
  });

  test('success preserves the complete numeric post ID without number coercion', () => {
    const initial = ready();
    const result = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 2,
      outcome: { kind: 'posted', postId: POST_ID },
    });
    expect(result.authorizeHttp).toBe(false);
    expect(result.job).toEqual({
      goalId: initial.goalId, date: initial.date, linkRevision: initial.linkRevision,
      createdAt: NOW, post: initial.post, attempt: 1, status: 'posted', postId: POST_ID,
    });
  });

  test('retryable completion schedules five minutes from completion then allows success', () => {
    const completedAt = NOW + 20_000;
    const result = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: completedAt,
      outcome: { kind: 'retryable' },
    });
    expect(result.authorizeHttp).toBe(false);
    expect(result.job).toEqual({
      ...ready(), attempt: 1, nextAt: completedAt + RETRY, lastClaimId: 'claim-a',
    });
    const second = transitionPostingJob(claim(result.job, 'claim-b', completedAt + RETRY), {
      kind: 'begin_send', claimId: 'claim-b', now: completedAt + RETRY,
    });
    expect(second.authorizeHttp).toBe(true);
    expect(second.job.attempt).toBe(2);
    expect(transitionPostingJob(second.job, {
      kind: 'complete', claimId: 'claim-b', now: completedAt + RETRY + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    }).job).toMatchObject({ status: 'posted', attempt: 2, postId: POST_ID });
  });

  test('three retryable failures consume exactly three attempts and finish failed', () => {
    let job = ready();
    let now = NOW;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const id = `claim-${attempt}`;
      const prepared = claim(job, id, now);
      expect(prepared.attempt).toBe(attempt - 1);
      const begun = transitionPostingJob(prepared, { kind: 'begin_send', claimId: id, now });
      expect(begun.authorizeHttp).toBe(true);
      expect(begun.job.attempt).toBe(attempt);
      now += 123;
      const result = transitionPostingJob(begun.job, {
        kind: 'complete', claimId: id, now, outcome: { kind: 'retryable' },
      });
      expect(result.authorizeHttp).toBe(false);
      job = result.job;
      if (attempt < 3) {
        expect(job).toMatchObject({ status: 'ready', nextAt: now + RETRY, lastClaimId: id });
        noop(job, { kind: 'claim', claimId: `claim-${attempt + 1}`, now: now + RETRY - 1, leaseMs: LEASE });
        now += RETRY;
      }
    }
    expect(job).toEqual({
      goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
      createdAt: NOW, post: material(), attempt: 3, status: 'failed',
    });
    noop(job, { kind: 'claim', claimId: 'claim-four', now: now + RETRY, leaseMs: LEASE });
  });

  test('permanent failure is terminal on the first attempt', () => {
    const result = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 2,
      outcome: { kind: 'permanent' },
    });
    expect(result).toEqual({
      job: {
        goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
        createdAt: NOW, post: material(), attempt: 1, status: 'failed',
      },
      authorizeHttp: false,
    });
  });

  test('an explicitly unknown outcome never schedules a retry', () => {
    const result = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 2,
      outcome: { kind: 'unknown' },
    });
    expect(result.authorizeHttp).toBe(false);
    expect(result.job).toEqual({
      goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
      createdAt: NOW, post: material(), attempt: 1, status: 'unknown',
    });
  });

  test('sending recovers to unknown exactly at expiry and cannot be reclaimed', () => {
    const job = sending();
    noop(job, { kind: 'recover', now: NOW + LEASE - 1 });
    noop(job, { kind: 'claim', claimId: 'claim-b', now: NOW + LEASE, leaseMs: LEASE });
    const result = transitionPostingJob(job, { kind: 'recover', now: NOW + LEASE });
    expect(result.authorizeHttp).toBe(false);
    expect(result.job).toMatchObject({ status: 'unknown', attempt: 1 });
    noop(result.job, {
      kind: 'complete', claimId: 'claim-a', now: NOW + LEASE + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    });
    noop(result.job, { kind: 'claim', claimId: 'claim-b', now: NOW + LEASE + 1, leaseMs: LEASE });
  });

  test('current-owner completion may arrive after expiry while still sending', () => {
    const result = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + LEASE + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    });
    expect(result.authorizeHttp).toBe(false);
    expect(result.job).toMatchObject({ status: 'posted', postId: POST_ID, attempt: 1 });
  });

  test.each(['posting_disabled', 'link_changed', 'not_authorized_at_cutoff'] as const)(
    'cancels only unsent work with reason %s', (reason) => {
      for (const job of [ready(), claim(ready())]) {
        const result = transitionPostingJob(freeze(job), { kind: 'cancel', now: NOW + 1, reason });
        expect(result.authorizeHttp).toBe(false);
        expect(result.job).toEqual({
          goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
          createdAt: NOW, post: material(), attempt: 0, status: 'cancelled', reason,
        });
      }
    },
  );

  test('cancel cannot overwrite a send that has already begun', () => {
    const job = sending();
    noop(job, { kind: 'cancel', now: NOW + 2, reason: 'posting_disabled' });
    noop(job, { kind: 'cancel', now: NOW + LEASE, reason: 'link_changed' });
  });

  test('all terminal states preserve identity for every valid command', () => {
    const active = sending();
    const terminals = [
      ...[
        { kind: 'posted' as const, postId: POST_ID },
        { kind: 'permanent' as const },
        { kind: 'unknown' as const },
      ].map((outcome) => transitionPostingJob(active, {
        kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome,
      }).job),
      transitionPostingJob(ready(), {
        kind: 'cancel', now: NOW + 2, reason: 'posting_disabled',
      }).job,
    ];
    const commands: Command[] = [
      { kind: 'claim', claimId: 'claim-b', now: NOW + RETRY, leaseMs: LEASE },
      { kind: 'begin_send', claimId: 'claim-a', now: NOW + RETRY },
      { kind: 'complete', claimId: 'claim-a', now: NOW + RETRY, outcome: { kind: 'posted', postId: POST_ID } },
      { kind: 'recover', now: NOW + RETRY },
      { kind: 'cancel', now: NOW + RETRY, reason: 'link_changed' },
    ];
    for (const job of terminals) {
      for (const command of commands) noop(freeze(job), freeze(command));
    }
    noop(ready(), { kind: 'recover', now: NOW });
  });

  test('keeps fixed text, images, counts and linkage through replacement and retry', () => {
    const original = ready();
    const prepared = claim(claim(original), 'claim-b', NOW + LEASE);
    const begun = transitionPostingJob(prepared, {
      kind: 'begin_send', claimId: 'claim-b', now: NOW + LEASE,
    }).job;
    const retry = transitionPostingJob(begun, {
      kind: 'complete', claimId: 'claim-b', now: NOW + LEASE + 1,
      outcome: { kind: 'retryable' },
    }).job;
    for (const job of [prepared, begun, retry]) {
      expect(job.post).toEqual(original.post);
      expect(job.goalId).toBe(original.goalId);
      expect(job.date).toBe(original.date);
      expect(job.linkRevision).toBe(original.linkRevision);
      expect(job.createdAt).toBe(original.createdAt);
    }
  });

  test('accepts SDK epoch boundaries and valid UTF-8 without coercing material', () => {
    for (const now of [MIN_TIME, MAX_TIME]) {
      expect(createPostingJob({ ...input(), now }).createdAt).toBe(now);
    }
    const post = { ...material(), text: '学習📚\n#合格ウォッチ', mediaIds: ['0', '01', '2', POST_ID] };
    expect(createPostingJob({ ...input(), post }).post).toEqual(post);
    const emptyImages = { ...material(), mediaIds: [] };
    expect(createPostingJob({ ...input(), post: emptyImages }).post.mediaIds).toEqual([]);
  });

  test('rejects invalid creation identity, revision, date and epoch with one fixed error', () => {
    const cases: unknown[] = [
      null, [],
      { ...input(), goalId: '   ' },
      { ...input(), date: '2026-02-30' },
      { ...input(), linkRevision: 0 },
      { ...input(), linkRevision: 1.5 },
      { ...input(), linkRevision: Number.MAX_SAFE_INTEGER + 1 },
      ...[NaN, Infinity, NOW + 0.5, MIN_TIME - 1, MAX_TIME + 1, '1800000000000'].map((now) => ({ ...input(), now })),
    ];
    for (const value of cases) invalid(() => createPostingJob(value as Input));
  });

  test('rejects malformed fixed material rather than repairing it', () => {
    const posts: unknown[] = [
      null,
      { ...material(), text: '' },
      { ...material(), text: '\ud800' },
      { ...material(), mediaIds: ['not-a-number'] },
      { ...material(), mediaIds: [123] },
      { ...material(), mediaIds: ['1', '2', '3', '4', '5'] },
      { ...material(), mediaIds: new Array(1) },
      { ...material(), counts: { monthlyMissedDays: 0, totalMissedDays: 1 } },
      { ...material(), counts: { monthlyMissedDays: 1, totalMissedDays: -1 } },
      { ...material(), counts: { monthlyMissedDays: 1.5, totalMissedDays: 1 } },
      { ...material(), counts: { monthlyMissedDays: 1, totalMissedDays: Number.MAX_SAFE_INTEGER + 1 } },
    ];
    for (const post of posts) invalid(() => createPostingJob({ ...input(), post } as Input));
  });

  test('validates commands including outcomes even when the operation would be a no-op', () => {
    const terminal = transitionPostingJob(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW + 2,
      outcome: { kind: 'unknown' },
    }).job;
    const commands: unknown[] = [
      null, [], { kind: 'unsupported', now: NOW },
      { kind: 'recover', now: NaN },
      { kind: 'claim', claimId: 'claim-b', now: NOW, leaseMs: 0 },
      { kind: 'claim', claimId: 'claim-b', now: NOW, leaseMs: 1.5 },
      { kind: 'claim', claimId: 'claim-b', now: NOW, leaseMs: Infinity },
      { kind: 'cancel', now: NOW, reason: 'other' },
      { kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome: null },
      { kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome: { kind: 'http_error' } },
      { kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome: { kind: 'posted', postId: 123 } },
      { kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome: { kind: 'posted', postId: '123\n' } },
    ];
    for (const command of commands) rawTransition(terminal, command);
  });

  test('rejects corrupted persisted job invariants before transitioning', () => {
    const job = ready();
    const prepared = claim(job);
    const active = sending();
    const jobs: unknown[] = [
      null, [], { ...job, status: 'other' },
      { ...job, goalId: '' },
      { ...job, date: '2026-13-01' },
      { ...job, linkRevision: 0 },
      { ...job, createdAt: NOW + 0.5 },
      { ...job, post: { ...material(), text: '\udfff' } },
      { ...job, attempt: -1 },
      { ...job, attempt: 0.5 },
      { ...job, attempt: 3 },
      { ...job, nextAt: NOW - 1 },
      { ...job, lastClaimId: 'bad/path' },
      { ...prepared, attempt: 3 },
      { ...prepared, claim: { id: 'claim-a', expiresAt: NOW - 1 } },
      { ...active, attempt: 0 },
      { ...active, attempt: 4 },
      { ...active, startedAt: NOW - 1 },
      { ...active, startedAt: NOW + LEASE },
      { ...job, status: 'posted', attempt: 1, postId: 'invalid' },
      { ...job, status: 'cancelled', reason: 'other' },
    ];
    for (const value of jobs) rawTransition(value, { kind: 'recover', now: NOW + RETRY });
  });

  test('rejects time before creation and completion before send start', () => {
    rawTransition(ready(), { kind: 'recover', now: NOW - 1 });
    rawTransition(claim(ready()), { kind: 'begin_send', claimId: 'claim-a', now: NOW - 1 });
    rawTransition(sending(), {
      kind: 'complete', claimId: 'claim-a', now: NOW,
      outcome: { kind: 'posted', postId: POST_ID },
    });
    const active = sending();
    expect(transitionPostingJob(active, {
      kind: 'complete', claimId: 'claim-a', now: NOW + 1,
      outcome: { kind: 'posted', postId: POST_ID },
    }).job.status).toBe('posted');
  });

  test('rejects lease and retry deadlines outside SDK timestamp range', () => {
    const edge = createPostingJob({ ...input(), now: MAX_TIME - 10 });
    rawTransition(edge, {
      kind: 'claim', claimId: 'claim-a', now: MAX_TIME - 10, leaseMs: 11,
    });
    rawTransition(edge, {
      kind: 'claim', claimId: 'claim-a', now: MAX_TIME - 10,
      leaseMs: Number.MAX_SAFE_INTEGER,
    });
    const prepared = transitionPostingJob(edge, {
      kind: 'claim', claimId: 'claim-a', now: MAX_TIME - 10, leaseMs: 10,
    });
    expect(prepared.authorizeHttp).toBe(false);
    expect(prepared.job.status).toBe('preparing');
    expect(prepared.job).toHaveProperty('claim', {
      id: 'claim-a', expiresAt: MAX_TIME,
    });
  });

  test('rejects retry deadline overflow after a valid late owner completion', () => {
    const nearEnd = createPostingJob({ ...input(), now: MAX_TIME - 100 });
    const prepared = transitionPostingJob(nearEnd, {
      kind: 'claim', claimId: 'claim-a', now: MAX_TIME - 100, leaseMs: 10,
    }).job;
    const active = transitionPostingJob(prepared, {
      kind: 'begin_send', claimId: 'claim-a', now: MAX_TIME - 99,
    }).job;
    rawTransition(active, {
      kind: 'complete', claimId: 'claim-a', now: MAX_TIME,
      outcome: { kind: 'retryable' },
    });
    expect(transitionPostingJob(active, {
      kind: 'complete', claimId: 'claim-a', now: MAX_TIME,
      outcome: { kind: 'posted', postId: POST_ID },
    }).job.status).toBe('posted');
  });

  test('validates server claim identifiers without exposing supplied values', () => {
    for (const claimId of ['', 'a/b', '.', '..', '__reserved__', 'white space', 'a\n', '日本語', 'a'.repeat(1501)]) {
      for (const command of [
        { kind: 'claim', claimId, now: NOW, leaseMs: LEASE },
        { kind: 'begin_send', claimId, now: NOW },
        { kind: 'complete', claimId, now: NOW, outcome: { kind: 'unknown' } },
      ]) rawTransition(ready(), command);
    }
    for (const claimId of ['a_B-09', 'a'.repeat(1500)]) {
      expect(claim(ready(), claimId)).toMatchObject({
        status: 'preparing', claim: { id: claimId },
      });
    }
  });

  test('current live preparing owner can fail before POST without consuming an attempt', () => {
    const job = freeze(claim(ready()));
    const command = freeze({
      kind: 'abort_preparation' as const, claimId: 'claim-a', now: NOW + LEASE - 1,
    });
    const result = transitionPostingJob(job, command);
    expect(result).toEqual({
      job: {
        goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
        createdAt: NOW, post: material(), attempt: 0, status: 'failed',
      },
      authorizeHttp: false,
    });
    expect(job.status).toBe('preparing');
    const commands: Command[] = [
      { kind: 'abort_preparation', claimId: 'claim-a', now: NOW + RETRY },
      { kind: 'claim', claimId: 'claim-b', now: NOW + RETRY, leaseMs: LEASE },
      { kind: 'begin_send', claimId: 'claim-a', now: NOW + RETRY },
      { kind: 'complete', claimId: 'claim-a', now: NOW + RETRY, outcome: { kind: 'posted', postId: POST_ID } },
      { kind: 'recover', now: NOW + RETRY },
      { kind: 'cancel', now: NOW + RETRY, reason: 'link_changed' },
    ];
    for (const next of commands) noop(freeze(result.job), freeze(next));
  });

  test('abort_preparation rejects foreign or expired ownership and cannot overwrite other states', () => {
    const prepared = claim(ready());
    noop(prepared, { kind: 'abort_preparation', claimId: 'claim-b', now: NOW + 1 });
    noop(prepared, { kind: 'abort_preparation', claimId: 'claim-a', now: NOW + LEASE });
    const replaced = claim(prepared, 'claim-b', NOW + LEASE);
    noop(replaced, { kind: 'abort_preparation', claimId: 'claim-a', now: NOW + LEASE });
    const active = sending();
    const jobs = [
      ready(), active,
      ...[
        { kind: 'posted' as const, postId: POST_ID },
        { kind: 'permanent' as const },
        { kind: 'unknown' as const },
      ].map((outcome) => transitionPostingJob(active, {
        kind: 'complete', claimId: 'claim-a', now: NOW + 2, outcome,
      }).job),
      transitionPostingJob(ready(), {
        kind: 'cancel', now: NOW + 2, reason: 'posting_disabled',
      }).job,
    ];
    for (const job of jobs) {
      noop(freeze(job), { kind: 'abort_preparation', claimId: 'claim-a', now: NOW + 3 });
    }
    rawTransition(prepared, { kind: 'abort_preparation', claimId: 'bad/path', now: NOW + 1 });
    rawTransition(prepared, { kind: 'abort_preparation', claimId: 'claim-a', now: NOW - 1 });
  });

  test('aborting retry preparation preserves the one or two HTTP attempts already consumed', () => {
    let job = ready();
    let now = NOW;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claimId = `retry-owner-${attempt}`;
      const active = transitionPostingJob(claim(job, claimId, now), {
        kind: 'begin_send', claimId, now,
      });
      expect(active.authorizeHttp).toBe(true);
      now += 10;
      const retry = transitionPostingJob(active.job, {
        kind: 'complete', claimId, now, outcome: { kind: 'retryable' },
      });
      expect(retry.authorizeHttp).toBe(false);
      job = retry.job;
      now += RETRY;
      const prepared = freeze(claim(job, `abort-owner-${attempt}`, now));
      const result = transitionPostingJob(prepared, {
        kind: 'abort_preparation', claimId: `abort-owner-${attempt}`, now,
      });
      expect(result).toEqual({
        job: {
          goalId: 'goal-a', date: '2026-10-25', linkRevision: 2,
          createdAt: NOW, post: material(), attempt, status: 'failed',
        },
        authorizeHttp: false,
      });
      expect(prepared.attempt).toBe(attempt);
      expect(prepared.status).toBe('preparing');
    }
  });
});
