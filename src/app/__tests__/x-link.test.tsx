import { router } from 'expo-router';
import { clearRelinkIntent, saveRelinkIntent } from '@/features/xLink/relinkIntentStorage';
import * as WebBrowser from 'expo-web-browser';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Text } from 'react-native';

import XLinkScreen from '../x-link';

import { getCurrentUid } from '@/config/firebase';
import * as PrimaryButtonModule from '@/components/PrimaryButton';
import type { OpenSession, SessionResult } from '@/features/xLink/authBrowser';
import { xLinkApi, type XLinkPending } from '@/features/xLink/xLinkApi';

jest.mock('@/features/xLink/relinkIntentStorage', () => ({
  loadRelinkIntent: jest.fn(async () => false),
  saveRelinkIntent: jest.fn(async () => {}),
  clearRelinkIntent: jest.fn(async () => {}),
}));

jest.mock('@/config/firebase', () => ({ getCurrentUid: jest.fn() }));
jest.mock('@/features/xLink/xLinkApi', () => ({
  xLinkApi: {
    begin: jest.fn(),
    complete: jest.fn(),
    getPending: jest.fn(),
    confirm: jest.fn(),
    discard: jest.fn(),
  },
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'MockIonicons' }));

const api = jest.mocked(xLinkApi);
const session = WebBrowser.openAuthSessionAsync as jest.MockedFunction<OpenSession>;
const REDIRECT = 'gokaku://x-auth/callback';
const AUTHORIZATION = 'https://x.com/i/oauth2/authorize?' +
  new URLSearchParams({ state: 'mock-state', redirect_uri: REDIRECT }).toString();
const CALLBACK = REDIRECT + '?state=mock-state&code=mock-code';
const ERROR = '通信できませんでした。電波の良い場所で再度お試しください';
const PERMISSION = '最低勉強時間に届かなかった日に、翌0:00にXへ自動投稿します。許可しますか？';
const CANDIDATE: XLinkPending = {
  candidateId: 'mock-candidate',
  profile: {
    id: 'mock-user',
    username: 'study_account',
    profileImageUrl: 'https://example.invalid/avatar.png',
  },
  expiresAt: 2000000000000,
};

let route: ReturnType<typeof renderRouter> | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function open(initialUrl = '/x-link') {
  await act(async () => {
    route = renderRouter({
      'x-link': XLinkScreen,
      '(tabs)/home': () => <Text testID="x-link-test-home">ホーム</Text>,
    }, { initialUrl });
  });
}

async function press(id: string) {
  await fireEvent.press(screen.getByTestId(id));
}

async function error() {
  await waitFor(() => expect(screen.getByText(ERROR)).toBeTruthy());
}

async function initial() {
  await waitFor(() => expect(screen.getByTestId('x-link-start')).toBeEnabled());
}

async function account() {
  await waitFor(() => expect(screen.getByTestId('x-link-use-account')).toBeEnabled());
  expect(screen.getByText('@study_account')).toBeTruthy();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCurrentUid).mockReturnValue('link-owner');
  Object.values(api).forEach((mock) => mock.mockReset());
  session.mockReset();
  jest.mocked(saveRelinkIntent).mockReset().mockResolvedValue(undefined);
  jest.mocked(clearRelinkIntent).mockReset().mockResolvedValue(undefined);
  route = undefined;
  api.getPending.mockResolvedValue({ pending: null });
  api.begin.mockResolvedValue({ authorizationUrl: AUTHORIZATION });
  api.complete.mockResolvedValue({ candidateId: CANDIDATE.candidateId });
  api.confirm.mockResolvedValue({ ok: true });
  api.discard.mockResolvedValue({ ok: true });
  session.mockResolvedValue({ type: 'success', url: CALLBACK });
});

afterEach(async () => {
  await cleanup();
});

it('初回GET失敗を固定文言で再試行し、認可取消後は戻る/スキップのない初期画面に戻る', async () => {
  api.getPending.mockRejectedValueOnce(new Error('private-sdk-detail'));
  session.mockResolvedValueOnce({ type: 'cancel' });
  await open();
  await error();
  expect(screen.queryByText('private-sdk-detail')).toBeNull();
  expect(api.begin).not.toHaveBeenCalled();
  await press('x-link-retry');
  await initial();
  expect(screen.queryByText('戻る')).toBeNull();
  expect(screen.queryByText('スキップ')).toBeNull();
  await press('x-link-start');
  await initial();
  expect(screen.queryByTestId('x-link-error')).toBeNull();
  expect(api.complete).not.toHaveBeenCalled();
  expect(session).toHaveBeenCalledWith(AUTHORIZATION, REDIRECT, {
    preferEphemeralSession: false,
  });
});

it('確認待ちを画像/@名で再開し、画像nullは人型を表示する', async () => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  await open();
  await account();
  expect(screen.getByTestId('x-link-avatar').props.source).toEqual({
    uri: CANDIDATE.profile.profileImageUrl,
  });
  expect(api.begin).not.toHaveBeenCalled();
  await cleanup();
  api.getPending.mockResolvedValue({
    pending: { ...CANDIDATE, profile: { ...CANDIDATE.profile, profileImageUrl: null } },
  });
  await open();
  await account();
  expect(screen.getByTestId('x-link-avatar-fallback').props.name).toBe('person-outline');
  expect(screen.queryByTestId('x-link-avatar')).toBeNull();
});

it('begin失敗とbrowser失敗は新しいbeginから再試行する', async () => {
  api.begin.mockRejectedValueOnce(new Error('private-url'));
  session.mockRejectedValueOnce(new Error('private-native-error'));
  session.mockResolvedValueOnce({ type: 'cancel' });
  await open();
  await initial();
  await press('x-link-start');
  await error();
  expect(session).not.toHaveBeenCalled();
  await press('x-link-retry');
  await error();
  expect(api.begin).toHaveBeenCalledTimes(2);
  await press('x-link-retry');
  await initial();
  expect(api.begin).toHaveBeenCalledTimes(3);
  expect(session).toHaveBeenCalledTimes(2);
  expect(api.complete).not.toHaveBeenCalled();
});

it('認可成功後のプロフィールGET失敗はGETだけ再試行する', async () => {
  api.getPending.mockResolvedValueOnce({ pending: null })
    .mockRejectedValueOnce(new Error('profile-unavailable'))
    .mockResolvedValueOnce({ pending: CANDIDATE });
  await open();
  await initial();
  await press('x-link-start');
  await error();
  expect(api.complete).toHaveBeenCalledWith('mock-state', 'mock-code');
  await press('x-link-retry');
  await account();
  expect(api.getPending).toHaveBeenCalledTimes(3);
  expect(api.begin).toHaveBeenCalledTimes(1);
  expect(session).toHaveBeenCalledTimes(1);
  expect(api.complete).toHaveBeenCalledTimes(1);
});

it('completeの応答喪失でもcodeを再送せずGETで確認待ちを回復する', async () => {
  api.complete.mockRejectedValueOnce(new Error('response-lost'));
  api.getPending.mockResolvedValueOnce({ pending: null })
    .mockResolvedValueOnce({ pending: CANDIDATE });
  await open();
  await initial();
  await press('x-link-start');
  await error();
  await press('x-link-retry');
  await account();
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(api.begin).toHaveBeenCalledTimes(1);
  expect(api.getPending).toHaveBeenCalledTimes(2);
});

it('別アカウントはdiscard→beginを段階別に再試行し、ephemeral認可取消で初期へ戻る', async () => {
  api.getPending.mockResolvedValueOnce({ pending: CANDIDATE });
  api.discard.mockRejectedValueOnce(new Error('discard-failed'))
    .mockResolvedValueOnce({ ok: true });
  api.begin.mockRejectedValueOnce(new Error('begin-failed'))
    .mockResolvedValueOnce({ authorizationUrl: AUTHORIZATION });
  session.mockResolvedValueOnce({ type: 'cancel' });
  await open();
  await account();
  await press('x-link-different-account');
  await error();
  expect(api.discard).toHaveBeenCalledWith(CANDIDATE.candidateId);
  expect(api.begin).not.toHaveBeenCalled();
  await press('x-link-retry');
  await error();
  expect(api.discard).toHaveBeenCalledTimes(2);
  expect(api.begin).toHaveBeenCalledTimes(1);
  await press('x-link-retry');
  await initial();
  expect(api.discard).toHaveBeenCalledTimes(2);
  expect(api.begin).toHaveBeenCalledTimes(2);
  expect(session).toHaveBeenCalledWith(AUTHORIZATION, REDIRECT, {
    preferEphemeralSession: true,
  });
  expect(api.complete).not.toHaveBeenCalled();
});

it.each([
  ['x-link-allow', true],
  ['x-link-deny', false],
] as const)('%sは同じ候補の選択値を確定しホームへ実際に遷移する', async (id, enabled) => {
  api.getPending.mockResolvedValueOnce({ pending: CANDIDATE });
  await open();
  await account();
  await press('x-link-use-account');
  expect(screen.getByText(PERMISSION)).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
  await press(id);
  await waitFor(() => expect(screen.getByTestId('x-link-test-home')).toBeTruthy());
  expect(route?.getPathname()).toBe('/home');
  expect(api.confirm).toHaveBeenCalledTimes(1);
  expect(api.confirm).toHaveBeenCalledWith(CANDIDATE.candidateId, enabled);
});

it('confirm応答喪失は選択変更を止め同一候補/falseだけを再送する', async () => {
  api.getPending.mockResolvedValueOnce({ pending: CANDIDATE });
  api.confirm.mockRejectedValueOnce(new Error('response-lost'))
    .mockResolvedValueOnce({ ok: true });
  await open();
  await account();
  await press('x-link-use-account');
  await press('x-link-deny');
  await error();
  expect(screen.getByText(PERMISSION)).toBeTruthy();
  expect(screen.getByTestId('x-link-allow')).toBeDisabled();
  expect(screen.getByTestId('x-link-deny')).toBeDisabled();
  expect(screen.queryByTestId('x-link-test-home')).toBeNull();
  await press('x-link-allow');
  expect(api.confirm).toHaveBeenCalledTimes(1);
  await press('x-link-retry');
  await waitFor(() => expect(screen.getByTestId('x-link-test-home')).toBeTruthy());
  expect(api.confirm.mock.calls).toEqual([
    [CANDIDATE.candidateId, false],
    [CANDIDATE.candidateId, false],
  ]);
  expect(api.getPending).toHaveBeenCalledTimes(1);
  expect(api.discard).not.toHaveBeenCalled();
});

it('同期連打をrefで止め、アンマウント後のbrowser成功はcompleteしない', async () => {
  const pendingSession = deferred<SessionResult>();
  session.mockReturnValueOnce(pendingSession.promise);
  // RNTL 14 removed composite queries and exposes no public handler getter.
  // Capture the public prop while rendering the actual PrimaryButton unchanged.
  let startOnPress: (() => void) | undefined;
  const ActualPrimaryButton = PrimaryButtonModule.PrimaryButton;
  const buttonSpy = jest.spyOn(PrimaryButtonModule, 'PrimaryButton')
    .mockImplementation((props) => {
      if (props.testID === 'x-link-start') startOnPress = props.onPress;
      return <ActualPrimaryButton {...props} />;
    });
  try {
    await open();
    await initial();
    const onPress = startOnPress;
    expect(onPress).toEqual(expect.any(Function));
    if (!onPress) throw new Error('Start button handler was not captured');
    await act(async () => {
      onPress();
      onPress();
    });
    await waitFor(() => expect(session).toHaveBeenCalledTimes(1));
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('x-link-start')).toBeDisabled();
    await cleanup();
    await act(async () => {
      pendingSession.resolve({ type: 'success', url: CALLBACK });
      await pendingSession.promise;
    });
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.getPending).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
  } finally {
    buttonSpy.mockRestore();
  }
});

it('relink fresh auth requests ephemeral; cancel leaves old link untouched and back reaches home', async () => {
  session.mockResolvedValueOnce({ type: 'cancel' });
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-start');
  await initial();
  expect(session).toHaveBeenCalledWith(AUTHORIZATION, REDIRECT, { preferEphemeralSession: true });
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.discard).not.toHaveBeenCalled();
  await press('x-link-home');
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(screen.getByTestId('x-link-test-home')).toBeTruthy();
});

it('relink failure permits home return without switching or discarding old credentials', async () => {
  api.begin.mockRejectedValueOnce(new Error('offline'));
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-start');
  await error();
  await press('x-link-home');
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.discard).not.toHaveBeenCalled();
});

it.each([['x-link-allow', true], ['x-link-deny', false]] as const)(
  'relink %s only commits after permission selection and navigates home', async (id, enabled) => {
    api.getPending.mockResolvedValue({ pending: CANDIDATE });
    const confirmation = deferred<{ ok: true }>();
    api.confirm.mockReturnValueOnce(confirmation.promise);
    await open('/x-link?mode=relink');
    await account();
    await press('x-link-use-account');
    expect(api.confirm).not.toHaveBeenCalled();
    await press(id);
    await press(id);
    expect(screen.getByTestId('x-link-home')).toBeDisabled();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.confirm).toHaveBeenCalledWith(CANDIDATE.candidateId, enabled);
    expect(route?.getPathname()).toBe('/x-link');
    await act(async () => { confirmation.resolve({ ok: true }); });
    await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  },
);

it('reopening relink resumes server pending, including after leaving the permission dialog', async () => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  await open('/x-link?mode=relink');
  await account();
  await press('x-link-use-account');
  await press('x-link-home');
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.discard).not.toHaveBeenCalled();
  await cleanup();
  await open('/x-link?mode=relink');
  await account();
  expect(api.begin).not.toHaveBeenCalled();
  expect(api.getPending).toHaveBeenCalledTimes(2);
});

it('returning home during begin suppresses its late browser opening', async () => {
  const beginning = deferred<{ authorizationUrl: string }>();
  api.begin.mockReturnValueOnce(beginning.promise);
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-start');
  await press('x-link-home');
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  await act(async () => { beginning.resolve({ authorizationUrl: AUTHORIZATION }); });
  expect(session).not.toHaveBeenCalled();
  expect(api.complete).not.toHaveBeenCalled();
});

it('UID change while browser is open suppresses complete and subsequent actions', async () => {
  const browser = deferred<SessionResult>();
  session.mockReturnValueOnce(browser.promise);
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-start');
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await act(async () => { browser.resolve({ type: 'success', url: CALLBACK }); });
  expect(api.complete).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});

it('UID change after candidate display prevents confirm and discard under new UID', async () => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  await open('/x-link?mode=relink');
  await account();
  await press('x-link-use-account');
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await press('x-link-allow');
  await error();
  expect(api.confirm).not.toHaveBeenCalled();
  await press('x-link-retry');
  expect(api.getPending).toHaveBeenCalledTimes(1);
  expect(api.discard).not.toHaveBeenCalled();
  expect(route?.getPathname()).toBe('/x-link');
});

it('UID change while pending loads never displays the previous account', async () => {
  const loading = deferred<{ pending: XLinkPending | null }>();
  api.getPending.mockReturnValueOnce(loading.promise);
  await open('/x-link?mode=relink');
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await act(async () => { loading.resolve({ pending: CANDIDATE }); });
  expect(screen.queryByText('@study_account')).toBeNull();
  expect(api.confirm).not.toHaveBeenCalled();
});

it('UID change while confirm runs suppresses its late home navigation', async () => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  const confirmation = deferred<{ ok: true }>();
  api.confirm.mockReturnValueOnce(confirmation.promise);
  await open('/x-link?mode=relink');
  await account();
  await press('x-link-use-account');
  await press('x-link-deny');
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await act(async () => { confirmation.resolve({ ok: true }); });
  expect(route?.getPathname()).toBe('/x-link');
});

it.each([CANDIDATE, null])('B2 relink waits for durable own intent before pending (%s)', async (candidate) => {
  const saving = deferred<void>();
  jest.mocked(saveRelinkIntent).mockReturnValueOnce(saving.promise);
  api.getPending.mockResolvedValue({ pending: candidate });
  await open('/x-link?mode=relink');
  await waitFor(() => expect(saveRelinkIntent).toHaveBeenCalledWith('link-owner'));
  expect(api.getPending).not.toHaveBeenCalled();
  expect(api.begin).not.toHaveBeenCalled();
  expect(screen.queryByTestId('x-link-start')).toBeNull();
  await act(async () => { saving.resolve(); });
  if (candidate) await account(); else await initial();
  expect(api.getPending).toHaveBeenCalledTimes(1);
});

it('B2 save failure blocks authorization and retries saving before pending', async () => {
  jest.mocked(saveRelinkIntent).mockRejectedValueOnce(new Error('storage'));
  await open('/x-link?mode=relink');
  await error();
  expect(api.getPending).not.toHaveBeenCalled();
  expect(api.begin).not.toHaveBeenCalled();
  await press('x-link-retry');
  await initial();
  expect(saveRelinkIntent).toHaveBeenNthCalledWith(2, 'link-owner');
  expect(api.getPending).toHaveBeenCalledTimes(1);
});

it('B2 home clear failure retries and cannot exit before clear completes', async () => {
  const clearing = deferred<void>();
  jest.mocked(clearRelinkIntent).mockRejectedValueOnce(new Error('storage'))
    .mockReturnValueOnce(clearing.promise);
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-home');
  await error();
  expect(route?.getPathname()).toBe('/x-link');
  await press('x-link-retry');
  await press('x-link-home');
  expect(clearRelinkIntent).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('x-link-home')).toBeDisabled();
  expect(route?.getPathname()).toBe('/x-link');
  await act(async () => { clearing.resolve(); });
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(clearRelinkIntent).toHaveBeenNthCalledWith(2, 'link-owner');
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.discard).not.toHaveBeenCalled();
});

it.each(['response', 'clear'] as const)('B2 confirm %s failure reuses the same receipt and awaits clear', async (failure) => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  const clearing = deferred<void>();
  if (failure === 'response') api.confirm.mockRejectedValueOnce(new Error('lost'));
  else jest.mocked(clearRelinkIntent).mockRejectedValueOnce(new Error('storage'));
  await open('/x-link?mode=relink');
  await account();
  await press('x-link-use-account');
  await press('x-link-deny');
  await error();
  expect(route?.getPathname()).toBe('/x-link');
  expect(screen.getByTestId('x-link-allow')).toBeDisabled();
  jest.mocked(clearRelinkIntent).mockReturnValueOnce(clearing.promise);
  await press('x-link-retry');
  await press('x-link-deny');
  expect(api.confirm.mock.calls).toEqual([
    [CANDIDATE.candidateId, false], [CANDIDATE.candidateId, false],
  ]);
  expect(route?.getPathname()).toBe('/x-link');
  expect(screen.getByTestId('x-link-home')).toBeDisabled();
  await act(async () => { clearing.resolve(); });
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(clearRelinkIntent).toHaveBeenLastCalledWith('link-owner');
  expect(api.getPending).toHaveBeenCalledTimes(1);
  expect(api.discard).not.toHaveBeenCalled();
});

it('B2 stale UID save cannot read pending or clear another owner', async () => {
  const saving = deferred<void>();
  jest.mocked(saveRelinkIntent).mockReturnValueOnce(saving.promise);
  await open('/x-link?mode=relink');
  await waitFor(() => expect(saveRelinkIntent).toHaveBeenCalledTimes(1));
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await act(async () => { saving.resolve(); });
  await press('x-link-home');
  expect(api.getPending).not.toHaveBeenCalled();
  expect(clearRelinkIntent).not.toHaveBeenCalled();
  expect(route?.getPathname()).toBe('/x-link');
});

it('B2 earlier focus save cannot resume the next focus', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  jest.mocked(saveRelinkIntent).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await open('/x-link?mode=relink');
  await waitFor(() => expect(saveRelinkIntent).toHaveBeenCalledTimes(1));
  await act(async () => { router.push('/(tabs)/home'); });
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  await act(async () => { router.back(); });
  await waitFor(() => expect(saveRelinkIntent).toHaveBeenCalledTimes(2));
  await act(async () => { first.resolve(); });
  expect(api.getPending).not.toHaveBeenCalled();
  await act(async () => { second.resolve(); });
  await initial();
  expect(api.getPending).toHaveBeenCalledTimes(1);
});

it('B2 UID change while clear runs prevents late home navigation', async () => {
  const clearing = deferred<void>();
  jest.mocked(clearRelinkIntent).mockReturnValueOnce(clearing.promise);
  await open('/x-link?mode=relink');
  await initial();
  await press('x-link-home');
  jest.mocked(getCurrentUid).mockReturnValue('other-owner');
  await act(async () => { clearing.resolve(); });
  expect(route?.getPathname()).toBe('/x-link');
  expect(jest.mocked(clearRelinkIntent).mock.calls).toEqual([['link-owner']]);
});

it('B2 onboarding never saves or clears relink intent', async () => {
  api.getPending.mockResolvedValue({ pending: CANDIDATE });
  await open();
  await account();
  await press('x-link-use-account');
  await press('x-link-allow');
  await waitFor(() => expect(route?.getPathname()).toBe('/home'));
  expect(saveRelinkIntent).not.toHaveBeenCalled();
  expect(clearRelinkIntent).not.toHaveBeenCalled();
});
