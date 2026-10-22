import { cleanup, render, screen, waitFor } from '@testing-library/react-native';

import HomeScreen from '@/app/index';

jest.mock('@/features/xLink/relinkIntentStorage', () => ({
  loadRelinkIntent: jest.fn(async () => false),
  saveRelinkIntent: jest.fn(async () => {}),
  clearRelinkIntent: jest.fn(async () => {}),
}));

jest.mock('@/features/billing/SubscriptionBoundary', () => {
  const reportLaunchInspection = jest.fn();
  return {
    useSubscriptionAccess: () => ({
      reportLaunchInspection,
    }),
  };
});

jest.mock('@/features/account/AccountActionBoundary', () => {
  const actions = {
    ready: true,
    isReady: () => true,
    request: jest.fn(),
  };
  return { useAccountActions: () => actions };
});

describe('HomeScreen', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('アプリ名「合格ウォッチ」を表示する', async () => {
    await render(<HomeScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-start-button')).toBeEnabled(),
    );

    expect(screen.getByText('合格ウォッチ')).toBeOnTheScreen();
  });
});
