import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearOnboardingDraft,
  loadOnboardingDraft,
  ONBOARDING_DRAFT_STORAGE_KEY,
  saveOnboardingDraft,
} from '../storage';
import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from '../types';

describe('onboarding の一時保存', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('保存されていない場合は初期値を返す', async () => {
    expect(await loadOnboardingDraft()).toEqual(INITIAL_ONBOARDING_DRAFT);
  });

  it('保存した値をそのまま読み込める(往復)', async () => {
    const draft: OnboardingDraft = {
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'exam',
      university: '〇〇大学',
      targetDeviationText: '60.0',
      currentDeviationText: '50.0',
      subjectCount: 5,
      targetHoursText: '1200',
      examDate: '2026-12-01',
      minDailyMinutes: 60,
      goalDailyMinutes: 120,
    };
    await saveOnboardingDraft(draft);
    expect(await loadOnboardingDraft()).toEqual(draft);
  });

  it('登録できたら一時保存を消す', async () => {
    await saveOnboardingDraft({ ...INITIAL_ONBOARDING_DRAFT, university: '〇〇大学' });
    await clearOnboardingDraft();
    expect(await AsyncStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY)).toBeNull();
    expect(await loadOnboardingDraft()).toEqual(INITIAL_ONBOARDING_DRAFT);
  });

  it('壊れたデータが保存されていた場合は初期値にフォールバックする', async () => {
    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, 'not-json');
    expect(await loadOnboardingDraft()).toEqual(INITIAL_ONBOARDING_DRAFT);

    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(await loadOnboardingDraft()).toEqual(INITIAL_ONBOARDING_DRAFT);
  });

  it('形の壊れた項目だけ初期値にフォールバックし、正しい項目は残す', async () => {
    await AsyncStorage.setItem(
      ONBOARDING_DRAFT_STORAGE_KEY,
      JSON.stringify({ type: 'exam', university: 123, subjectCount: '5' }),
    );
    const loaded = await loadOnboardingDraft();
    expect(loaded.type).toBe('exam');
    expect(loaded.university).toBe(INITIAL_ONBOARDING_DRAFT.university);
    expect(loaded.subjectCount).toBe(INITIAL_ONBOARDING_DRAFT.subjectCount);
  });

  it('autoFilledTargetHoursText が無い旧形式の保存データを読んでも壊れない(初期値 null のまま、他の項目は残る。2026-10-09 追加)', async () => {
    await AsyncStorage.setItem(
      ONBOARDING_DRAFT_STORAGE_KEY,
      JSON.stringify({ type: 'exam', university: '〇〇大学', targetHoursText: '1800' }),
    );
    const loaded = await loadOnboardingDraft();
    expect(loaded.university).toBe('〇〇大学');
    expect(loaded.targetHoursText).toBe('1800');
    expect(loaded.autoFilledTargetHoursText).toBeNull();
  });

  it('autoFilledTargetHoursText を含む保存データを往復できる', async () => {
    const draft: OnboardingDraft = {
      ...INITIAL_ONBOARDING_DRAFT,
      type: 'exam',
      targetHoursText: '1800',
      autoFilledTargetHoursText: '1800',
    };
    await saveOnboardingDraft(draft);
    expect(await loadOnboardingDraft()).toEqual(draft);
  });
});
