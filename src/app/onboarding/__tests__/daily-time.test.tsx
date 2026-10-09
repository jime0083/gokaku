import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import DailyTimeScreen from '@/app/onboarding/daily-time';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

async function renderScreen() {
  const result = await render(
    <OnboardingDraftProvider>
      <DailyTimeScreen />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('min-daily-time-row'));
  return result;
}

describe('DailyTimeScreen(オンボーディング 6歩目。P-014 対応: タップで下からドラムロール)', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('初期表示は「未設定」で、次へが押せず、エラー文言も出さない', async () => {
    await renderScreen();
    expect(screen.getByTestId('min-daily-time-value').props.children).toBe('未設定');
    expect(screen.getByTestId('goal-daily-time-value').props.children).toBe('未設定');
    expect(screen.getByTestId('daily-time-next-button')).toBeDisabled();
    expect(screen.queryByTestId('min-daily-minutes-error')).toBeNull();
    expect(screen.queryByTestId('goal-daily-minutes-error')).toBeNull();
    // ドラムロールは行をタップするまで表示されない
    expect(screen.queryByTestId('min-hour-picker')).toBeNull();
  });

  it('行をタップするとドラムロールと完了ボタンが表示される', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    expect(screen.getByTestId('min-hour-picker')).toBeOnTheScreen();
    expect(screen.getByTestId('min-minute-picker')).toBeOnTheScreen();
    expect(screen.getByTestId('daily-time-sheet-done-button')).toBeOnTheScreen();
  });

  it('値を動かさずに完了を押しても、表示されている値(0時間10分)で確定する', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));

    expect(screen.getByTestId('min-daily-time-value').props.children).toBe('0時間10分');
    // 完了後はドラムロールが閉じる
    expect(screen.queryByTestId('min-hour-picker')).toBeNull();
  });

  it('ドラムロールを操作してから完了を押すと、その値で確定する', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('goal-daily-time-row'));
    await fireEvent(screen.getByTestId('goal-hour-picker'), 'valueChange', 2);
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));

    expect(screen.getByTestId('goal-daily-time-value').props.children).toBe('2時間10分');
  });

  it('努力目標 < 最低 の場合はエラーを表示し、次へが押せない(不正な入力)', async () => {
    await renderScreen();
    // 最低を 2時間10分 に確定
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    await fireEvent(screen.getByTestId('min-hour-picker'), 'valueChange', 2);
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));

    // 努力目標を 0時間10分(最低より少ない)のまま確定
    await fireEvent.press(screen.getByTestId('goal-daily-time-row'));
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));

    expect(screen.getByTestId('goal-vs-min-error')).toBeOnTheScreen();
    expect(screen.getByTestId('daily-time-next-button')).toBeDisabled();
  });

  it('努力目標 ≥ 最低 なら次へが押せる', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));
    await fireEvent.press(screen.getByTestId('goal-daily-time-row'));
    await fireEvent(screen.getByTestId('goal-hour-picker'), 'valueChange', 1);
    await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));

    expect(screen.queryByTestId('goal-vs-min-error')).toBeNull();
    expect(screen.getByTestId('daily-time-next-button')).not.toBeDisabled();
  });

  it('16時間に合わせると分の選択は0分のみに制限される(16時間10分以上を防ぐ)', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    await fireEvent(screen.getByTestId('min-hour-picker'), 'valueChange', 16);
    expect(screen.getByTestId('min-minute-picker').props.selectedValue).toBe(0);
  });

  it('0時間に戻すと、分の既定値(10分)に戻る(0時間0分を選べないようにする)', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('min-daily-time-row'));
    await fireEvent(screen.getByTestId('min-hour-picker'), 'valueChange', 16);
    await fireEvent(screen.getByTestId('min-hour-picker'), 'valueChange', 0);
    expect(screen.getByTestId('min-minute-picker').props.selectedValue).toBe(10);
  });
});
