import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, toJstDateKey } from '@shared/index';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { saveOnboardingDraft } from '@/features/onboarding/storage';
import { INITIAL_ONBOARDING_DRAFT, OTHER_CERTIFICATION_ID } from '@/features/onboarding/types';

jest.mock('@/features/billing/subscriptionRepository', () => ({
  loadSubscriptionSession: jest.fn(async (uid: string) => ({
    uid, registered: true, xLinked: true, access: 'allowed' as const,
  })),
  subscribeSubscriptionAuth: jest.fn(() => jest.fn()),
}));

jest.mock('@/features/account/accountActionService', () => ({
  accountActionService: {
    inspectPending: jest.fn(async () => ({
      checkpoint: null, nativeBlock: null, retryOnly: false,
    })),
    perform: jest.fn(),
    resume: jest.fn(),
  },
}), { virtual: true });

const todayKey = toJstDateKey(Date.now());

/** daily-time 画面で最低・努力目標勉強時間を確定する(ドラムロールを開いて「完了」を押すだけ。既定値のまま確定) */
async function confirmDailyTimeRow(rowTestID: string): Promise<void> {
  await fireEvent.press(screen.getByTestId(rowTestID));
  await fireEvent.press(screen.getByTestId('daily-time-sheet-done-button'));
}

/**
 * problem P-015 の回帰テスト: オンボーディングの「戻る」が前の画面に戻り、入力値が保持されることを、
 * expo-router/testing-library の renderRouter で実際のナビゲーション(モックしない)を使って確認する。
 * 単体テスト(deviation.test.tsx 等)は router をモックしているため、本当の遷移は見ていなかった(problem P-015)
 *
 * renderRouter(expo-router@57.0.25 / @testing-library/react-native@14.0.1)は、内部の
 * render() が act() で初期レンダリングを行うが、renderRouter 自体はそれを await せずに同期的に返す。
 * そのため呼び出し側で await せずに次の操作(fireEvent 等)を行うと、React の act() のスコープが
 * 二重に開いた状態になり(「overlapping act() calls」警告)、それ以降に起きる setState が
 * コミットされなくなる(renderRouter を直接呼ぶどのテストでも再現する、ライブラリ側の既知の制約。
 * .maestro 等の実機確認では発生しない、テスト実行環境特有の問題)。
 * 対策として、renderRouter の呼び出し自体を `await act(async () => { ... })` で包み、
 * 初期レンダリングの act() スコープを確実に閉じてから操作を始める
 */
async function renderOnboardingRouter(initialUrl: string): Promise<void> {
  await act(async () => {
    renderRouter('src/app', { initialUrl });
  });
}

describe('オンボーディングの「戻る」(renderRouter。problem P-015)', () => {
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
  });

  it('通常の順送り: 大学入力 → 偏差値画面 → 戻る → 大学画面に戻り、入力値が保持されている', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-exam-button'));
    await fireEvent.press(screen.getByTestId('route-select-exam-button'));

    await waitFor(() => screen.getByTestId('university-input'));
    await fireEvent.changeText(screen.getByTestId('university-input'), '合格大学');
    await waitFor(() => expect(screen.getByTestId('university-input').props.value).toBe('合格大学'));
    await fireEvent.press(screen.getByTestId('university-next-button'));

    await waitFor(() => screen.getByTestId('target-deviation-input'));
    await fireEvent.press(screen.getByTestId('deviation-back-button'));

    await waitFor(() => screen.getByTestId('university-input'));
    expect(screen.getByTestId('university-input').props.value).toBe('合格大学');
  });

  it('最初のステップ(受験/資格の選択)で戻ると初回起動画面に戻る', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-back-button'));
    await fireEvent.press(screen.getByTestId('route-select-back-button'));

    await waitFor(() => screen.getByTestId('onboarding-start-button'));
  });

  it('再起動後に途中の画面(偏差値画面)から再開した場合も、戻ると大学画面に戻り入力値が保持されている' +
    '(入れ子の Stack の履歴は偏差値画面しかないが、ステップの並び順から戻り先を決めるため正しく戻れる。problem P-015)', async () => {
    // 大学は入力済み・偏差値は未入力の状態を端末の一時保存として用意する(アプリ再起動後の再開を模す)
    await saveOnboardingDraft({ ...INITIAL_ONBOARDING_DRAFT, type: 'exam', university: '合格大学' });

    // index.tsx の resolveOnboardingResumeRoute により、再開先は /onboarding/deviation への直接 push になる。
    // これを initialUrl で再現する(入れ子の Stack の履歴にはこの画面しか積まれない状態)
    await renderOnboardingRouter('/onboarding/deviation');

    await waitFor(() => screen.getByTestId('deviation-back-button'));
    await fireEvent.press(screen.getByTestId('deviation-back-button'));

    await waitFor(() => screen.getByTestId('university-input'));
    expect(screen.getByTestId('university-input').props.value).toBe('合格大学');
  });
});

describe('オンボーディングの「戻る」(資格ルート。renderRouter。3-2a requirements 4-3)', () => {
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
  });

  it('一覧から選択: 選択画面 → 資格の選択 → 概算(仮画面) → 戻る → 資格の選択に戻る', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-cert-button'));
    await fireEvent.press(screen.getByTestId('route-select-cert-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-it-passport'));

    await waitFor(() => screen.getByTestId('cert-estimate-name-text'));
    expect(screen.getByTestId('cert-estimate-name-text')).toHaveTextContent('ITパスポート');
    await fireEvent.press(screen.getByTestId('cert-estimate-back-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
  });

  it('「その他」: 資格名を入力して次へ(概算をスキップ)→ 戻る → 資格名の入力が保持されている', async () => {
    await renderOnboardingRouter('/onboarding');

    await waitFor(() => screen.getByTestId('route-select-cert-button'));
    await fireEvent.press(screen.getByTestId('route-select-cert-button'));

    await waitFor(() => screen.getByTestId('cert-search-input'));
    await fireEvent.press(screen.getByTestId('cert-row-other'));

    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    await fireEvent.changeText(screen.getByTestId('cert-other-name-input'), '〇〇検定');
    await waitFor(() =>
      expect(screen.getByTestId('cert-other-name-input').props.value).toBe('〇〇検定'),
    );
    await fireEvent.press(screen.getByTestId('cert-select-next-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    await fireEvent.press(screen.getByTestId('target-back-button'));

    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    expect(screen.getByTestId('cert-other-name-input').props.value).toBe('〇〇検定');
  });

  it('再起動後に途中の画面(一覧から選択済み・目標入力画面)から再開した場合も、戻ると概算の仮画面に戻る', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'cert',
      certId: 'it-passport',
      targetHoursText: '100',
    });

    await renderOnboardingRouter('/onboarding/target');

    await waitFor(() => screen.getByTestId('target-back-button'));
    await fireEvent.press(screen.getByTestId('target-back-button'));

    await waitFor(() => screen.getByTestId('cert-estimate-name-text'));
    expect(screen.getByTestId('cert-estimate-name-text')).toHaveTextContent('ITパスポート');
  });

  it('再起動後に途中の画面(「その他」・1日の時間の画面)から再開した場合も、戻ると目標入力画面に戻る(概算は飛ばす)', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'cert',
      certId: OTHER_CERTIFICATION_ID,
      certOtherName: '〇〇検定',
      targetHoursText: '500',
      examDate: '2099-01-01',
    });

    await renderOnboardingRouter('/onboarding/daily-time');

    await waitFor(() => screen.getByTestId('daily-time-back-button'));
    await fireEvent.press(screen.getByTestId('daily-time-back-button'));

    await waitFor(() => screen.getByTestId('target-hours-input'));
    await fireEvent.press(screen.getByTestId('target-back-button'));

    await waitFor(() => screen.getByTestId('cert-other-name-input'));
    expect(screen.getByTestId('cert-other-name-input').props.value).toBe('〇〇検定');
  });
});

describe('ペース確認画面への遷移・戻る(3-3。requirements 4-4。renderRouter)', () => {
  afterEach(async () => {
    await cleanup();
    await AsyncStorage.clear();
  });

  it('受験ルート: 1日の時間の画面から「次へ」でペース確認画面に進める', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'exam',
      university: '合格大学',
      targetHoursText: '1000',
      examDate: addDays(todayKey, 10),
    });
    await renderOnboardingRouter('/onboarding/daily-time');

    await waitFor(() => screen.getByTestId('min-daily-time-row'));
    await confirmDailyTimeRow('min-daily-time-row');
    await confirmDailyTimeRow('goal-daily-time-row');
    await fireEvent.press(screen.getByTestId('daily-time-next-button'));

    await waitFor(() => screen.getByTestId('pace-question-text'));
    expect(screen.getByTestId('pace-exam-date-text').props.children).toContain('あと10日');
  });

  it('資格ルート: 1日の時間の画面から「次へ」でペース確認画面に進める', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'cert',
      certId: 'it-passport',
      targetHoursText: '100',
      examDate: addDays(todayKey, 10),
    });
    await renderOnboardingRouter('/onboarding/daily-time');

    await waitFor(() => screen.getByTestId('min-daily-time-row'));
    await confirmDailyTimeRow('min-daily-time-row');
    await confirmDailyTimeRow('goal-daily-time-row');
    await fireEvent.press(screen.getByTestId('daily-time-next-button'));

    await waitFor(() => screen.getByTestId('pace-question-text'));
    expect(screen.getByTestId('pace-exam-date-text').props.children).toContain('あと10日');
  });

  it('「修正する」で1日の時間の画面に戻り、確定していた値が保持されている', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'exam',
      university: '合格大学',
      targetHoursText: '1000',
      examDate: addDays(todayKey, 10),
    });
    await renderOnboardingRouter('/onboarding/daily-time');

    await waitFor(() => screen.getByTestId('min-daily-time-row'));
    await confirmDailyTimeRow('min-daily-time-row');
    await confirmDailyTimeRow('goal-daily-time-row');
    await fireEvent.press(screen.getByTestId('daily-time-next-button'));

    await waitFor(() => screen.getByTestId('pace-fix-button'));
    await fireEvent.press(screen.getByTestId('pace-fix-button'));

    await waitFor(() => screen.getByTestId('min-daily-time-row'));
    expect(screen.getByTestId('min-daily-time-value').props.children).toBe('0時間10分');
    expect(screen.getByTestId('goal-daily-time-value').props.children).toBe('0時間10分');
  });

  it('再起動後にペース確認画面から再開した場合、戻ると1日の時間の画面に戻る', async () => {
    await saveOnboardingDraft({
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'exam',
      university: '合格大学',
      targetHoursText: '1000',
      examDate: addDays(todayKey, 10),
      minDailyMinutes: 120,
      goalDailyMinutes: 180,
    });
    await renderOnboardingRouter('/onboarding/pace');

    await waitFor(() => screen.getByTestId('pace-back-button'));
    await fireEvent.press(screen.getByTestId('pace-back-button'));

    await waitFor(() => screen.getByTestId('min-daily-time-row'));
    expect(screen.getByTestId('min-daily-time-value').props.children).toBe('2時間0分');
  });
});
