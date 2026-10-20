import {
  parseLocalAccountData, inspectLocalAccountData, cleanupLocalAccountData,
  type LocalAccountStore, type RawEntry,
} from '../localAccountData';
import { INITIAL_ONBOARDING_DRAFT } from '../../onboarding/types';

const UID = 'owner-a';
const OTHER = 'owner-b';
const SESSIONS = 'timer:sessions:v1';
const EVENTS = 'timer:studyEventQueue:v1';
const DRAFT = 'onboarding:draft:v1';
const NOTICE = 'timer:autoStopNotice:v1';
const META = 'deviceToken:meta:v1';
const REPLACEMENT = 'onboarding:replacement:v1:';
const session = (uid = UID, stopAt: number | null = 200) => ({
  uid, sessionId: 's', startAt: 100, stopAt, checkEnabled: true, confirmations: [],
});
const event = (uid = UID) => ({
  uid, sessionId: 's', action: 'start', clientTimeMs: 100, idempotencyKey: 'e', checkEnabled: true,
});
const envelope = (uid: string, value: unknown) => ({ version: 2, uid, value });
const replacement = (uid = UID) => ({ uid, expectedGoalId: 'g', draft: INITIAL_ONBOARDING_DRAFT });
const entry = (key: string, value: unknown): RawEntry => [key, JSON.stringify(value)];
function harness(entries: readonly RawEntry[] = []) {
  const data = new Map(entries.filter((pair): pair is readonly [string, string] => pair[1] !== null));
  const store: jest.Mocked<LocalAccountStore> = {
    getAllKeys: jest.fn(async () => [...data.keys()]),
    getItem: jest.fn(async (key) => data.get(key) ?? null),
    setItem: jest.fn(async (key, raw) => { data.set(key, raw); }),
    removeItem: jest.fn(async (key) => { data.delete(key); }),
  };
  const guard = jest.fn(async () => {});
  return { data, store, guard };
}

it('recognizes only missing values and empty arrays as empty', () => {
  expect(parseLocalAccountData(UID, [[DRAFT, null], entry(SESSIONS, []), entry(EVENTS, [])]))
    .toEqual({ ownership: 'known', measuring: false, pendingRecords: false, unknownKeys: [] });
});
it.each(['', ' ', '{', 'null', '{}', 'false', '0', '""', '[null]'])(
  'does not treat corrupt session raw %j as empty', (raw) => {
    expect(parseLocalAccountData(UID, [[SESSIONS, raw]])).toMatchObject({
      ownership: 'unknown', unknownKeys: [SESSIONS],
    });
  },
);
it.each([SESSIONS, EVENTS, DRAFT, NOTICE, META, REPLACEMENT + UID])(
  'rejects malformed data at %s', (key) => {
    expect(parseLocalAccountData(UID, [entry(key, {})]).ownership).toBe('unknown');
  },
);
it('never adopts legacy sessions/events, anonymous drafts or notices', () => {
  const { uid: _sessionUid, ...legacySession } = session();
  const { uid: _eventUid, ...legacyEvent } = event();
  const values = [entry(SESSIONS, [legacySession]), entry(EVENTS, [legacyEvent]),
    entry(DRAFT, INITIAL_ONBOARDING_DRAFT), entry(NOTICE, { stoppedAt: 200 })];
  expect(parseLocalAccountData(UID, values).unknownKeys).toEqual(values.map(([key]) => key));
});
it('detects active sessions of any UID, but pending events only for the target', () => {
  expect(parseLocalAccountData(UID, [entry(SESSIONS, [session(OTHER, null)]), entry(EVENTS, [event(OTHER)])]))
    .toMatchObject({ ownership: 'known', measuring: true, pendingRecords: false });
  expect(parseLocalAccountData(UID, [entry(EVENTS, [event()])]).pendingRecords).toBe(true);
});
it.each([
  { ...session(), uid: '' }, { ...session(), uid: 1 },
  { ...session(), checkEnabled: undefined }, { ...session(), confirmations: [null] },
  { ...session(), stopAt: 'bad' }, { ...session(), sessionId: '' },
])('rejects invalid session without sanitizing: %j', (value) => {
  expect(parseLocalAccountData(UID, [entry(SESSIONS, [session(OTHER), value])]).ownership).toBe('unknown');
});
it.each([
  { ...event(), uid: undefined }, { ...event(), checkEnabled: undefined },
  { ...event(), action: 'bad' }, { ...event(), clientTimeMs: null },
])('rejects invalid event: %j', (value) => {
  expect(parseLocalAccountData(UID, [entry(EVENTS, [value])]).ownership).toBe('unknown');
});
it.each(['stop', 'confirm'])('accepts %s events without start-only checkEnabled', (action) => {
  const { checkEnabled: _check, ...value } = event();
  expect(parseLocalAccountData(UID, [entry(EVENTS, [{ ...value, action }])]).ownership).toBe('known');
});
it.each([
  [DRAFT, { version: 3, uid: UID, value: INITIAL_ONBOARDING_DRAFT }],
  [DRAFT, envelope(UID, { ...INITIAL_ONBOARDING_DRAFT, subjectCount: '3' })],
  [NOTICE, envelope(UID, { stoppedAt: null })],
  [META, { uid: UID, expiresAt: null }],
  [REPLACEMENT + UID, replacement(OTHER)],
  [REPLACEMENT + UID, { ...replacement(), oldSessionIds: [null] }],
  [REPLACEMENT + UID, { ...replacement(), draft: {} }],
  [REPLACEMENT + '%ZZ', replacement()],
] as const)('rejects invalid single value at %s', (key, value) => {
  expect(parseLocalAccountData(UID, [entry(key, value)]).ownership).toBe('unknown');
});
it('ignores permission history, checkpoint and unrelated keys even with malformed raw', async () => {
  const entries: RawEntry[] = [
    ['timer:notificationPermissionRequested:v1', 'true'],
    ['account:checkpoint:v1', '{'], ['unrelated', '{'],
  ];
  const h = harness(entries);
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect([...h.data]).toEqual(entries);
  expect(h.store.getItem).not.toHaveBeenCalled();
});
it('cleans only owned values and retains other UID records and extra fields', async () => {
  const otherSession = { ...session(OTHER), extra: { preserved: true } };
  const otherEvent = { ...event(OTHER), extra: 'keep' };
  const h = harness([
    entry(SESSIONS, [session(), otherSession]), entry(EVENTS, [event(), otherEvent]),
    entry(DRAFT, envelope(UID, INITIAL_ONBOARDING_DRAFT)),
    entry(NOTICE, envelope(OTHER, { stoppedAt: 200 })),
    entry(META, { uid: UID, expiresAt: 500 }),
    entry(REPLACEMENT + UID, replacement()), entry(REPLACEMENT + OTHER, replacement(OTHER)),
  ]);
  expect(await inspectLocalAccountData(UID, h.store, h.guard)).toMatchObject({ ownership: 'known', pendingRecords: true });
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect(JSON.parse(h.data.get(SESSIONS)!)).toEqual([otherSession]);
  expect(JSON.parse(h.data.get(EVENTS)!)).toEqual([otherEvent]);
  expect([...h.data.keys()].sort()).toEqual([SESSIONS, EVENTS, NOTICE, REPLACEMENT + OTHER].sort());
  const before = [...h.data];
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect([...h.data]).toEqual(before);
});
it('removes owned notice and fully owned arrays, keeps other metadata and draft', async () => {
  const h = harness([entry(SESSIONS, [session()]), entry(EVENTS, [event()]),
    entry(NOTICE, envelope(UID, { stoppedAt: 200 })),
    entry(META, { uid: OTHER, expiresAt: 500 }), entry(DRAFT, envelope(OTHER, INITIAL_ONBOARDING_DRAFT))]);
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect([...h.data.keys()].sort()).toEqual([META, DRAFT].sort());
});
it('preflights all data before any write when an unknown record exists', async () => {
  const h = harness([entry(META, { uid: UID, expiresAt: 500 }), [DRAFT, '{']]);
  const before = [...h.data];
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('local-account-data-unknown');
  expect([...h.data]).toEqual(before);
  expect(h.store.removeItem).not.toHaveBeenCalled();
  expect(h.store.setItem).not.toHaveBeenCalled();
});
it('rejects cleanup while any UID is measuring', async () => {
  const h = harness([entry(SESSIONS, [session(OTHER, null)]), entry(META, { uid: UID, expiresAt: 500 })]);
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('local-account-data-measuring');
  expect(h.store.removeItem).not.toHaveBeenCalled();
});
it('re-reads data rather than trusting earlier inspection', async () => {
  const h = harness();
  await inspectLocalAccountData(UID, h.store, h.guard);
  h.data.set(DRAFT, '{');
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('local-account-data-unknown');
});
it.each(['getAllKeys', 'getItem', 'setItem', 'removeItem'] as const)('propagates %s failure and permits retry', async (port) => {
  const h = harness([entry(SESSIONS, [session(), session(OTHER)]), entry(META, { uid: UID, expiresAt: 500 })]);
  h.store[port].mockRejectedValueOnce(new Error('storage-failed'));
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('storage-failed');
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect([...h.data]).toEqual([entry(SESSIONS, [session(OTHER)])]);
});
it('resumes after a partial cleanup without losing another UID', async () => {
  const h = harness([entry(SESSIONS, [session()]), entry(META, { uid: UID, expiresAt: 500 }),
    entry(REPLACEMENT + OTHER, replacement(OTHER))]);
  h.store.removeItem.mockImplementationOnce(async (key) => { h.data.delete(key); });
  h.store.removeItem.mockRejectedValueOnce(new Error('second-write-failed'));
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('second-write-failed');
  expect(h.data.has(SESSIONS)).toBe(false);
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect([...h.data]).toEqual([entry(REPLACEMENT + OTHER, replacement(OTHER))]);
});
it.each([1, 2, 3, 4, 5, 6])('guard rejection at boundary %s prevents a delete', async (boundary) => {
  const h = harness([entry(META, { uid: UID, expiresAt: 500 })]);
  h.guard.mockImplementation(async () => {
    if (h.guard.mock.calls.length === boundary) throw new Error('guard-failed');
  });
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('guard-failed');
  expect(h.store.removeItem).not.toHaveBeenCalled();
});
it('checks guard after a write and permits explicit retry after rejection', async () => {
  const h = harness([entry(META, { uid: UID, expiresAt: 500 })]);
  h.store.removeItem.mockImplementationOnce(async (key) => {
    h.data.delete(key);
    h.guard.mockRejectedValueOnce(new Error('guard-after-write'));
  });
  await expect(cleanupLocalAccountData(UID, h.store, h.guard)).rejects.toThrow('guard-after-write');
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect(h.data.size).toBe(0);
});
it.each(['', ' '])('rejects empty target UID %j before accessing storage', async (uid) => {
  const h = harness();
  expect(() => parseLocalAccountData(uid, [])).toThrow('local-account-invalid-uid');
  await expect(cleanupLocalAccountData(uid, h.store, h.guard)).rejects.toThrow('local-account-invalid-uid');
  expect(h.store.getAllKeys).not.toHaveBeenCalled();
});

it('accepts owned drafts with incomplete or invalid business inputs without normalizing', async () => {
  const draft = { ...INITIAL_ONBOARDING_DRAFT, university: '', targetDeviationText: 'invalid',
    currentDeviationText: '-1', subjectCount: -2.5, targetHoursText: '0.',
    examDate: '2026-02-30', minDailyMinutes: -1, goalDailyMinutes: 0 };
  const h = harness([entry(DRAFT, envelope(UID, draft)),
    entry(REPLACEMENT + UID, { ...replacement(), draft })]);
  expect(await inspectLocalAccountData(UID, h.store, h.guard)).toMatchObject({ ownership: 'known' });
  await cleanupLocalAccountData(UID, h.store, h.guard);
  expect(h.data.size).toBe(0);
});
