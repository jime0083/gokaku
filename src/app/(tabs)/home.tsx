import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';

/** ホーム画面の仮実装(6-1 で requirements 4-6 のとおり本実装する) */
export default function HomeScreen() {
  return (
    <View style={styles.root}>
      <Text testID="home-placeholder-text" style={styles.text}>
        ホーム(準備中)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  text: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
  },
});
