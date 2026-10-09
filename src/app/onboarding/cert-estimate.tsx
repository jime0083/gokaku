import {
  CERTIFICATION_SOURCES,
  formatWithThousandsSeparator,
  getCertificationEstimate,
  type CertificationEstimate,
  type CertificationSourceId,
} from '@shared/index';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Card } from '@/components/Card';
import { StepScreen } from '@/components/StepScreen';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { resolveAutoFillPatch } from '@/features/onboarding/targetHoursAutoFill';
import { OTHER_CERTIFICATION_ID } from '@/features/onboarding/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 出典の表示文(mokuhyo.txt 2。例: 「出典: フォーサイト「3ヶ月で取れるおすすめ資格10選」(2026-08-02 更新)」。リンクは付けない) */
function formatSourcesText(sourceIds: readonly CertificationSourceId[]): string {
  return sourceIds
    .map((id) => {
      const source = CERTIFICATION_SOURCES[id];
      return `${source.name}(${source.updatedAt} 更新)`;
    })
    .join('、');
}

/** 概算の表示(mokuhyo.txt 2: 出典に範囲があれば「約下限〜上限時間」、1つの値なら「約○時間」) */
function formatCertEstimateText(cert: CertificationEstimate): string {
  if (cert.lowerHours === null) {
    return `約${formatWithThousandsSeparator(cert.upperHours)}時間`;
  }
  return `約${formatWithThousandsSeparator(cert.lowerHours)}〜${formatWithThousandsSeparator(cert.upperHours)}時間`;
}

/**
 * オンボーディング 3歩目(資格ルート): 必要勉強時間の概算(requirements 4-3, mokuhyo.txt 2)。
 * 「その他」はこの画面を飛ばすため扱わない(cert-select.tsx から直接 /onboarding/target へ進む)。
 * 目標勉強時間の初期値(概算の上限)を設定する。戻って資格を選び直した場合も、ユーザーが
 * 書き換えていなければ新しい上限に置き換える(requirements 4-2 の 5・4-3, 2026-10-09 決定)
 */
export default function CertEstimateScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();

  const cert =
    draft.certId !== null && draft.certId !== OTHER_CERTIFICATION_ID
      ? getCertificationEstimate(draft.certId)
      : null;

  useEffect(() => {
    if (cert === null) return;
    const patch = resolveAutoFillPatch(draft, cert.upperHours);
    if (patch !== null) {
      updateDraft(patch);
    }
  }, [draft, cert, updateDraft]);

  const handleNext = () => {
    router.push('/onboarding/target');
  };

  return (
    <StepScreen
      title="必要勉強時間の概算"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/cert-estimate', draft))}
      onNext={handleNext}
      backTestID="cert-estimate-back-button"
      nextTestID="cert-estimate-next-button"
    >
      <Card style={styles.card}>
        <Text testID="cert-estimate-name-text" style={styles.nameText}>
          {cert?.name ?? ''}
        </Text>
        {cert !== null ? (
          <>
            <Text testID="cert-estimate-amount-text" style={styles.resultText}>
              {formatCertEstimateText(cert)}
            </Text>
            <Text testID="cert-estimate-disclaimer-text" style={styles.disclaimer}>
              あくまで目安です
            </Text>
            <Text testID="cert-estimate-source-text" style={styles.source}>
              出典: {formatSourcesText(cert.sourceIds)}
            </Text>
          </>
        ) : null}
      </Card>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.lg,
  },
  nameText: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
  },
  resultText: {
    marginTop: spacing.sm,
    fontSize: typography.heading.fontSize + 2,
    fontWeight: 'bold',
    color: colors.primary,
  },
  disclaimer: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  source: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
});
