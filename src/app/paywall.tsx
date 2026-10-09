import { deriveAppAccountToken } from '@shared/index';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorText } from '@/components/ErrorText';
import { PrimaryButton } from '@/components/PrimaryButton';
import { getCurrentUid } from '@/config/firebase';
import { TERMS_OF_SERVICE_URL, PRIVACY_POLICY_URL } from '@/config/legalLinks';
import { calculateYearlyDiscountPercent } from '@/features/billing/discount';
import {
  fetchBillingProducts,
  finishPurchaseTransaction,
  purchaseBillingProduct,
  restoreBillingPurchases,
} from '@/features/billing/billingClient';
import {
  BillingCancelledError,
  type BillingPlan,
  type BillingProduct,
  type BillingPurchaseResult,
} from '@/features/billing/types';
import { verifyApplePurchase, type VerifyPurchaseResult } from '@/features/billing/verifyPurchase';
import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * 課金画面(4-1b・4-2c。requirements 3-4・4-5 の 2)。
 * 月額/年額の選択・購入・購入の復元・利用規約/プライバシーポリシーのリンクを表示する。
 * 「戻る」は付けない(課金必須のため)。
 * 購入・復元の後は Cloud Functions の verifyApplePurchase でサーバーの確認を行い、
 * active と確認できた場合にだけ finishTransaction(購入の完了処理)をして次の画面へ進む。
 * それ以外(確認できない・別アカウント・不正な取引・期限切れ)は finishTransaction をせず、
 * 課金画面のまま requirements 3-4 の文言を表示する
 */

/** できることの3行(requirements 4-5 の 2 の例の文言をそのまま使う) */
const FEATURE_LINES: readonly string[] = [
  '勉強時間をタイマーで記録',
  '最低時間に届かない日は X に自動投稿してサボれなくする',
  '試験日までの進み具合をひと目で確認',
];

/**
 * 購入・復元に成功した後に進む仮の行き先(4-3 で X 連携の画面に差し替える)。
 * X 連携の画面がまだ無いため、初回起動画面に戻す
 */
const NEXT_ROUTE_AFTER_PURCHASE = '/' as const;

/** requirements 3-4・4-5 の 2 の文言 */
const PURCHASE_FAILED_MESSAGE = '購入できませんでした。時間をおいてもう一度お試しください';
const VERIFICATION_UNAVAILABLE_MESSAGE =
  '購入の確認ができませんでした。通信状況を確認して「購入の復元」をお試しください';
const OWNED_BY_OTHER_ACCOUNT_MESSAGE = 'この購入は別のアカウントで利用されています';
const NO_ACTIVE_SUBSCRIPTION_MESSAGE =
  '有効なサブスクリプションが見つかりませんでした。プランを選んで購入してください';

/** active 以外の verifyApplePurchase の結果を、表示する文言に変換する(requirements 3-4) */
function describeVerifyFailure(outcome: Exclude<VerifyPurchaseResult, { status: 'active' }>): string {
  switch (outcome.status) {
    case 'expired':
      return NO_ACTIVE_SUBSCRIPTION_MESSAGE;
    case 'invalid-transaction':
      return PURCHASE_FAILED_MESSAGE;
    case 'owned-by-other-account':
      return OWNED_BY_OTHER_ACCOUNT_MESSAGE;
    case 'verification-unavailable':
    default:
      return VERIFICATION_UNAVAILABLE_MESSAGE;
  }
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; monthly: BillingProduct; yearly: BillingProduct };

function findProduct(products: BillingProduct[], plan: BillingPlan): BillingProduct | null {
  return products.find((product) => product.plan === plan) ?? null;
}

export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [selectedPlan, setSelectedPlan] = useState<BillingPlan | null>(null);
  const [processing, setProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // 再読み込みボタンを押すたびに値を変え、下の useEffect を再実行させる
  const [reloadToken, setReloadToken] = useState(0);

  // OnboardingDraftContext と同じ形(Promise の .then/.catch の中で setState する)にする。
  // useCallback でくるんだ関数を直接呼ぶと、たとえ await の後で setState していても
  // react-hooks/set-state-in-effect に引っかかる(別の書き方を2回試して確認済み)
  useEffect(() => {
    let active = true;
    fetchBillingProducts()
      .then((products) => {
        if (!active) {
          return;
        }
        const monthly = findProduct(products, 'monthly');
        const yearly = findProduct(products, 'yearly');
        if (!monthly || !yearly) {
          setLoadState({ status: 'error' });
          return;
        }
        setLoadState({ status: 'loaded', monthly, yearly });
      })
      .catch(() => {
        if (active) {
          setLoadState({ status: 'error' });
        }
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const handleReload = useCallback(() => {
    setLoadState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  const goToNextScreen = useCallback(() => {
    router.replace(NEXT_ROUTE_AFTER_PURCHASE);
  }, [router]);

  /** 購入・復元に成功した取引を確認し、active なら finishTransaction して次の画面へ進む(4-2c) */
  const confirmAndFinish = useCallback(
    async (result: BillingPurchaseResult): Promise<boolean> => {
      const outcome = await verifyApplePurchase(result.transactionId);
      if (outcome.status === 'active') {
        await finishPurchaseTransaction(result);
        goToNextScreen();
        return true;
      }
      setActionError(describeVerifyFailure(outcome));
      return false;
    },
    [goToNextScreen],
  );

  const handlePurchase = useCallback(async () => {
    if (loadState.status !== 'loaded' || selectedPlan === null) {
      return;
    }
    // 本来この画面はログイン後にしか来ない(3-5b)。ログインしていない場合は購入を始めない
    const uid = getCurrentUid();
    if (!uid) {
      setActionError(PURCHASE_FAILED_MESSAGE);
      return;
    }
    const product = loadState[selectedPlan];
    setProcessing(true);
    setActionError(null);
    try {
      const appAccountToken = deriveAppAccountToken(uid);
      const result = await purchaseBillingProduct(product.productId, appAccountToken);
      await confirmAndFinish(result);
    } catch (error) {
      if (!(error instanceof BillingCancelledError)) {
        setActionError(error instanceof Error ? error.message : PURCHASE_FAILED_MESSAGE);
      }
    } finally {
      setProcessing(false);
    }
  }, [loadState, selectedPlan, confirmAndFinish]);

  const handleRestore = useCallback(async () => {
    setProcessing(true);
    setActionError(null);
    try {
      const results = await restoreBillingPurchases();
      const [first] = results;
      if (first) {
        await confirmAndFinish(first);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '復元できる購入が見つかりませんでした');
    } finally {
      setProcessing(false);
    }
  }, [confirmAndFinish]);

  if (loadState.status === 'loading') {
    return (
      <View style={[styles.centerContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text testID="paywall-loading-text" style={styles.statusText}>
          読み込み中...
        </Text>
      </View>
    );
  }

  if (loadState.status === 'error') {
    return (
      <View style={[styles.centerContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <ErrorText testID="paywall-error-text" message="プランを読み込めませんでした" />
        <View style={styles.reloadButtonArea}>
          <PrimaryButton title="再読み込み" onPress={handleReload} testID="paywall-reload-button" />
        </View>
      </View>
    );
  }

  const discountPercent = calculateYearlyDiscountPercent(loadState.monthly.price, loadState.yearly.price);
  const allDisabled = processing;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.md }]}
      >
        <Text style={styles.heading}>合格ウォッチ プレミアム</Text>

        <View style={styles.featureList}>
          {FEATURE_LINES.map((line, index) => (
            <Text key={line} testID={`paywall-feature-${index}-text`} style={styles.featureLine}>
              ・{line}
            </Text>
          ))}
        </View>

        <PlanCard
          testID="paywall-monthly-card"
          label="月額"
          product={loadState.monthly}
          selected={selectedPlan === 'monthly'}
          disabled={allDisabled}
          onPress={() => setSelectedPlan('monthly')}
        />

        <PlanCard
          testID="paywall-yearly-card"
          label="年額"
          product={loadState.yearly}
          selected={selectedPlan === 'yearly'}
          disabled={allDisabled}
          onPress={() => setSelectedPlan('yearly')}
          highlighted
          discountPercent={discountPercent}
        />

        <View style={styles.purchaseButtonArea}>
          <PrimaryButton
            title="購入する"
            onPress={() => void handlePurchase()}
            disabled={allDisabled || selectedPlan === null}
            testID="paywall-purchase-button"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={allDisabled}
          onPress={() => void handleRestore()}
          testID="paywall-restore-button"
          style={styles.restoreButton}
        >
          <Text style={[styles.restoreText, allDisabled && styles.restoreTextDisabled]}>
            購入を復元する
          </Text>
        </Pressable>

        {processing ? (
          <Text testID="paywall-processing-text" style={styles.statusText}>
            処理中...
          </Text>
        ) : null}

        <ErrorText message={actionError} testID="paywall-action-error-text" />

        <Text testID="paywall-auto-renewal-text" style={styles.autoRenewalText}>
          お支払いは購入の確定時に Apple ID に請求されます。サブスクリプションは、現在の期間が終わる24時間以上前に自動更新をオフにしない限り自動で更新されます。解約は
          App Store のアカウント設定からいつでも行えます。
        </Text>

        <View style={styles.legalLinks}>
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)}
            testID="paywall-terms-link"
          >
            <Text style={styles.legalLinkText}>利用規約</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)}
            testID="paywall-privacy-link"
          >
            <Text style={styles.legalLinkText}>プライバシーポリシー</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

type PlanCardProps = {
  testID: string;
  label: string;
  product: BillingProduct;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  highlighted?: boolean;
  discountPercent?: number;
};

/** 月額/年額の選択カード(年額は highlighted で色付きの枠と「○%お得」を表示する) */
function PlanCard({
  testID,
  label,
  product,
  selected,
  disabled,
  onPress,
  highlighted = false,
  discountPercent,
}: PlanCardProps) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.planCard,
        highlighted ? styles.planCardHighlighted : null,
        selected ? styles.planCardSelected : null,
      ]}
    >
      {highlighted && typeof discountPercent === 'number' && discountPercent > 0 ? (
        <Text testID="paywall-yearly-discount-badge" style={styles.discountBadge}>
          {discountPercent}%お得
        </Text>
      ) : null}
      <Text style={styles.planLabel}>{label}</Text>
      <Text testID={`${testID}-price-text`} style={styles.planPrice}>
        {product.displayPrice}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  statusText: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  reloadButtonArea: {
    marginTop: spacing.md,
    width: '100%',
  },
  heading: {
    fontSize: typography.heading.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
  featureList: {
    marginTop: spacing.md,
  },
  featureLine: {
    fontSize: typography.body.fontSize,
    color: colors.text,
    marginTop: spacing.xs,
  },
  planCard: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.background,
  },
  planCardHighlighted: {
    borderColor: colors.primary,
  },
  planCardSelected: {
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  discountBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    color: colors.onPrimary,
    fontSize: typography.caption.fontSize,
    fontWeight: 'bold',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginBottom: spacing.xs,
  },
  planLabel: {
    fontSize: typography.label.fontSize,
    color: colors.textSecondary,
  },
  planPrice: {
    marginTop: spacing.xs,
    fontSize: typography.heading.fontSize,
    fontWeight: 'bold',
    color: colors.text,
  },
  purchaseButtonArea: {
    marginTop: spacing.lg,
  },
  restoreButton: {
    marginTop: spacing.md,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  restoreText: {
    fontSize: typography.label.fontSize + 1,
    color: colors.primary,
  },
  restoreTextDisabled: {
    color: colors.textSecondary,
  },
  autoRenewalText: {
    marginTop: spacing.lg,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  legalLinks: {
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  legalLinkText: {
    fontSize: typography.caption.fontSize,
    color: colors.primary,
  },
});
