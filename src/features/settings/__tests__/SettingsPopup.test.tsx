import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { getCurrentUid } from '@/config/firebase';
import { SettingsPopup } from '../SettingsPopup';
import { loadSettings, updateSettings } from '../settingsRepository';
import { openSettingsLink } from '../settingsLinks';
jest.mock('../settingsRepository', () => ({ loadSettings: jest.fn(), updateSettings: jest.fn() }));
jest.mock('../settingsLinks', () => ({ openSettingsLink: jest.fn() }));
jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
const onCancel = jest.fn();
const onSaved = jest.fn();
const settings = { uid: 'owner', checkEnabled: false, xPostEnabled: true };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCurrentUid).mockReturnValue('owner');
  jest.mocked(loadSettings).mockResolvedValue(settings);
  jest.mocked(updateSettings).mockResolvedValue(undefined);
  jest.mocked(openSettingsLink).mockResolvedValue(undefined);
});
afterEach(async () => { await cleanup(); });
async function open() {
  await render(<SettingsPopup onCancel={onCancel} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByTestId('settings-check-toggle')).toBeTruthy());
}
it('prefills current booleans and cancels without writing', async () => {
  await open();
  expect(screen.getByTestId('settings-check-toggle').props.value).toBe(false);
  expect(screen.getByTestId('settings-x-toggle').props.value).toBe(true);
  await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', true);
  await fireEvent.press(screen.getByTestId('settings-cancel'));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(updateSettings).not.toHaveBeenCalled();
});
it('retains draft on failure and retries same two booleans before closing', async () => {
  await open();
  await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', true);
  await fireEvent(screen.getByTestId('settings-x-toggle'), 'valueChange', false);
  jest.mocked(updateSettings).mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByTestId('settings-save'));
  await waitFor(() => expect(screen.getByTestId('settings-error')).toBeTruthy());
  expect(screen.getByText('通信できませんでした。電波の良い場所で再度お試しください')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByTestId('settings-check-toggle').props.value).toBe(true);
  await fireEvent.press(screen.getByTestId('settings-retry'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(jest.mocked(updateSettings).mock.calls).toEqual([
    ['owner', { checkEnabled: true, xPostEnabled: false }], ['owner', { checkEnabled: true, xPostEnabled: false }],
  ]);
});
it('read failure disables save and retries read rather than saving defaults', async () => {
  jest.mocked(loadSettings).mockRejectedValueOnce(new Error('offline'));
  await render(<SettingsPopup onCancel={onCancel} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByTestId('settings-error')).toBeTruthy());
  expect(screen.getByTestId('settings-save')).toBeDisabled();
  expect(screen.queryByTestId('settings-check-toggle')).toBeNull();
  await fireEvent.press(screen.getByTestId('settings-retry'));
  await waitFor(() => expect(screen.getByTestId('settings-check-toggle').props.value).toBe(false));
  expect(updateSettings).not.toHaveBeenCalled();
});
it.each(['subscription', 'terms', 'privacy'] as const)('retries requested %s link only, preserving unsaved draft', async (action) => {
  await open();
  await fireEvent(screen.getByTestId('settings-check-toggle'), 'valueChange', true);
  jest.mocked(openSettingsLink).mockRejectedValueOnce(new Error('failed'));
  await fireEvent.press(screen.getByTestId(`settings-${action}`));
  await waitFor(() => expect(screen.getByTestId('settings-error')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('settings-retry'));
  await waitFor(() => expect(screen.queryByTestId('settings-error')).toBeNull());
  expect(jest.mocked(openSettingsLink).mock.calls).toEqual([[action], [action]]);
  expect(screen.getByTestId('settings-check-toggle').props.value).toBe(true);
  expect(updateSettings).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});
it('disables unconfigured contact and prevents duplicate saves while pending', async () => {
  await open();
  expect(screen.getByText('お問い合わせ（準備中）')).toBeTruthy();
  expect(screen.getByTestId('settings-contact')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('settings-contact'));
  expect(openSettingsLink).not.toHaveBeenCalled();
  let finish!: () => void;
  jest.mocked(updateSettings).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await fireEvent.press(screen.getByTestId('settings-save'));
  expect(screen.getByTestId('settings-save')).toBeDisabled();
  expect(screen.getByTestId('settings-cancel')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('settings-save'));
  expect(updateSettings).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it.each(['settings-check-toggle', 'settings-x-toggle'])('blocks relink for dirty %s and permits original value', async (id) => {
  const onRelink = jest.fn();
  await render(<SettingsPopup onCancel={onCancel} onSaved={onSaved} onRelink={onRelink} />);
  await waitFor(() => expect(screen.getByTestId('settings-x-relink')).toBeEnabled());
  const original = screen.getByTestId(id).props.value as boolean;
  await fireEvent(screen.getByTestId(id), 'valueChange', !original);
  await fireEvent.press(screen.getByTestId('settings-x-relink'));
  expect(screen.getByTestId('settings-x-relink-dirty')).toHaveTextContent('未保存の設定があります。先に保存またはキャンセルしてください');
  expect(onRelink).not.toHaveBeenCalled();
  expect(updateSettings).not.toHaveBeenCalled();
  expect(screen.getByTestId(id).props.value).toBe(!original);
  await fireEvent(screen.getByTestId(id), 'valueChange', original);
  await fireEvent.press(screen.getByTestId('settings-x-relink'));
  expect(onRelink).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('settings-x-relink'));
  expect(onRelink).toHaveBeenCalledTimes(1);
});

it('does not enter relink for a stale loaded UID', async () => {
  const onRelink = jest.fn();
  await render(<SettingsPopup onCancel={onCancel} onSaved={onSaved} onRelink={onRelink} />);
  await waitFor(() => expect(screen.getByTestId('settings-x-relink')).toBeEnabled());
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await fireEvent.press(screen.getByTestId('settings-x-relink'));
  expect(onRelink).not.toHaveBeenCalled();
  expect(screen.getByTestId('settings-error')).toBeTruthy();
  expect(updateSettings).not.toHaveBeenCalled();
});
