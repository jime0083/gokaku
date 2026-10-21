import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect,
  useRef, useState, type ReactNode,
} from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { getCurrentUid } from '@/config/firebase';
import { useAccountActions } from '@/features/account/AccountActionBoundary';
import type { OnboardingRoute } from '@/features/onboarding/navigation';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';

import { recoverStartupPurchases } from './recoverPendingPurchases';
import {
  loadSubscriptionSession, subscribeSubscriptionAuth,
} from './subscriptionRepository';

export type SubscriptionAccess = Readonly<{
  afterPurchase: () => Promise<void>;
  reportLaunchInspection: (
    expectedUid: string | null,
    owner: ReturnType<typeof useAccountActions>,
    result: boolean | { phase: 'checking' | 'error'; retry: () => void },
    replacementRoute?: OnboardingRoute,
  ) => void;
}>;

/** Paywallの単体テストでも、実routerを保ったProviderを使用できる。 */
export const SubscriptionAccessContext = createContext<SubscriptionAccess | undefined>(undefined);

export function useSubscriptionAccess(): SubscriptionAccess {
  const value = useContext(SubscriptionAccessContext);
  if (!value) throw new Error('SubscriptionBoundary is required');
  return value;
}

type Session = Awaited<ReturnType<typeof loadSubscriptionSession>>;
type AccountActions = ReturnType<typeof useAccountActions>;
type Destination = '/home' | '/x-link' | '/paywall' | OnboardingRoute;
type LaunchInspection = {
  uid: string | null;
  owner: AccountActions;
  result: boolean | { phase: 'checking' | 'error'; retry: () => void };
  replacementRoute?: OnboardingRoute;
};
type State = {
  phase: 'checking' | 'ready' | 'error';
  uid: string | null;
  owner: AccountActions | null;
  session: Session | null;
  target: Destination | null;
  waitForLaunch?: boolean;
};

const initialState: State = {
  phase: 'checking', uid: null, owner: null, session: null, target: null,
};
const purchaseUnavailable =
  '購入の確認ができませんでした。通信状況を確認して「購入の復元」をお試しください';
const communicationError = '通信できませんでした。電波の良い場所で再度お試しください';

export function SubscriptionBoundary({
  children, now = Date.now,
}: {
  children: ReactNode;
  now?: () => number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const navigationKey = useRootNavigationState()?.key;
  const accountActions = useAccountActions();
  const [state, setState] = useState<State>(initialState);
  const current = useRef<State>(initialState);
  const mounted = useRef(false);
  const active = useRef(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const generation = useRef(0);
  const completedUid = useRef<string | null | undefined>(undefined);
  const recoveryStarted = useRef<string | null>(null);
  const launchInspection = useRef<LaunchInspection | null>(null);
  const [inspection, setInspection] = useState<LaunchInspection | null>(null);
  const environment = useRef({ pathname, navigationKey, accountActions, now });

  useLayoutEffect(() => {
    environment.current = { pathname, navigationKey, accountActions, now };
  });

  const publish = useCallback((next: State) => {
    if (!mounted.current) return;
    current.current = next;
    setState(next);
  }, []);

  const invalidateGeneration = useCallback(() => {
    ++generation.current;
  }, []);

  // Lookupと再開ルートの決定はLaunchScreenだけが行う。
  const reportLaunchInspection = useCallback((
    expectedUid: string | null,
    owner: AccountActions,
    result: boolean | { phase: 'checking' | 'error'; retry: () => void },
    replacementRoute?: OnboardingRoute,
  ) => {
    const env = environment.current;
    if (!mounted.current || getCurrentUid() !== expectedUid ||
        env.accountActions !== owner || !owner.ready || !owner.isReady()) return;
    const next = { uid: expectedUid, owner, result, replacementRoute };
    launchInspection.current = next;
    setInspection(next);
    const snapshot = current.current;
    // 通知だけでは契約判定を確定しない。進行中の最新checkと合流する。
    if (!active.current || snapshot.phase !== 'ready' ||
        snapshot.uid !== expectedUid || snapshot.owner !== owner ||
        typeof result !== 'boolean' ||
        (snapshot.session?.registered && snapshot.session.access === 'locked')) {
      publish({ ...snapshot });
      return;
    }
    completedUid.current = expectedUid;
    publish({
      ...snapshot,
      waitForLaunch: false,
      target: env.pathname === '/'
        ? replacementRoute ?? (!result && snapshot.session?.registered &&
          snapshot.session.access === 'allowed'
          ? snapshot.session.xLinked ? '/home' : '/x-link'
          : null)
        : null,
    });
  }, [publish]);

  const check = useCallback(async (reason: 'normal' | 'purchase' = 'normal'): Promise<void> => {
    const env = environment.current;
    const owner = env.accountActions;
    const uid = getCurrentUid();
    if (!mounted.current || !active.current || !env.navigationKey ||
        !owner.ready || !owner.isReady()) {
      if (reason === 'purchase') throw new Error(purchaseUnavailable);
      return;
    }

    const token = ++generation.current;
    const previous = current.current;
    const mode = reason === 'purchase'
      ? 'purchase'
      : completedUid.current === uid ? 'foreground' : 'startup';
    const valid = () => mounted.current && active.current &&
      generation.current === token && getCurrentUid() === uid &&
      environment.current.navigationKey === env.navigationKey &&
      environment.current.accountActions === owner &&
      owner.ready && owner.isReady();

    publish({ phase: 'checking', uid, owner, session: null, target: null });

    if (!uid) {
      completedUid.current = null;
      publish({ phase: 'ready', uid: null, owner, session: null, target: null });
      if (reason === 'purchase') throw new Error(purchaseUnavailable);
      return;
    }

    const readDecision = async (): Promise<boolean> => {
      const session = await loadSubscriptionSession(uid, env.now());
      if (!valid()) return false;
      if (session.uid !== uid) throw new Error(purchaseUnavailable);
      if (mode === 'purchase' && (!session.registered || session.access !== 'allowed')) {
        throw new Error(purchaseUnavailable);
      }

      const path = environment.current.pathname;
      const inspection = launchInspection.current;
      const inspected = inspection?.uid === uid && inspection.owner === owner &&
        typeof inspection.result === 'boolean';
      let target: Destination | null = null;
      let waitForLaunch = false;
      if (path === '/' && inspected && inspection.replacementRoute &&
          !(session.registered && session.access === 'locked')) {
        target = inspection.replacementRoute;
      } else if (session.registered) {
        if (session.access === 'locked') {
          target = '/paywall';
        } else if (mode === 'purchase') {
          target = session.xLinked ? '/home' : '/x-link';
        } else if (mode === 'startup' && path === '/') {
          waitForLaunch = !inspected;
          if (inspected && !inspection.result) {
            target = session.xLinked ? '/home' : '/x-link';
          }
        } else if (mode === 'startup' && path === '/paywall') {
          target = session.xLinked ? '/home' : '/x-link';
        }
      }
      publish({ phase: 'ready', uid, owner, session, target, waitForLaunch });
      return true;
    };

    try {
      if (!await readDecision()) {
        if (reason === 'purchase') throw new Error(purchaseUnavailable);
        return;
      }
      if (!current.current.waitForLaunch) completedUid.current = uid;
    } catch {
      if (valid()) {
        publish(reason === 'purchase'
          ? { ...previous, uid, owner }
          : { phase: 'error', uid, owner, session: null, target: null });
      }
      if (reason === 'purchase') throw new Error(purchaseUnavailable);
      return;
    }

    if (mode !== 'startup' || !valid() || recoveryStarted.current === uid) return;
    recoveryStarted.current = uid;

    // canonicalの表示を先に確定する。Apple API待ちで既存契約を遮断しない。
    // このasync処理内でawait/catchし、購入結果だけでは利用を許可しない。
    try {
      await recoverStartupPurchases(uid);
    } catch {
      // 再確認失敗時も既存契約を使う。未完了取引の管理はbinding側。
    }
    if (!valid()) return;
    try {
      await readDecision();
    } catch {
      // 初回に確定したcanonical判断を維持する。
    }
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    let lastUid = getCurrentUid();
    const unsubscribe = subscribeSubscriptionAuth((uid) => {
      if (lastUid === uid) return;
      lastUid = uid;
      ++generation.current;
      completedUid.current = undefined;
      recoveryStarted.current = null;
      launchInspection.current = null;
      setInspection(null);
      publish({
        phase: 'checking', uid, owner: null, session: null, target: null,
      });
      void check();
    });
    const subscription = AppState.addEventListener('change', (status) => {
      const wasActive = active.current;
      active.current = status === 'active';
      if (!active.current) {
        ++generation.current;
        publish({
          phase: 'checking', uid: getCurrentUid(), owner: null, session: null, target: null,
        });
      } else if (!wasActive) {
        void check();
      }
    });
    void check();
    return () => {
      mounted.current = false;
      invalidateGeneration();
      unsubscribe();
      subscription.remove();
    };
  }, [accountActions, navigationKey, check, publish, invalidateGeneration]);

  const destination = state.session?.registered && state.session.access === 'locked'
    ? '/paywall'
    : state.target;
  const currentInspection = inspection?.uid === getCurrentUid() &&
    inspection?.owner === accountActions ? inspection : null;
  const launchPending = pathname === '/' && getCurrentUid() !== null &&
    typeof currentInspection?.result !== 'boolean';
  const launchFailure = launchPending && typeof currentInspection?.result === 'object' &&
    currentInspection.result.phase === 'error' ? currentInspection.result : null;
  const ready = !launchPending && accountActions.ready && accountActions.isReady() && Boolean(navigationKey) &&
    state.owner === accountActions && state.phase === 'ready' && !state.waitForLaunch &&
    state.uid === getCurrentUid();

  useEffect(() => {
    if (!ready) return;
    if (destination && pathname !== destination) {
      router.replace(destination === '/home' ? '/(tabs)/home' : destination);
    } else if (state.target) {
      publish({ ...state, target: null });
    }
  }, [destination, pathname, publish, ready, router, state]);

  const afterPurchase = useCallback(() => check('purchase'), [check]);
  // Contextの更新でLaunchScreenも最新UIDを観測する。
  // メソッド自体は安定しているため、canonical再読込ではlookupを再実行しない。
  const value = { afterPurchase, reportLaunchInspection };
  const blocked = !ready || Boolean(destination && pathname !== destination);

  // 子を確認中にアンマウントしない。タイマー・記録・nativeへの操作は行わない。
  // xLinkedは起動/購入の行き先だけに使うため、X連携完了→homeを古い値で戻さない。
  return (
    <SubscriptionAccessContext.Provider value={value}>
      <View style={styles.root}>
        <View
          testID="subscription-content"
          style={styles.root}
          pointerEvents={blocked ? 'none' : 'auto'}
          accessibilityElementsHidden={blocked}
          importantForAccessibility={blocked ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {blocked ? (
          <View testID="subscription-guard" style={styles.cover} accessibilityViewIsModal>
            {state.phase === 'error' ? <>
              <ErrorText message={communicationError} />
              <PrimaryButton
                title="再試行"
                testID="subscription-retry"
                onPress={() => { void check(); }}
              />
            </> : launchFailure ? <>
              <ErrorText message="再開データを読み込めませんでした" testID="launch-inspection-error" />
              <PrimaryButton
                title="再試行"
                testID="launch-inspection-retry"
                onPress={launchFailure.retry}
              />
            </> : <Text>契約状態を確認中...</Text>}
          </View>
        ) : null}
      </View>
    </SubscriptionAccessContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
});
