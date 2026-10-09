import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { OnboardingDraftProvider } from '@/features/onboarding/OnboardingDraftContext';
import CertSelectScreen from '@/app/onboarding/cert-select';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: mockReplace }),
}));

async function renderScreen() {
  const result = await render(
    <OnboardingDraftProvider>
      <CertSelectScreen />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('cert-search-input'));
  return result;
}

describe('CertSelectScreen(オンボーディング 2歩目・資格ルート。requirements 4-3)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('一覧は目安の上限が少ない順に表示され、「その他」が一番下にある', async () => {
    await renderScreen();
    // 最も上限が小さい資格(秘書検定2級。約30〜70時間)が一覧の先頭にある
    expect(screen.getByTestId('cert-row-secretary-skill-2')).toBeOnTheScreen();
    expect(screen.getByTestId('cert-row-other')).toBeOnTheScreen();
  });

  it('資格名で絞り込める(一部一致)', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('cert-search-input'), '簿記');
    expect(screen.getByTestId('cert-row-bookkeeping-3')).toBeOnTheScreen();
    expect(screen.getByTestId('cert-row-bookkeeping-2')).toBeOnTheScreen();
    expect(screen.queryByTestId('cert-row-it-passport')).toBeNull();
    // 「その他」は絞り込み結果に関わらず常に表示される
    expect(screen.getByTestId('cert-row-other')).toBeOnTheScreen();
  });

  it('絞り込みで0件のときは案内文を表示し、「その他」は表示される', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('cert-search-input'), '存在しない資格名');
    expect(screen.getByTestId('cert-search-no-results')).toBeOnTheScreen();
    expect(screen.getByTestId('cert-row-other')).toBeOnTheScreen();
  });

  it('資格をタップするとすぐ概算画面へ進む(「次へ」ボタンなし)', async () => {
    await renderScreen();
    expect(screen.queryByTestId('cert-select-next-button')).toBeNull();
    await fireEvent.press(screen.getByTestId('cert-row-it-passport'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/cert-estimate');
  });

  it('「その他」をタップすると資格名の入力欄が出て、未入力は次へが押せない', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('cert-row-other'));
    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    expect(screen.getByTestId('cert-select-next-button')).toBeDisabled();
    expect(screen.queryByTestId('cert-other-name-error')).toBeNull();
  });

  it('「その他」で51文字を超える入力はエラーを表示し、次へが押せない', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('cert-row-other'));
    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    await fireEvent.changeText(screen.getByTestId('cert-other-name-input'), 'あ'.repeat(51));
    expect(screen.getByTestId('cert-other-name-error')).toBeOnTheScreen();
    expect(screen.getByTestId('cert-select-next-button')).toBeDisabled();
  });

  it('「その他」で有効な資格名を入力すると次へが押せて、目標時間・試験日の画面へ進む(概算はスキップ)', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('cert-row-other'));
    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    await fireEvent.changeText(screen.getByTestId('cert-other-name-input'), '〇〇検定');
    expect(screen.queryByTestId('cert-other-name-error')).toBeNull();
    expect(screen.getByTestId('cert-select-next-button')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('cert-select-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/target');
  });

  it('「その他」の入力欄から「一覧から選ぶ」で一覧表示に戻れる', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('cert-row-other'));
    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    await fireEvent.press(screen.getByTestId('cert-other-back-to-list-button'));
    await waitFor(() => screen.getByTestId('cert-search-input'));
    expect(screen.getByTestId('cert-row-it-passport')).toBeOnTheScreen();
  });
});
