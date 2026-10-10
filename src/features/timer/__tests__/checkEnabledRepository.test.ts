/**
 * checkEnabledRepository(5-2b。requirements 3-2「勉強中？」確認(初期値ON))のユニットテスト。
 * studyEventSender.test.ts と同じ理由で、テスト対象を require で読み込む。
 */
const mockGetCurrentUid = jest.fn();
const mockGetApp = jest.fn(() => ({}));
const mockGetFirestore = jest.fn(() => ({}));
const mockDoc = jest.fn(() => ({}));
const mockGetDoc = jest.fn();

jest.mock('@/config/firebase', () => ({
  getCurrentUid: mockGetCurrentUid,
}));
jest.mock('@react-native-firebase/app', () => ({
  getApp: mockGetApp,
}));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  doc: mockDoc,
  getDoc: mockGetDoc,
}));

const { fetchCheckEnabled } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/features/timer/checkEnabledRepository') as typeof import('@/features/timer/checkEnabledRepository');

describe('fetchCheckEnabled(5-2b)', () => {
  beforeEach(() => {
    mockGetCurrentUid.mockReset();
    mockGetDoc.mockReset();
  });

  it('未ログインの場合は初期値 ON(true)', async () => {
    mockGetCurrentUid.mockReturnValue(null);
    expect(await fetchCheckEnabled()).toBe(true);
    expect(mockGetDoc).not.toHaveBeenCalled();
  });

  it('users/{uid}.checkEnabled が false なら false', async () => {
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => ({ checkEnabled: false }) });
    expect(await fetchCheckEnabled()).toBe(false);
  });

  it('users/{uid}.checkEnabled が true なら true', async () => {
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => ({ checkEnabled: true }) });
    expect(await fetchCheckEnabled()).toBe(true);
  });

  it('値がない(未設定)場合は初期値 ON(true)', async () => {
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => ({}) });
    expect(await fetchCheckEnabled()).toBe(true);
  });

  it('ドキュメントが存在しない場合は初期値 ON(true)', async () => {
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockGetDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    expect(await fetchCheckEnabled()).toBe(true);
  });

  it('読み込みに失敗(通信エラー等)した場合は初期値 ON(true)', async () => {
    mockGetCurrentUid.mockReturnValue('uid-1');
    mockGetDoc.mockRejectedValue(new Error('network error'));
    expect(await fetchCheckEnabled()).toBe(true);
  });
});
