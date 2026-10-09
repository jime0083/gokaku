import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { OnboardingDraftProvider, useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import CertEstimateScreen from '@/app/onboarding/cert-estimate';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

/** テスト用: マウント時に certId(と任意で targetHoursText)をセットしてから概算画面を描画する */
function Setup({
  certId,
  targetHoursText = '',
  capture,
}: {
  certId: string;
  targetHoursText?: string;
  capture?: (draft: { targetHoursText: string }) => void;
}) {
  const { draft, updateDraft } = useOnboardingDraft();
  const prepared = draft.certId === certId;

  useEffect(() => {
    if (!prepared) {
      updateDraft({ type: 'cert', certId, targetHoursText });
    }
  }, [prepared, certId, targetHoursText, updateDraft]);

  useEffect(() => {
    if (prepared && capture) {
      capture({ targetHoursText: draft.targetHoursText });
    }
  }, [prepared, capture, draft.targetHoursText]);

  return prepared ? <CertEstimateScreen /> : null;
}

async function renderScreen(certId: string, capture?: (draft: { targetHoursText: string }) => void) {
  const result = await render(
    <OnboardingDraftProvider>
      <Setup certId={certId} capture={capture} />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('cert-estimate-next-button'));
  return result;
}

describe('CertEstimateScreen(オンボーディング 3歩目・資格ルート。requirements 4-3, mokuhyo.txt 2)', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('範囲あり(宅地建物取引士): 「約300〜400時間」と出典を表示する', async () => {
    await renderScreen('real-estate-transaction-specialist');
    expect(screen.getByTestId('cert-estimate-name-text')).toHaveTextContent('宅地建物取引士');
    expect(screen.getByTestId('cert-estimate-amount-text')).toHaveTextContent('約300〜400時間');
    expect(screen.getByTestId('cert-estimate-disclaimer-text')).toHaveTextContent('あくまで目安です');
    expect(screen.getByTestId('cert-estimate-source-text').props.children.join('')).toContain(
      '出典: フォーサイト',
    );
    expect(screen.getByTestId('cert-estimate-source-text').props.children.join('')).toContain(
      '2026-08-02 更新',
    );
  });

  it('1つの値(司法書士): 「約3,000時間」を表示する(3桁区切り)', async () => {
    await renderScreen('judicial-scrivener');
    expect(screen.getByTestId('cert-estimate-name-text')).toHaveTextContent('司法書士');
    expect(screen.getByTestId('cert-estimate-amount-text')).toHaveTextContent('約3,000時間');
    expect(screen.getByTestId('cert-estimate-source-text').props.children.join('')).toContain(
      '出典: 資格Times',
    );
  });

  it('次へで、未入力なら目標勉強時間の初期値(概算の上限)を設定して目標入力画面へ進む', async () => {
    let latest: { targetHoursText: string } | undefined;
    await renderScreen('real-estate-transaction-specialist', (draft) => {
      latest = draft;
    });
    await fireEvent.press(screen.getByTestId('cert-estimate-next-button'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/target');
    expect(latest?.targetHoursText).toBe('400');
  });
});
