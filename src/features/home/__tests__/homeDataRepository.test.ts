import type { XNotice } from '@shared/index';

const mockGetUid = jest.fn();
const mockGetDoc = jest.fn();
const mockGetDocs = jest.fn();
const mockDoc = jest.fn((_db: unknown, ...path: string[]) => path.join('/'));

jest.mock('@/config/firebase', () => ({ getCurrentUid: mockGetUid }));
jest.mock('@react-native-firebase/app', () => ({ getApp: jest.fn(() => ({})) }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  doc: mockDoc,
  getDoc: mockGetDoc,
  collection: jest.fn((_db: unknown, ...path: string[]) => path.join('/')),
  where: jest.fn(),
  query: jest.fn((ref: unknown) => ref),
  getDocs: mockGetDocs,
}));
jest.mock('@/features/goals/editGoalRepository', () => ({ parseEditableGoal: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetchHomeData } = require('../homeDataRepository') as typeof import('../homeDataRepository');
const notice: XNotice = {
  schemaVersion: 1, id: 'a'.repeat(64), date: '2026-10-26',
  linkRevision: 2, kind: 'post_failed', readAt: null,
};
const goal = { startDate: '2026-10-01', examDate: '2026-12-01', targetHours: 100 };
let user: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  user = { activeGoalId: 'goal' };
  mockGetUid.mockReturnValue('owner');
  mockGetDoc.mockImplementation(async (ref: string) => ({
    exists: () => true,
    data: () => ref === 'users/owner' ? user : goal,
  }));
  mockGetDocs.mockResolvedValue({ docs: [] });
});

it.each([
  ['post_failed', 'Xへの投稿に失敗しました'],
  ['unknown_post', '投稿結果を確認できませんでした'],
  ['relink_required', 'X連携が切れています'],
] as const)('reads the current root notice and maps %s to the approved message', async (kind, message) => {
  const stored: XNotice = { ...notice, kind };
  user.xNotice = stored;
  const result = await fetchHomeData();
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected home data');
  expect(result.data.notice).toEqual({ ...stored, message });
  expect(result.data.goal).toEqual(goal);
  expect(mockGetDoc).toHaveBeenCalledTimes(2);
  expect(mockDoc).toHaveBeenCalledWith(expect.anything(), 'users', 'owner');
});

it.each([undefined, 1793055600000])('returns no notice for a missing field or an acknowledged notice (%s)', async (readAt) => {
  if (readAt !== undefined) user.xNotice = { ...notice, readAt };
  const result = await fetchHomeData();
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected home data');
  expect(result.data.notice).toBeNull();
});

it.each([null, {}, { ...notice, date: '2026-02-30' }, { ...notice, id: 'legacy' }, { ...notice, kind: 'unsupported' }])(
  'returns an error for malformed stored notice rather than silently hiding it: %s', async (value) => {
    user.xNotice = value;
    await expect(fetchHomeData()).resolves.toEqual({ status: 'error' });
  },
);

it('does not query another owner when unauthenticated', async () => {
  mockGetUid.mockReturnValue(null);
  await expect(fetchHomeData()).resolves.toEqual({ status: 'no_goal' });
  expect(mockGetDoc).not.toHaveBeenCalled();
  expect(mockGetDocs).not.toHaveBeenCalled();
});
