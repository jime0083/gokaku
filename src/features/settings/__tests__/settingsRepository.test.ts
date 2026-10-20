import { getCurrentUid } from '@/config/firebase';
import { doc, getDoc, updateDoc } from '@react-native-firebase/firestore';
import { rememberCheckEnabledSetting } from '@/features/timer/lockscreenSync';
import { loadSettings, updateSettings } from '../settingsRepository';

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/timer/lockscreenSync', () => ({ rememberCheckEnabledSetting: jest.fn() }));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => 'db'), doc: jest.fn(() => 'user-ref'), getDoc: jest.fn(), updateDoc: jest.fn(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  jest.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({}) } as never);
  jest.mocked(updateDoc).mockResolvedValue(undefined);
});
it('loads defaults only for missing fields, retaining the opening UID', async () => {
  expect(await loadSettings()).toEqual({ uid: 'owner', checkEnabled: true, xPostEnabled: false });
  expect(doc).toHaveBeenCalledWith('db', 'users', 'owner');
  jest.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({ checkEnabled: false, xPostEnabled: true }) } as never);
  expect(await loadSettings()).toEqual({ uid: 'owner', checkEnabled: false, xPostEnabled: true });
});
it('writes both booleans atomically then remembers future-start setting', async () => {
  let commit!: () => void;
  jest.mocked(updateDoc).mockImplementationOnce(() => new Promise<void>((resolve) => { commit = resolve; }));
  const pending = updateSettings('owner', { checkEnabled: false, xPostEnabled: true });
  expect(updateDoc).toHaveBeenCalledTimes(1);
  expect(updateDoc).toHaveBeenCalledWith('user-ref', { checkEnabled: false, xPostEnabled: true });
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
  commit();
  await pending;
  expect(rememberCheckEnabledSetting).toHaveBeenCalledWith(false);
});
it.each([null, 'new-user'])('rejects changed/missing UID %s before applying old draft', async (uid) => {
  const loaded = await loadSettings();
  jest.mocked(getCurrentUid).mockReturnValue(uid);
  await expect(updateSettings(loaded.uid, loaded)).rejects.toThrow();
  expect(updateDoc).not.toHaveBeenCalled();
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
});
it('propagates read/write failure instead of treating errors as defaults', async () => {
  jest.mocked(getDoc).mockRejectedValueOnce(new Error('offline'));
  await expect(loadSettings()).rejects.toThrow('offline');
  jest.mocked(updateDoc).mockRejectedValueOnce(new Error('offline'));
  await expect(updateSettings('owner', { checkEnabled: true, xPostEnabled: false })).rejects.toThrow('offline');
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
});
it('rejects missing user, invalid booleans and unauthenticated load', async () => {
  jest.mocked(getDoc).mockResolvedValueOnce({ exists: () => false } as never);
  await expect(loadSettings()).rejects.toThrow();
  jest.mocked(getDoc).mockResolvedValueOnce({ exists: () => true, data: () => ({ checkEnabled: 'true' }) } as never);
  await expect(loadSettings()).rejects.toThrow();
  await expect(updateSettings('owner', { checkEnabled: 'true', xPostEnabled: false } as never)).rejects.toThrow();
  expect(updateDoc).not.toHaveBeenCalled();
  jest.mocked(getCurrentUid).mockReturnValue(null);
  await expect(loadSettings()).rejects.toThrow();
});

it.each(['new-user', null])('P-044 skips App Group sync if UID becomes %s while commit awaits', async (nextUid) => {
  let commit!: () => void;
  jest.mocked(updateDoc).mockImplementationOnce(() => new Promise<void>((resolve) => { commit = resolve; }));
  const pending = updateSettings('owner', { checkEnabled: false, xPostEnabled: true });
  expect(updateDoc).toHaveBeenCalledWith('user-ref', { checkEnabled: false, xPostEnabled: true });
  jest.mocked(getCurrentUid).mockReturnValue(nextUid);
  commit();
  await pending;
  expect(updateDoc).toHaveBeenCalledTimes(1);
  expect(rememberCheckEnabledSetting).not.toHaveBeenCalled();
});
