import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from '../types';
import {
  hasUserEditedTargetHours,
  resolveAutoFillClearPatch,
  resolveAutoFillPatch,
} from '../targetHoursAutoFill';

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  ...overrides,
});

describe('hasUserEditedTargetHours', () => {
  it('未入力は書き換えていない', () => {
    expect(hasUserEditedTargetHours(draft())).toBe(false);
  });

  it('自動で入れた値と一致する場合は書き換えていない', () => {
    expect(
      hasUserEditedTargetHours(draft({ targetHoursText: '1800', autoFilledTargetHoursText: '1800' })),
    ).toBe(false);
  });

  it('自動で入れた値と異なる場合は書き換えている', () => {
    expect(
      hasUserEditedTargetHours(draft({ targetHoursText: '1234', autoFilledTargetHoursText: '1800' })),
    ).toBe(true);
  });

  it('自動入力の記録がない(旧形式の保存データ)場合、何か入力されていれば書き換えとみなす', () => {
    expect(
      hasUserEditedTargetHours(draft({ targetHoursText: '100', autoFilledTargetHoursText: null })),
    ).toBe(true);
  });
});

describe('resolveAutoFillPatch', () => {
  it('未入力の場合、概算の上限を自動で入れる', () => {
    expect(resolveAutoFillPatch(draft(), 1800)).toEqual({
      targetHoursText: '1800',
      autoFilledTargetHoursText: '1800',
    });
  });

  it('前回自動で入れた値のまま(書き換えていない)場合、新しい上限に置き換える', () => {
    expect(
      resolveAutoFillPatch(draft({ targetHoursText: '1800', autoFilledTargetHoursText: '1800' }), 4050),
    ).toEqual({ targetHoursText: '4050', autoFilledTargetHoursText: '4050' });
  });

  it('ユーザーが自分で書き換えていた場合は null(更新しない)', () => {
    expect(
      resolveAutoFillPatch(draft({ targetHoursText: '1234', autoFilledTargetHoursText: '1800' }), 4050),
    ).toBeNull();
  });

  it('すでに同じ値が入っている場合は null(更新不要)', () => {
    expect(
      resolveAutoFillPatch(draft({ targetHoursText: '1800', autoFilledTargetHoursText: '1800' }), 1800),
    ).toBeNull();
  });

  it('20,000時間を超える上限は20,000に切り詰める', () => {
    expect(resolveAutoFillPatch(draft(), 25_000)).toEqual({
      targetHoursText: '20000',
      autoFilledTargetHoursText: '20000',
    });
  });
});

describe('resolveAutoFillClearPatch', () => {
  it('自動で入れた値のまま(書き換えていない)場合、空欄に戻す', () => {
    expect(
      resolveAutoFillClearPatch(draft({ targetHoursText: '100', autoFilledTargetHoursText: '100' })),
    ).toEqual({ targetHoursText: '', autoFilledTargetHoursText: null });
  });

  it('ユーザーが自分で書き換えていた場合は null(残す)', () => {
    expect(
      resolveAutoFillClearPatch(draft({ targetHoursText: '1234', autoFilledTargetHoursText: '100' })),
    ).toBeNull();
  });

  it('すでに空欄の場合は null(更新不要)', () => {
    expect(resolveAutoFillClearPatch(draft())).toBeNull();
  });
});
