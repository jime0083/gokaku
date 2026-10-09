import { resolveInitialTargetHours } from '@shared/index';

import type { OnboardingDraft } from './types';

/**
 * 目標勉強時間の自動入力(概算の上限)に関する判定(requirements 4-2 の 5, 2026-10-09 決定)。
 * 「ユーザーが自分で書き換えたか」は、現在の値が「最後に自動で入れた値」(autoFilledTargetHoursText)と
 * 一致するかどうかで判定する(自動で入れた後に何も変えていなければ一致したまま)。
 * 概算の決め手(受験: 偏差値・科目数、資格: 選んだ資格)を戻って変えた場合、この判定を使って
 * 「ユーザーが書き換えていない」ときだけ新しい上限に置き換える(estimate.tsx・cert-estimate.tsx で使う)
 */

/** 現在の目標勉強時間が、ユーザー自身の書き換えによるものか(自動で入れた値と異なるか) */
export function hasUserEditedTargetHours(draft: OnboardingDraft): boolean {
  return draft.targetHoursText.length > 0 && draft.targetHoursText !== draft.autoFilledTargetHoursText;
}

/**
 * 概算の上限(upperHours)から、目標勉強時間を自動で入れ(直す)ための更新内容を返す。
 * ユーザーが自分で書き換えていた場合、または既に同じ値が入っている場合は null(更新不要)
 */
export function resolveAutoFillPatch(
  draft: OnboardingDraft,
  upperHours: number,
): Pick<OnboardingDraft, 'targetHoursText' | 'autoFilledTargetHoursText'> | null {
  if (hasUserEditedTargetHours(draft)) {
    return null;
  }
  const next = String(resolveInitialTargetHours(upperHours));
  if (draft.targetHoursText === next && draft.autoFilledTargetHoursText === next) {
    return null;
  }
  return { targetHoursText: next, autoFilledTargetHoursText: next };
}

/**
 * 概算がない場合(資格ルートの「その他」)に、自動で入れていた値なら空欄に戻すための更新内容を返す。
 * ユーザーが自分で書き換えていた場合、または既に空欄の場合は null(更新不要)
 */
export function resolveAutoFillClearPatch(
  draft: OnboardingDraft,
): Pick<OnboardingDraft, 'targetHoursText' | 'autoFilledTargetHoursText'> | null {
  if (hasUserEditedTargetHours(draft)) {
    return null;
  }
  if (draft.targetHoursText.length === 0 && draft.autoFilledTargetHoursText === null) {
    return null;
  }
  return { targetHoursText: '', autoFilledTargetHoursText: null };
}
