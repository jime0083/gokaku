import * as WebBrowser from 'expo-web-browser';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Text } from 'react-native';

import XLinkScreen from '../x-link';

import * as PrimaryButtonModule from '@/components/PrimaryButton';
import type { OpenSession, SessionResult } from '@/features/xLink/authBrowser';
import { xLinkApi, type XLinkPending } from '@/features/xLink/xLinkApi';

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

async function open() {
  await act(async () => {
    route = renderRouter({
      'x-link': XLinkScreen,
      '(tabs)/home': () => <Text testID="x-link-test-home">ホーム</Text>,
    }, { initialUrl: '/x-link' });
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
  Object.values(api).forEach((mock) => mock.mockReset());
  session.mockReset();
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
