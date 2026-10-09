import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEVIATION_RANGE, SUBJECT_COUNT_RANGE } from '@shared/index';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import DeviationScreen from '@/app/onboarding/deviation';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

async function renderScreen() {
  const result = await render(
    <OnboardingDraftProvider>
      <DeviationScreen />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('target-deviation-input'));
  return result;
}

describe('DeviationScreen(オンボーディング 3歩目)', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('受験科目数の初期値は3で、+-ボタンで範囲内に収まる', async () => {
    await renderScreen();
    expect(screen.getByTestId('subject-count-value').props.children).toBe(SUBJECT_COUNT_RANGE.default);

    for (let i = 0; i < SUBJECT_COUNT_RANGE.max + 2; i += 1) {
      await fireEvent.press(screen.getByTestId('subject-count-increment-button'));
    }
    expect(screen.getByTestId('subject-count-value').props.children).toBe(SUBJECT_COUNT_RANGE.max);

    for (let i = 0; i < SUBJECT_COUNT_RANGE.max + 2; i += 1) {
      await fireEvent.press(screen.getByTestId('subject-count-decrement-button'));
    }
    expect(screen.getByTestId('subject-count-value').props.children).toBe(SUBJECT_COUNT_RANGE.min);
  });

  it('範囲外の偏差値はエラーを表示し、次へが押せない(不正な入力)', async () => {
    await renderScreen();
    await fireEvent.changeText(
      screen.getByTestId('target-deviation-input'),
      String(DEVIATION_RANGE.max + 1),
    );
    expect(screen.getByTestId('target-deviation-error')).toBeOnTheScreen();
    expect(screen.getByTestId('deviation-next-button')).toBeDisabled();
  });

  it('有効な入力で次へが押せて、概算画面へ進む', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('target-deviation-input'), '60.0');
    await fireEvent.changeText(screen.getByTestId('current-deviation-input'), '50.0');
    expect(screen.getByTestId('deviation-next-button')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('deviation-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/estimate');
  });
});
