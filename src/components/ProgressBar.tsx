import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme/colors';
import { radius } from '@/theme/radius';

type ProgressBarProps = {
  /** 0〜1 の進み具合。範囲外の値は 0〜1 に収める(呼び出し側で 100% 超をどう扱うかは決めている前提) */
  ratio: number;
  testID?: string;
};

/** グリーン系の進捗バー(requirements 4-6: 積み上げ・最低/努力目標などの進み具合。100% で満タン) */
export function ProgressBar({ ratio, testID }: ProgressBarProps) {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return (
    <View testID={testID} style={styles.track}>
      <View
        testID={testID ? `${testID}-fill` : undefined}
        style={[styles.fill, { width: `${clamped * 100}%` }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.progress,
  },
});
