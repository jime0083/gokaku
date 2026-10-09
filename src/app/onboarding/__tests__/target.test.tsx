import AsyncStorage from '@react-native-async-storage/async-storage';
import { TARGET_HOURS_RANGE } from '@shared/index';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import TargetScreen from '@/app/onboarding/target';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

async function renderScreen() {
  const result = await render(
    <OnboardingDraftProvider>
      <TargetScreen />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('target-hours-input'));
  return result;
}

describe('TargetScreen(オンボーディング 5歩目)', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('未入力は次へが押せない', async () => {
    await renderScreen();
    expect(screen.getByTestId('target-next-button')).toBeDisabled();
  });

  it(`範囲外の目標勉強時間(${TARGET_HOURS_RANGE.max}超)はエラーを表示する`, async () => {
    await renderScreen();
    await fireEvent.changeText(
      screen.getByTestId('target-hours-input'),
      String(TARGET_HOURS_RANGE.max + 1),
    );
    expect(screen.getByTestId('target-hours-error')).toBeOnTheScreen();
    expect(screen.getByTestId('target-next-button')).toBeDisabled();
  });

  it('カレンダーを開くと、表示されている最小の選択可能日(明日)がそのまま確定し、次へ進める', async () => {
    // ネイティブカレンダー(UICalendarView)は表示中の value と同じ日をタップしても onChange が
    // 発火しないため、カレンダーを開く操作自体で表示中の日付(明日)を確定する実装になっている
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('target-hours-input'), '1000');

    // 試験日未選択の段階ではエラーなし(未操作のため)。選択ボタンを押してカレンダーを開く
    expect(screen.queryByTestId('exam-date-error')).toBeNull();
    expect(screen.getByTestId('exam-date-display').props.children).toBe('試験日を選択してください');
    await fireEvent.press(screen.getByTestId('exam-date-select-button'));
    await waitFor(() => screen.getByTestId('exam-date-picker'));

    expect(screen.queryByTestId('exam-date-error')).toBeNull();
    expect(screen.getByTestId('target-next-button')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('target-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/daily-time');
  });

  it('試験日を選ぶと「試験日: ○年○月○日(あと○日)」と大きく表示する', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('exam-date-select-button'));
    const picker = await waitFor(() => screen.getByTestId('exam-date-picker'));
    const selected: Date = picker.props.value;

    const display = screen.getByTestId('exam-date-display').props.children;
    expect(display).toMatch(/^試験日: \d+年\d+月\d+日\(あと\d+日\)$/);
    expect(display).toContain(`${selected.getFullYear()}年${selected.getMonth() + 1}月${selected.getDate()}日`);
    expect(display).toContain('あと1日');
  });

  it('カレンダーで別の日をタップすると、その日に変わる(onChange)', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('target-hours-input'), '1000');
    await fireEvent.press(screen.getByTestId('exam-date-select-button'));
    const picker = await waitFor(() => screen.getByTestId('exam-date-picker'));
    const minimumDate: Date = picker.props.value;
    const laterDate = new Date(
      minimumDate.getFullYear(),
      minimumDate.getMonth(),
      minimumDate.getDate() + 3,
    );
    await fireEvent(picker, 'change', { nativeEvent: {} }, laterDate);

    expect(screen.getByTestId('target-next-button')).not.toBeDisabled();
    expect(screen.getByTestId('exam-date-display').props.children).toContain('あと4日');
  });
});
