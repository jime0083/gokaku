import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

jest.mock('@/features/billing/subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(async (uid: string) => ({
    uid, registered: true, xLinked: true, access: 'allowed' as const,
  })),
  subscribeSubscriptionAuth: jest.fn(() => jest.fn()),
}));

jest.mock('@/features/account/accountActionService', () => ({
  accountActionService: {
    inspectPending: jest.fn(async () => ({
      checkpoint: null, nativeBlock: null, retryOnly: false,
    })),
    perform: jest.fn(),
    resume: jest.fn(),
  },
}), { virtual: true });

/**
 * 概算の決め手(受験: 偏差値・科目数、資格: 選んだ資格)を戻って変えた場合の目標勉強時間の
 * 自動入れ直し(requirements 4-2 の 5, 2026-10-09 決定)を、実際のナビゲーション(renderRouter)で確認する。
 * renderRouter の呼び出しは act で包む必要がある(backNavigation.test.tsx と同じ理由)
 */
async function renderOnboardingRouter(initialUrl: string): Promise<void> {
  await act(async () => {
    renderRouter('src/app', { initialUrl });
  });
}

describe('目標勉強時間の自動入れ直し(受験ルート。renderRouter)', () => {
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
  });

  it('戻って偏差値を変えると、書き換えていなければ新しい概算の上限に置き換わる', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-exam-button'));
    await fireEvent.press(screen.getByTestId('route-select-exam-button'));

    await waitFor(() => screen.getByTestId('university-input'));
    await fireEvent.changeText(screen.getByTestId('university-input'), '合格大学');
    await fireEvent.press(screen.getByTestId('university-next-button'));

    await waitFor(() => screen.getByTestId('target-deviation-input'));
    await fireEvent.changeText(screen.getByTestId('target-deviation-input'), '60.0');
    await fireEvent.changeText(screen.getByTestId('current-deviation-input'), '50.0');
    await fireEvent.press(screen.getByTestId('deviation-next-button'));

    await waitFor(() => screen.getByTestId('estimate-range-text'));
    await fireEvent.press(screen.getByTestId('estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('1800');

    // 戻って偏差値を変える(60.0 → 70.0)
    await fireEvent.press(screen.getByTestId('target-back-button'));
    await waitFor(() => screen.getByTestId('estimate-range-text'));
    await fireEvent.press(screen.getByTestId('estimate-back-button'));

    await waitFor(() => screen.getByTestId('target-deviation-input'));
    await fireEvent.changeText(screen.getByTestId('target-deviation-input'), '70.0');
    await fireEvent.press(screen.getByTestId('deviation-next-button'));

    await waitFor(() => screen.getByTestId('estimate-range-text'));
    expect(screen.getByTestId('estimate-range-text').props.children.join('')).toBe('約2,430〜4,050時間');
    await fireEvent.press(screen.getByTestId('estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('4050');
  });

  it('目標勉強時間を自分で書き換えてから戻って偏差値を変えても、書き換えた値が残る', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-exam-button'));
    await fireEvent.press(screen.getByTestId('route-select-exam-button'));

    await waitFor(() => screen.getByTestId('university-input'));
    await fireEvent.changeText(screen.getByTestId('university-input'), '合格大学');
    await fireEvent.press(screen.getByTestId('university-next-button'));

    await waitFor(() => screen.getByTestId('target-deviation-input'));
    await fireEvent.changeText(screen.getByTestId('target-deviation-input'), '60.0');
    await fireEvent.changeText(screen.getByTestId('current-deviation-input'), '50.0');
    await fireEvent.press(screen.getByTestId('deviation-next-button'));

    await waitFor(() => screen.getByTestId('estimate-range-text'));
    await fireEvent.press(screen.getByTestId('estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('1800');

    // 自分で書き換える
    await fireEvent.changeText(screen.getByTestId('target-hours-input'), '1234');
    await waitFor(() => expect(screen.getByTestId('target-hours-input').props.value).toBe('1234'));

    // 戻って偏差値を変える(60.0 → 70.0)
    await fireEvent.press(screen.getByTestId('target-back-button'));
    await waitFor(() => screen.getByTestId('estimate-range-text'));
    await fireEvent.press(screen.getByTestId('estimate-back-button'));

    await waitFor(() => screen.getByTestId('target-deviation-input'));
    await fireEvent.changeText(screen.getByTestId('target-deviation-input'), '70.0');
    await fireEvent.press(screen.getByTestId('deviation-next-button'));

    await waitFor(() => screen.getByTestId('estimate-range-text'));
    await fireEvent.press(screen.getByTestId('estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('1234');
  });
});

describe('目標勉強時間の自動入れ直し(資格ルート。renderRouter)', () => {
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
  });

  it('戻って資格を選び直すと、新しい概算の上限に置き換わる', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-cert-button'));
    await fireEvent.press(screen.getByTestId('route-select-cert-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-it-passport'));

    await waitFor(() => screen.getByTestId('cert-estimate-amount-text'));
    await fireEvent.press(screen.getByTestId('cert-estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('100');

    // 戻って別の資格を選び直す
    await fireEvent.press(screen.getByTestId('target-back-button'));
    await waitFor(() => screen.getByTestId('cert-estimate-amount-text'));
    await fireEvent.press(screen.getByTestId('cert-estimate-back-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-bookkeeping-2'));

    await waitFor(() => screen.getByTestId('cert-estimate-amount-text'));
    expect(screen.getByTestId('cert-estimate-amount-text')).toHaveTextContent('約350〜500時間');
    await fireEvent.press(screen.getByTestId('cert-estimate-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('500');
  });

  it('資格から「その他」に変えると、自動で入っていた目標勉強時間は空欄に戻る', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-cert-button'));
    await fireEvent.press(screen.getByTestId('route-select-cert-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-it-passport'));

    await waitFor(() => screen.getByTestId('cert-estimate-amount-text'));
    await fireEvent.press(screen.getByTestId('cert-estimate-back-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-other'));

    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    await fireEvent.changeText(screen.getByTestId('cert-other-name-input'), '〇〇検定');
    await fireEvent.press(screen.getByTestId('cert-select-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    expect(screen.getByTestId('target-hours-input').props.value).toBe('');
  });
});
