import { INITIAL_ONBOARDING_DRAFT, OTHER_CERTIFICATION_ID, type OnboardingDraft } from '../types';
import { resolveOnboardingBackRoute, resolveOnboardingResumeRoute } from '../navigation';

const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const NOW = jst('2026-10-07T10:00:00');

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  ...overrides,
});

describe('resolveOnboardingResumeRoute', () => {
  it('未選択(type: null)は選択画面', () => {
    expect(resolveOnboardingResumeRoute(draft(), NOW)).toBe('/onboarding');
  });

  it('資格ルート(type: cert)で資格が未選択は資格の選択画面', () => {
    expect(resolveOnboardingResumeRoute(draft({ type: 'cert' }), NOW)).toBe('/onboarding/cert-select');
  });

  it('資格ルートで一覧から選択済み・目標勉強時間が未入力(概算が必要)は概算画面', () => {
    expect(
      resolveOnboardingResumeRoute(draft({ type: 'cert', certId: 'it-passport' }), NOW),
    ).toBe('/onboarding/cert-estimate');
  });

  it('資格ルートで目標勉強時間・試験日が未入力・不正は目標入力画面', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({ type: 'cert', certId: 'it-passport', targetHoursText: '100' }),
        NOW,
      ),
    ).toBe('/onboarding/target');
  });

  it('資格ルートでここまで揃っていれば1日の時間の画面', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'cert',
          certId: 'it-passport',
          targetHoursText: '100',
          examDate: '2026-10-08',
        }),
        NOW,
      ),
    ).toBe('/onboarding/daily-time');
  });

  it('資格ルート(その他)で資格名が未入力・不正は資格の選択画面(入力欄のまま再開)', () => {
    expect(
      resolveOnboardingResumeRoute(draft({ type: 'cert', certId: OTHER_CERTIFICATION_ID }), NOW),
    ).toBe('/onboarding/cert-select');
  });

  it('資格ルート(その他)で資格名が入力済みは概算をスキップして目標入力画面へ', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({ type: 'cert', certId: OTHER_CERTIFICATION_ID, certOtherName: '〇〇検定' }),
        NOW,
      ),
    ).toBe('/onboarding/target');
  });

  it('大学が未入力は大学入力画面', () => {
    expect(resolveOnboardingResumeRoute(draft({ type: 'exam' }), NOW)).toBe('/onboarding/university');
  });

  it('偏差値が未入力・不正は偏差値入力画面', () => {
    expect(
      resolveOnboardingResumeRoute(draft({ type: 'exam', university: '〇〇大学' }), NOW),
    ).toBe('/onboarding/deviation');
    expect(
      resolveOnboardingResumeRoute(
        draft({ type: 'exam', university: '〇〇大学', targetDeviationText: '60.0' }),
        NOW,
      ),
    ).toBe('/onboarding/deviation');
  });

  it('目標勉強時間が未入力(概算が必要)は概算画面', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
        }),
        NOW,
      ),
    ).toBe('/onboarding/estimate');
  });

  it('目標 ≤ 現在(概算なし)で目標勉強時間が未入力の場合は目標入力画面へ直接進む', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '50.0',
          currentDeviationText: '60.0',
        }),
        NOW,
      ),
    ).toBe('/onboarding/target');
  });

  it('目標勉強時間・試験日が未入力・不正は目標入力画面', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
          targetHoursText: '1000',
        }),
        NOW,
      ),
    ).toBe('/onboarding/target');

    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
          targetHoursText: '1000',
          examDate: '2026-10-06', // 過去日(不正)
        }),
        NOW,
      ),
    ).toBe('/onboarding/target');
  });

  it('ここまで揃っていれば 1日の時間の画面', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
          targetHoursText: '1000',
          examDate: '2026-10-08',
        }),
        NOW,
      ),
    ).toBe('/onboarding/daily-time');
  });

  it('1日の最低・努力目標勉強時間が確定していればペース確認画面(受験ルート)', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
          targetHoursText: '1000',
          examDate: '2026-10-08',
          minDailyMinutes: 60,
          goalDailyMinutes: 90,
        }),
        NOW,
      ),
    ).toBe('/onboarding/pace');
  });

  it('努力目標 < 最低 の場合はペースへ進めず、1日の時間の画面のまま', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'exam',
          university: '〇〇大学',
          targetDeviationText: '60.0',
          currentDeviationText: '50.0',
          targetHoursText: '1000',
          examDate: '2026-10-08',
          minDailyMinutes: 90,
          goalDailyMinutes: 60,
        }),
        NOW,
      ),
    ).toBe('/onboarding/daily-time');
  });

  it('1日の最低・努力目標勉強時間が確定していればペース確認画面(資格ルート)', () => {
    expect(
      resolveOnboardingResumeRoute(
        draft({
          type: 'cert',
          certId: 'it-passport',
          targetHoursText: '100',
          examDate: '2026-10-08',
          minDailyMinutes: 60,
          goalDailyMinutes: 90,
        }),
        NOW,
      ),
    ).toBe('/onboarding/pace');
  });
});

describe('resolveOnboardingBackRoute(problem P-015: 戻る先をステップの並び順から決める)', () => {
  it('最初のステップ(/onboarding)の戻り先は初回起動画面', () => {
    expect(resolveOnboardingBackRoute('/onboarding', draft())).toBe('/');
  });

  it('各ステップの戻り先は1つ前のステップ(ナビゲーション履歴には依存しない。受験ルート)', () => {
    const examDraft = draft({ type: 'exam' });
    expect(resolveOnboardingBackRoute('/onboarding/university', examDraft)).toBe('/onboarding');
    expect(resolveOnboardingBackRoute('/onboarding/deviation', examDraft)).toBe('/onboarding/university');
    expect(resolveOnboardingBackRoute('/onboarding/estimate', examDraft)).toBe('/onboarding/deviation');
    expect(resolveOnboardingBackRoute('/onboarding/target', examDraft)).toBe('/onboarding/estimate');
    expect(resolveOnboardingBackRoute('/onboarding/daily-time', examDraft)).toBe('/onboarding/target');
    expect(resolveOnboardingBackRoute('/onboarding/pace', examDraft)).toBe('/onboarding/daily-time');
  });

  it('資格ルート(一覧から選択)の戻り先(requirements 4-3)', () => {
    const certDraft = draft({ type: 'cert', certId: 'it-passport' });
    expect(resolveOnboardingBackRoute('/onboarding/cert-select', certDraft)).toBe('/onboarding');
    expect(resolveOnboardingBackRoute('/onboarding/cert-estimate', certDraft)).toBe(
      '/onboarding/cert-select',
    );
    expect(resolveOnboardingBackRoute('/onboarding/target', certDraft)).toBe('/onboarding/cert-estimate');
    expect(resolveOnboardingBackRoute('/onboarding/daily-time', certDraft)).toBe('/onboarding/target');
    expect(resolveOnboardingBackRoute('/onboarding/pace', certDraft)).toBe('/onboarding/daily-time');
  });

  it('資格ルート(その他)は概算画面を飛ばして戻る', () => {
    const otherDraft = draft({ type: 'cert', certId: OTHER_CERTIFICATION_ID });
    expect(resolveOnboardingBackRoute('/onboarding/cert-select', otherDraft)).toBe('/onboarding');
    expect(resolveOnboardingBackRoute('/onboarding/target', otherDraft)).toBe('/onboarding/cert-select');
    expect(resolveOnboardingBackRoute('/onboarding/daily-time', otherDraft)).toBe('/onboarding/target');
    expect(resolveOnboardingBackRoute('/onboarding/pace', otherDraft)).toBe('/onboarding/daily-time');
  });
});
