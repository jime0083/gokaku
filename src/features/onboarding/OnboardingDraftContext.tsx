import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { getCurrentUid } from '@/config/firebase';
import { clearGoalReplacement, loadGoalReplacement, saveGoalReplacement, type GoalReplacementDraft } from './replacementStorage';

import { loadOnboardingDraft, saveOnboardingDraft } from './storage';
import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from './types';

type OnboardingDraftContextValue = {
  draft: OnboardingDraft;
  /** 入力値の一部を更新し、端末への一時保存も行う(requirements 4-1) */
  updateDraft: (patch: Partial<OnboardingDraft>) => void;
  /** 端末からの読み込みが完了したか(読み込み前に初期値で画面が一瞬表示されることを防ぐために使う) */
  ready: boolean;
  replacement: GoalReplacementDraft | null;
  persistenceError: boolean;
  cancelReplacement: () => Promise<void>;
};

const OnboardingDraftContext = createContext<OnboardingDraftContextValue | null>(null);

export function OnboardingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingDraft>(INITIAL_ONBOARDING_DRAFT);
  const [replacement, setReplacement] = useState<GoalReplacementDraft | null>(null);
  const [persistenceError, setPersistenceError] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      const uid = getCurrentUid();
      const record = uid ? await loadGoalReplacement(uid) : null;
      if (record && getCurrentUid() === uid) {
        if (isMounted) setReplacement(record);
        return record.draft;
      }
      return loadOnboardingDraft();
    };
    load().then((loaded) => {
      if (!isMounted) return;
      setDraft(loaded);
      setReady(true);
    }).catch(() => { if (isMounted) setPersistenceError(true); });
    return () => {
      isMounted = false;
    };
  }, []);

  const updateDraft = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      if (replacement) {
        // UIDが変わった場合、別ユーザーの入力や初回draftに書き込まない。
        if (getCurrentUid() === replacement.uid && !replacement.committedGoalId) {
          replacement.draft = next;
          void saveGoalReplacement(replacement).catch(() => setPersistenceError(true));
        }
      } else {
        void saveOnboardingDraft(next);
      }
      return next;
    });
  }, [replacement]);

  const cancelReplacement = useCallback(async () => {
    if (!replacement || replacement.committedGoalId || getCurrentUid() !== replacement.uid) {
      throw new Error('変更を破棄できません');
    }
    await clearGoalReplacement(replacement.uid);
    setReplacement(null);
    setDraft(INITIAL_ONBOARDING_DRAFT);
  }, [replacement]);

  const value = useMemo(() => ({ draft, updateDraft, ready, replacement, persistenceError, cancelReplacement }), [draft, updateDraft, ready, replacement, persistenceError, cancelReplacement]);

  return <OnboardingDraftContext.Provider value={value}>{children}</OnboardingDraftContext.Provider>;
}

export function useOnboardingDraft(): OnboardingDraftContextValue {
  const context = useContext(OnboardingDraftContext);
  if (!context) {
    throw new Error('useOnboardingDraft は OnboardingDraftProvider の内側で使う必要があります');
  }
  return context;
}
