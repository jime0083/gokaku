import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { FREE_TEXT_MAX_LENGTH } from '@/features/onboarding/validation';
import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import UniversityScreen from '@/app/onboarding/university';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

async function renderScreen() {
  const result = await render(
    <OnboardingDraftProvider>
      <UniversityScreen />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('university-input'));
  return result;
}

describe('UniversityScreen(オンボーディング 2歩目)', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('未入力は次へが押せず、エラー文言は出さない', async () => {
    await renderScreen();
    expect(screen.getByTestId('university-next-button')).toBeDisabled();
    expect(screen.queryByTestId('university-error')).toBeNull();
  });

  it(`${FREE_TEXT_MAX_LENGTH}文字を超える入力はエラーを表示し、次へが押せない`, async () => {
    await renderScreen();
    await fireEvent.changeText(
      screen.getByTestId('university-input'),
      'あ'.repeat(FREE_TEXT_MAX_LENGTH + 1),
    );
    expect(screen.getByTestId('university-error')).toBeOnTheScreen();
    expect(screen.getByTestId('university-next-button')).toBeDisabled();
  });

  it('有効な入力で次へが押せて、偏差値入力画面へ進む', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('university-input'), '〇〇大学');
    expect(screen.queryByTestId('university-error')).toBeNull();
    expect(screen.getByTestId('university-next-button')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('university-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/deviation');
  });
});
