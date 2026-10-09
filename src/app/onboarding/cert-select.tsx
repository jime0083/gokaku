import { CERTIFICATIONS, formatWithThousandsSeparator, type CertificationEstimate } from '@shared/index';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/Card';
import { StepScreen } from '@/components/StepScreen';
import { TextField } from '@/components/TextField';
import { useOnboardingDraft } from '@/features/onboarding/OnboardingDraftContext';
import { resolveOnboardingBackRoute } from '@/features/onboarding/navigation';
import { resolveAutoFillClearPatch } from '@/features/onboarding/targetHoursAutoFill';
import { OTHER_CERTIFICATION_ID } from '@/features/onboarding/types';
import { FREE_TEXT_MAX_LENGTH, validateCertOtherName } from '@/features/onboarding/validation';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/** 一覧の行の目安の表示(mokuhyo.txt 2: 出典に範囲があれば「約下限〜上限時間」、1つの値なら「約○時間」) */
function formatCertRowEstimate(cert: CertificationEstimate): string {
  if (cert.lowerHours === null) {
    return `約${formatWithThousandsSeparator(cert.upperHours)}時間`;
  }
  return `約${formatWithThousandsSeparator(cert.lowerHours)}〜${formatWithThousandsSeparator(cert.upperHours)}時間`;
}

/**
 * 目安の上限が少ない順(requirements 4-3 2026-10-09 決定)。
 * Array.prototype.sort は安定ソート(ES2019+)のため、上限が同じ資格どうしの順序は
 * shared/certifications.ts の元の並び(出典の表の順)のまま変わらない
 */
const CERTIFICATIONS_BY_UPPER_HOURS: readonly CertificationEstimate[] = [...CERTIFICATIONS].sort(
  (a, b) => a.upperHours - b.upperHours,
);

type CertRowProps = {
  cert: CertificationEstimate;
  onPress: () => void;
};

function CertRow({ cert, onPress }: CertRowProps) {
  return (
    <Pressable accessibilityRole="button" testID={`cert-row-${cert.id}`} onPress={onPress}>
      <Card style={styles.row}>
        <Text style={styles.rowName}>{cert.name}</Text>
        <Text style={styles.rowEstimate}>{formatCertRowEstimate(cert)}</Text>
      </Card>
    </Pressable>
  );
}

/**
 * オンボーディング 2歩目(資格ルート): 目標資格の選択(requirements 4-3)。
 *
 * - 資格をタップするとすぐ概算画面(cert-estimate)へ進む(「次へ」ボタンなし。StepScreen の showNext=false)
 * - 「その他」をタップすると同じ画面内で資格名の入力欄に切り替わる(draft.certId で状態を持つため、
 *   アプリを閉じても入力欄のまま再開できる)。入力後「次へ」で目標時間・試験日の画面へ進む(概算はスキップ)
 * - 一覧は26件のみで FlatList の仮想化が要るほどの件数ではなく、FlatList を StepScreen の
 *   ScrollView に入れ子にすると RN の「ScrollView 内の VirtualizedList」警告とスクロール不具合が
 *   起きるため、StepScreen の ScrollView に直接並べる(iPhone SE でも最後の「その他」までスクロールで届く)
 */
export default function CertSelectScreen() {
  const router = useRouter();
  const { draft, updateDraft } = useOnboardingDraft();
  const [query, setQuery] = useState('');

  const isOtherMode = draft.certId === OTHER_CERTIFICATION_ID;

  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return CERTIFICATIONS_BY_UPPER_HOURS;
    return CERTIFICATIONS_BY_UPPER_HOURS.filter((cert) => cert.name.includes(trimmed));
  }, [query]);

  const handleSelectCert = (certId: string) => {
    updateDraft({ certId, certOtherName: '' });
    router.push('/onboarding/cert-estimate');
  };

  const handleSelectOther = () => {
    // 「その他」は概算がないため、前の資格の概算で自動で入っていた目標勉強時間は空欄に戻す
    // (ユーザー自身が書き換えていた場合は残す。requirements 4-2 の 5・4-3, 2026-10-09 決定)
    const clearPatch = resolveAutoFillClearPatch(draft);
    updateDraft({ certId: OTHER_CERTIFICATION_ID, ...(clearPatch ?? {}) });
  };

  const handleBackToList = () => {
    updateDraft({ certId: null, certOtherName: '' });
  };

  const otherNameError = validateCertOtherName(draft.certOtherName);
  const visibleOtherNameError = draft.certOtherName.length > 0 ? otherNameError : null;

  const handleNext = () => {
    if (otherNameError !== null) return;
    router.push('/onboarding/target');
  };

  if (isOtherMode) {
    return (
      <StepScreen
        title="資格名を入力してください"
        onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/cert-select', draft))}
        onNext={handleNext}
        nextDisabled={otherNameError !== null}
        backTestID="cert-select-back-button"
        nextTestID="cert-select-next-button"
      >
        <TextField
          label="資格名"
          value={draft.certOtherName}
          onChangeText={(text) => updateDraft({ certOtherName: text })}
          maxLength={FREE_TEXT_MAX_LENGTH}
          placeholder="例: ○○検定"
          error={visibleOtherNameError}
          testID="cert-other-name-input"
          errorTestID="cert-other-name-error"
        />
        <Pressable
          accessibilityRole="button"
          onPress={handleBackToList}
          testID="cert-other-back-to-list-button"
          style={styles.backToListButton}
        >
          <Text style={styles.backToListText}>一覧から選ぶ</Text>
        </Pressable>
      </StepScreen>
    );
  }

  return (
    <StepScreen
      title="目標資格を選んでください"
      onBack={() => router.replace(resolveOnboardingBackRoute('/onboarding/cert-select', draft))}
      showNext={false}
      backTestID="cert-select-back-button"
    >
      <TextField
        label="資格名で絞り込む"
        value={query}
        onChangeText={setQuery}
        placeholder="例: 簿記"
        testID="cert-search-input"
      />

      {filtered.length === 0 ? (
        <Text testID="cert-search-no-results" style={styles.noResultsText}>
          見つかりません。『その他』から入力してください
        </Text>
      ) : (
        <View style={styles.list}>
          {filtered.map((cert) => (
            <CertRow key={cert.id} cert={cert} onPress={() => handleSelectCert(cert.id)} />
          ))}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        testID="cert-row-other"
        onPress={handleSelectOther}
        style={styles.otherRow}
      >
        <Text style={styles.otherRowText}>その他(一覧にない資格)</Text>
      </Pressable>
    </StepScreen>
  );
}

const styles = StyleSheet.create({
  list: {
    marginTop: spacing.sm,
  },
  row: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowName: {
    fontSize: typography.body.fontSize,
    color: colors.text,
  },
  rowEstimate: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  noResultsText: {
    marginTop: spacing.lg,
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
  },
  otherRow: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  otherRowText: {
    fontSize: typography.body.fontSize,
    fontWeight: 'bold',
    color: colors.primary,
  },
  backToListButton: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
  },
  backToListText: {
    fontSize: typography.label.fontSize + 1,
    color: colors.primary,
  },
});
