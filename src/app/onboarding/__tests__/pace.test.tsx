import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, toJstDateKey } from '@shared/index';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { OnboardingDraftProvider, useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import type { OnboardingDraft } from '@/features/onboarding/types';
import PaceScreen from '@/app/onboarding/pace';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: mockReplace }),
}));

const todayKey = toJstDateKey(Date.now());

type SetupPatch = Partial<OnboardingDraft>;

/** テスト用: マウント時に draft をセットしてからペース確認画面を描画する(estimate.test.tsx と同じ考え方) */
function Setup({ patch }: { patch: SetupPatch }) {
  const { draft, updateDraft } = useOnboardingDraft();
  const prepared = draft.examDate === patch.examDate && draft.targetHoursText === patch.targetHoursText;

  useEffect(() => {
    if (!prepared) {
      updateDraft(patch);
    }
  }, [prepared, patch, updateDraft]);

  return prepared ? <PaceScreen /> : null;
}

async function renderScreen(patch: SetupPatch) {
  const result = await render(
    <OnboardingDraftProvider>
      <Setup patch={patch} />
    </OnboardingDraftProvider>,
  );
  await waitFor(() => screen.getByTestId('pace-question-text'));
  return result;
}

describe('PaceScreen(オンボーディング 7歩目。requirements 4-4, mokuhyo.txt 3)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
  });

  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('届くケース(最低ペースの合計 = 目標。警告なし)', async () => {
    // 目標10時間(600分)、D=5日、最低2時間0分 → 合計10時間0分(100.0%。ちょうど届く)
    await renderScreen({
      type: 'exam',
      targetHoursText: '10',
      examDate: addDays(todayKey, 5),
      minDailyMinutes: 120,
      goalDailyMinutes: 180,
    });

    expect(screen.getByTestId('pace-exam-date-text').props.children).toContain('あと5日');
    expect(screen.getByTestId('pace-target-hours-text').props.children.join('')).toBe(
      '目標勉強時間: 10時間',
    );
    expect(screen.getByTestId('pace-min-line-text').props.children).toBe(
      '1日2時間0分 × 5日 = 10時間0分(目標の100.0%)',
    );
    expect(screen.getByTestId('pace-goal-line-text').props.children).toBe(
      '1日3時間0分 × 5日 = 15時間0分(目標の150.0%)',
    );
    expect(screen.queryByTestId('pace-warning-text')).toBeNull();
  });

  it('届かないケース(最低ペースの合計 < 目標。警告と必要な1日時間を表示)', async () => {
    // 目標20時間(1200分)、D=5日、最低2時間0分 → 合計10時間0分(50.0%。届かない)
    // 必要な1日の時間 = 1200 ÷ 5 を10分単位に切り上げ = 240分 = 4時間0分
    await renderScreen({
      type: 'exam',
      targetHoursText: '20',
      examDate: addDays(todayKey, 5),
      minDailyMinutes: 120,
      goalDailyMinutes: 240,
    });

    expect(screen.getByTestId('pace-target-hours-text').props.children.join('')).toBe(
      '目標勉強時間: 20時間',
    );
    expect(screen.getByTestId('pace-min-line-text').props.children).toBe(
      '1日2時間0分 × 5日 = 10時間0分(目標の50.0%)',
    );
    expect(screen.getByTestId('pace-warning-text')).toHaveTextContent(
      '目標達成には1日4時間0分必要です',
    );
  });

  it('「修正する」を押すと1日の時間の画面(1つ前)に戻る', async () => {
    await renderScreen({
      type: 'exam',
      targetHoursText: '10',
      examDate: addDays(todayKey, 5),
      minDailyMinutes: 120,
      goalDailyMinutes: 180,
    });

    await fireEvent.press(screen.getByTestId('pace-fix-button'));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/daily-time');
  });

  it('戻る(StepScreen)も1日の時間の画面に戻る', async () => {
    await renderScreen({
      type: 'exam',
      targetHoursText: '10',
      examDate: addDays(todayKey, 5),
      minDailyMinutes: 120,
      goalDailyMinutes: 180,
    });

    await fireEvent.press(screen.getByTestId('pace-back-button'));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/daily-time');
  });

  it('「OK、登録する」は押しても画面遷移しない(登録処理は3-5cで実装)', async () => {
    await renderScreen({
      type: 'exam',
      targetHoursText: '10',
      examDate: addDays(todayKey, 5),
      minDailyMinutes: 120,
      goalDailyMinutes: 180,
    });

    await fireEvent.press(screen.getByTestId('pace-register-button'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
