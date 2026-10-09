import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import RouteSelectScreen from '@/app/onboarding/index';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: mockReplace }),
}));

async function renderScreen() {
  return render(
    <OnboardingDraftProvider>
      <RouteSelectScreen />
    </OnboardingDraftProvider>,
  );
}

describe('RouteSelectScreen(オンボーディング 1歩目)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('資格を選ぶと資格の選択画面へ進む(3-2a: 3-1 の暫定を解除)', async () => {
    await renderScreen();
    await waitFor(() => screen.getByTestId('route-select-cert-button'));
    await fireEvent.press(screen.getByTestId('route-select-cert-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/cert-select');
  });

  it('受験を選ぶと大学入力画面へ進む', async () => {
    await renderScreen();
    await waitFor(() => screen.getByTestId('route-select-exam-button'));
    await fireEvent.press(screen.getByTestId('route-select-exam-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/university');
  });

  it('戻るボタンで初回起動画面に戻る(problem P-015: ナビゲーション履歴ではなくステップの並び順から行き先を決める)', async () => {
    await renderScreen();
    await waitFor(() => screen.getByTestId('route-select-back-button'));
    await fireEvent.press(screen.getByTestId('route-select-back-button'));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
