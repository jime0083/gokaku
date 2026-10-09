import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { OnboardingDraftProvider, useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import EstimateScreen from '@/app/onboarding/estimate';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

/** テスト用: マウント時に偏差値をセットしてから概算画面を描画する */
function Setup({
  targetDeviationText,
  currentDeviationText,
}: {
  targetDeviationText: string;
  currentDeviationText: string;
}) {
  const { draft, updateDraft } = useOnboardingDraft();
  const prepared = draft.targetDeviationText === targetDeviationText;

  useEffect(() => {
    if (!prepared) {
      updateDraft({ targetDeviationText, currentDeviationText, subjectCount: 3 });
    }
  }, [prepared, targetDeviationText, currentDeviationText, updateDraft]);

  return prepared ? <EstimateScreen /> : null;
}

async function renderScreen(targetDeviationText: string, currentDeviationText: string) {
  const result = await render(
    <OnboardingDraftProvider>
      <Setup targetDeviationText={targetDeviationText} currentDeviationText={currentDeviationText} />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('estimate-next-button'));
  return result;
}

describe('EstimateScreen(オンボーディング 4歩目)', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('目標 > 現在 の場合は「約○〜○時間」を表示する(mokuhyo.txt の例: 3科目 50.0→60.0)', async () => {
    await renderScreen('60.0', '50.0');
    expect(screen.getByTestId('estimate-range-text').props.children.join('')).toBe('約1,080〜1,800時間');
    expect(screen.queryByTestId('estimate-not-needed-text')).toBeNull();
  });

  it('目標 ≤ 現在 の場合は「現在の偏差値で目標に届いています」を表示する', async () => {
    await renderScreen('50.0', '60.0');
    expect(screen.getByTestId('estimate-not-needed-text')).toBeOnTheScreen();
    expect(screen.queryByTestId('estimate-range-text')).toBeNull();
  });

  it('次へで目標勉強時間の初期値(概算の上限)を設定し、目標入力画面へ進む', async () => {
    await renderScreen('60.0', '50.0');
    await fireEvent.press(screen.getByTestId('estimate-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/target');
  });

  it('目標 ≤ 現在 の場合、目標勉強時間は空欄のまま次へ進む', async () => {
    await renderScreen('50.0', '60.0');
    await fireEvent.press(screen.getByTestId('estimate-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/target');
  });
});
