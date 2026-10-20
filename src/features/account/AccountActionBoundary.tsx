import { useRouter } from 'expo-router';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { openSettingsLink } from '@/features/settings/settingsLinks';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';

import { AccountActionPopup } from './AccountActionPopup';
import type { AccountAction } from './accountActionFlow';
import { accountActionService } from './accountActionService';

type Target = Readonly<{ action: AccountAction; uid: string }>;
type Inspection = Awaited<ReturnType<typeof accountActionService.inspectPending>>;
type Outcome = Awaited<ReturnType<typeof accountActionService.perform>>;
type State = Readonly<{
  status: 'checking' | 'ready' | 'pending' | 'error';
  target: Target | null;
  retryOnly: boolean;
}>;

type AccountActions = Readonly<{
  ready: boolean;
  /** Also check this after awaits, before navigation or draft resumption. */
  isReady: () => boolean;
  request: (action: AccountAction, uid: string) => void;
}>;

const Context = createContext<AccountActions | null>(null);
const communicationError = '通信できませんでした。電波の良い場所で再度お試しください';
const initialState: State = { status: 'checking', target: null, retryOnly: true };
const readyState: State = { status: 'ready', target: null, retryOnly: false };

function retryOutcome(): Outcome {
  return { result: { status: 'incomplete', reason: 'retry-required' }, retryOnly: true };
}

function pendingState(inspection: Inspection, fallback: Target | null): State {
  // Identity comes from strict service inspection, never from current Auth.
  const record = inspection.checkpoint ?? inspection.nativeBlock;
  if (!record && inspection.retryOnly) {
    throw new Error('Pending operation identity is unavailable');
  }
  const target = record ? { uid: record.uid, action: record.action } : fallback;
  return {
    status: target ? 'pending' : 'ready',
    target,
    retryOnly: Boolean(record) || inspection.retryOnly,
  };
}

export function useAccountActions(): AccountActions {
  const value = useContext(Context);
  if (!value) throw new Error('AccountActionBoundary is required');
  return value;
}

export function AccountActionBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<State>(initialState);
  const current = useRef<State>(initialState);
  const mounted = useRef(true);
  const generation = useRef(0);
  const working = useRef(false);
  const completed = useRef(false);

  const publish = useCallback((next: State) => {
    if (!mounted.current) return;
    current.current = next;
    setState(next);
  }, []);

  const launch = useCallback(async () => {
    router.replace('/');
  }, [router]);

  const invalidateInspection = useCallback(() => {
    generation.current += 1;
  }, []);

  const inspect = useCallback(async () => {
    if (!mounted.current || working.current) return;
    const token = ++generation.current;
    const previous = current.current;
    const valid = () => mounted.current && generation.current === token;
    publish({ ...previous, status: 'checking' });
    try {
      const inspection = await accountActionService.inspectPending();
      if (!valid()) return;
      const next = pendingState(inspection, previous.target);
      const checkpoint = inspection.checkpoint;

      // Only confirmed cloud success can be resumed automatically.
      // A native-only block and cloud-pending both require an explicit retry.
      if (checkpoint && checkpoint.phase !== 'cloud-pending') {
        working.current = true;
        try {
          const outcome = await accountActionService.resume({ launch });
          if (!valid()) return;
          if (outcome.result.status === 'complete' && !outcome.retryOnly) {
            publish(readyState);
          } else {
            const after = await accountActionService.inspectPending();
            if (!valid()) return;
            publish(pendingState(after, next.target));
          }
        } finally {
          working.current = false;
        }
      } else {
        publish(next);
      }
    } catch {
      if (valid()) publish({ ...previous, status: 'error', retryOnly: true });
    }
  }, [launch, publish]);

  useEffect(() => {
    mounted.current = true;
    void inspect();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void inspect();
      } else if (!working.current) {
        // A read started before backgrounding cannot enable normal UI.
        invalidateInspection();
        publish({ ...current.current, status: 'checking' });
      }
    });
    return () => {
      mounted.current = false;
      invalidateInspection();
      subscription.remove();
    };
  }, [inspect, invalidateInspection, publish]);

  const isReady = useCallback(() => current.current.status === 'ready', []);

  const request = useCallback((action: AccountAction, uid: string) => {
    if (!mounted.current || working.current || current.current.status !== 'ready') return;
    completed.current = false;
    if (!uid) {
      publish({ status: 'error', target: null, retryOnly: true });
      return;
    }
    publish({ status: 'checking', target: { action, uid }, retryOnly: false });
    void inspect();
  }, [inspect, publish]);

  const perform = async (): Promise<Outcome> => {
    const before = current.current;
    if (
      !mounted.current || working.current || !before.target ||
      (before.status !== 'pending' && before.status !== 'checking')
    ) {
      return retryOutcome();
    }
    working.current = true;
    completed.current = false;
    const token = ++generation.current;
    const valid = () => mounted.current && generation.current === token;
    // Invalidate any older foreground inspection before awaiting the service.
    publish({ ...before, status: 'pending' });

    try {
      const inspection = await accountActionService.inspectPending();
      if (!valid()) return retryOutcome();
      const authoritative = pendingState(inspection, before.target);
      const target = authoritative.target;
      if (!target) throw new Error('Account action identity is unavailable');

      // All explicit retries use perform. The service verifies exact native
      // identity and decides whether any cloud request is permitted.
      const outcome = await accountActionService.perform(target.action, target.uid, { launch });
      if (!valid()) return retryOutcome();
      if (outcome.result.status === 'complete' && !outcome.retryOnly) {
        completed.current = true;
        return outcome;
      }

      const after = await accountActionService.inspectPending();
      if (!valid()) return retryOutcome();
      const next = pendingState(after, target);
      const retryOnly = outcome.retryOnly || next.retryOnly;
      publish({ ...next, retryOnly });
      return {
        result: outcome.result.status === 'complete'
          ? { status: 'incomplete', reason: 'retry-required' }
          : outcome.result,
        retryOnly,
      };
    } catch {
      if (valid()) publish({ ...current.current, status: 'error', retryOnly: true });
      return retryOutcome();
    } finally {
      working.current = false;
    }
  };

  const cancel = () => {
    if (working.current || current.current.status !== 'pending' || current.current.retryOnly) return;
    ++generation.current;
    publish(readyState);
  };

  const complete = () => {
    if (working.current || !completed.current) return;
    completed.current = false;
    ++generation.current;
    publish(readyState);
  };

  const value = useMemo(() => ({
    ready: state.status === 'ready',
    isReady,
    request,
  }), [isReady, request, state.status]);
  const blocked = state.status !== 'ready';

  return <Context.Provider value={value}>
    <View style={styles.root}>
      <View
        testID="account-action-content"
        style={styles.root}
        pointerEvents={blocked ? 'none' : 'auto'}
        accessibilityElementsHidden={blocked}
        importantForAccessibility={blocked ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {state.target && state.status !== 'error' ? <AccountActionPopup
        key={`${state.target.uid}:${state.target.action}`}
        action={state.target.action}
        retryOnly={state.retryOnly}
        perform={perform}
        onCancel={cancel}
        onComplete={complete}
        openSubscriptionManagement={() => openSettingsLink('subscription')}
      /> : null}
      {state.status === 'checking' || state.status === 'error' ? (
        <View testID="account-action-guard" style={styles.cover} accessibilityViewIsModal>
          {state.status === 'error' ? <>
            <ErrorText testID="account-action-inspect-error" message={communicationError} />
            <PrimaryButton
              title="再試行"
              testID="account-action-inspect-retry"
              onPress={() => { void inspect(); }}
            />
          </> : <Text testID="account-action-checking">確認中...</Text>}
        </View>
      ) : null}
    </View>
  </Context.Provider>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
});
