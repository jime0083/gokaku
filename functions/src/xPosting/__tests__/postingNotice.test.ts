import { createHash } from 'node:crypto';

import { createPostingNotice } from '../postingNotice';

type Input = Parameters<typeof createPostingNotice>[0];
const input: Input = {
  date: '2026-10-25', goalId: 'goal-a', linkRevision: 2, kind: 'post_failed',
};

describe('posting notice factory', () => {
  test('hashes the ordered identity tuple deterministically and stores only protocol fields', () => {
    const expectedId = createHash('sha256')
      .update(JSON.stringify(['2026-10-25', 'goal-a', 2, 'post_failed']), 'utf8')
      .digest('hex');
    const result = createPostingNotice(Object.freeze({ ...input }));
    expect(result).toEqual({
      schemaVersion: 1, id: expectedId, date: input.date,
      linkRevision: 2, kind: 'post_failed', readAt: null,
    });
    expect(createPostingNotice({
      kind: input.kind, linkRevision: input.linkRevision, goalId: input.goalId, date: input.date,
    })).toEqual(result);
    for (const patch of [
      { date: '2026-10-26' }, { goalId: 'goal-b' }, { linkRevision: 3 },
      { kind: 'unknown_post' as const }, { kind: 'relink_required' as const },
    ]) expect(createPostingNotice({ ...input, ...patch }).id).not.toBe(expectedId);
    expect(createPostingNotice({ ...input, goalId: '資格📚' }).id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects malformed identity and extra fields instead of accepting body, tokens or client timestamps', () => {
    const malformed: unknown[] = [
      null, [], {}, { ...input, extra: true },
      { ...input, body: 'untrusted-body' }, { ...input, token: 'untrusted-token' },
      { ...input, readAt: 0 }, { ...input, date: '2026-02-30' },
      { ...input, date: '2026-10-25\n' }, { ...input, linkRevision: 0 },
      { ...input, linkRevision: 1.5 }, { ...input, linkRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, kind: 'posted' },
      ...['', ' ', '.', '..', 'a/b', '__reserved__', '\ud800', 'a'.repeat(1501)]
        .map((goalId) => ({ ...input, goalId })),
    ];
    for (const key of Object.keys(input)) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[key];
      malformed.push(missing);
    }
    const getter = jest.fn(() => { throw new Error('untrusted-token'); });
    const accessor = { ...input };
    Object.defineProperty(accessor, 'goalId', { enumerable: true, get: getter });
    const hidden = { ...input };
    Object.defineProperty(hidden, 'extra', { value: true });
    malformed.push(accessor, hidden, Object.create(input), { ...input, [Symbol('extra')]: true });
    for (const value of malformed) {
      try {
        createPostingNotice(value as Input);
        throw new Error('Expected validation failure');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Invalid posting notice input');
        expect((error as Error).cause).toBeUndefined();
      }
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
