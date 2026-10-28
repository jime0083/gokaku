import { readXNotice, selectXNotice, type XNotice } from '../index';

const notice: XNotice = {
  schemaVersion: 1, id: 'a'.repeat(64), date: '2026-10-25',
  linkRevision: 2, kind: 'post_failed', readAt: null,
};
const MIN_TIME = -62135596800000;
const MAX_TIME = 253402300799999;

function invalid(value: unknown) {
  expect(() => readXNotice(value)).toThrow('Invalid X notice');
}

describe('X notice protocol', () => {
  test('only absence means no notice; valid values are copied without coercion', () => {
    expect(readXNotice(undefined)).toBeNull();
    for (const kind of ['post_failed', 'unknown_post', 'relink_required'] as const) {
      for (const readAt of [null, MIN_TIME, 0, MAX_TIME]) {
        const input = Object.freeze({ ...notice, kind, readAt });
        const parsed = readXNotice(input);
        expect(parsed).toEqual(input);
        expect(parsed).not.toBe(input);
      }
    }
    expect(readXNotice({ ...notice, date: '2024-02-29', linkRevision: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ date: '2024-02-29', linkRevision: Number.MAX_SAFE_INTEGER });
  });

  test('rejects malformed shape, identity, date, revision and read time', () => {
    const cases: unknown[] = [
      null, [], 'notice', {},
      { ...notice, schemaVersion: 2 }, { ...notice, extra: true },
      { ...notice, id: 'a'.repeat(63) }, { ...notice, id: 'A'.repeat(64) },
      { ...notice, id: `${notice.id}\n` }, { ...notice, kind: 'posted' },
      ...['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '2026-10-25\n']
        .map((date) => ({ ...notice, date })),
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']
        .map((linkRevision) => ({ ...notice, linkRevision })),
      ...[NaN, Infinity, MIN_TIME - 1, MAX_TIME + 1, 0.5, '0', undefined]
        .map((readAt) => ({ ...notice, readAt })),
    ];
    for (const key of Object.keys(notice)) {
      const missing: Record<string, unknown> = { ...notice };
      delete missing[key];
      cases.push(missing);
    }
    for (const value of cases) invalid(value);
  });

  test('rejects inherited, hidden, symbol and accessor fields without invoking getters or leaking errors', () => {
    const getter = jest.fn(() => { throw new Error('untrusted-notice-value'); });
    const accessor = { ...notice };
    Object.defineProperty(accessor, 'readAt', { enumerable: true, get: getter });
    const hidden = { ...notice };
    Object.defineProperty(hidden, 'extra', { value: true });
    for (const value of [
      Object.create(notice), Object.assign(Object.create({ extra: true }), notice),
      { ...notice, [Symbol('extra')]: true }, accessor, hidden,
    ]) invalid(value);
    expect(getter).not.toHaveBeenCalled();
    try {
      readXNotice(accessor);
      throw new Error('Expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid X notice');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test('selection retains acknowledgements and newer target dates and does not mutate inputs', () => {
    const incoming = Object.freeze({ ...notice });
    expect(selectXNotice(undefined, incoming)).toEqual({ notice: incoming, changed: true });
    const acknowledged = Object.freeze({ ...notice, readAt: 1792940400000 });
    expect(selectXNotice(acknowledged, incoming))
      .toEqual({ notice: acknowledged, changed: false });
    const newer = Object.freeze({ ...notice, id: 'b'.repeat(64), date: '2026-10-26' });
    expect(selectXNotice(newer, incoming)).toEqual({ notice: newer, changed: false });
    const older = Object.freeze({ ...notice, id: 'c'.repeat(64), date: '2026-10-24', readAt: 0 });
    expect(selectXNotice(older, incoming)).toEqual({ notice: incoming, changed: true });
    expect(acknowledged.readAt).toBe(1792940400000);
    expect(incoming.readAt).toBeNull();
    expect(() => selectXNotice({ preserved: 'invalid legacy placeholder' }, incoming))
      .toThrow('Invalid X notice');
    expect(() => selectXNotice({ ...notice, date: '2026-10-24' }, incoming))
      .toThrow('Invalid X notice');
    expect(() => selectXNotice(undefined, { ...notice, readAt: NaN }))
      .toThrow('Invalid X notice');
  });
});
