import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { loadOnboardingDraft, saveOnboardingDraft } from './storage';
import { INITIAL_ONBOARDING_DRAFT, type OnboardingDraft } from './types';

type OnboardingDraftContextValue = {
  draft: OnboardingDraft;
  /** 入力値の一部を更新し、端末への一時保存も行う(requirements 4-1) */
  updateDraft: (patch: Partial<OnboardingDraft>) => void;
  /** 端末からの読み込みが完了したか(読み込み前に初期値で画面が一瞬表示されることを防ぐために使う) */
  ready: boolean;
};

const OnboardingDraftContext = createContext<OnboardingDraftContextValue | null>(null);

export function OnboardingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingDraft>(INITIAL_ONBOARDING_DRAFT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isMounted = true;
    loadOnboardingDraft().then((loaded) => {
      if (!isMounted) return;
      setDraft(loaded);
      setReady(true);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const updateDraft = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      void saveOnboardingDraft(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ draft, updateDraft, ready }), [draft, updateDraft, ready]);

  return <OnboardingDraftContext.Provider value={value}>{children}</OnboardingDraftContext.Provider>;
}

export function useOnboardingDraft(): OnboardingDraftContextValue {
  const context = useContext(OnboardingDraftContext);
  if (!context) {
    throw new Error('useOnboardingDraft は OnboardingDraftProvider の内側で使う必要があります');
  }
  return context;
}
