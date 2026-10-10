import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, View, type ColorValue } from 'react-native';

import { TimerSessionProvider, useTimerSessionContext } from '@/features/timer/TimerSessionContext';
import { colors } from '@/theme/colors';

/** タイマーのタブアイコン。計測中は小さな印を付ける(requirements 4-6) */
function TimerTabIcon({ color, size }: { color: ColorValue; size: number }) {
  const { isRunning } = useTimerSessionContext();
  return (
    <View style={styles.iconWrapper}>
      <Ionicons name="stopwatch-outline" size={size} color={color} />
      {isRunning ? <View testID="timer-tab-indicator" style={styles.indicator} /> : null}
    </View>
  );
}

/**
 * 下部タブ(ホーム / タイマー。requirements 4-6)。
 * 選んだタブはブルー(theme の primary)にする。ホームは6-1で本実装するまで仮の画面(src/app/(tabs)/home.tsx)
 */
export default function TabsLayout() {
  return (
    <TimerSessionProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            title: 'ホーム',
            tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="timer"
          options={{
            title: 'タイマー',
            tabBarIcon: ({ color, size }) => <TimerTabIcon color={color} size={size} />,
          }}
        />
      </Tabs>
    </TimerSessionProvider>
  );
}

const styles = StyleSheet.create({
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicator: {
    position: 'absolute',
    top: -2,
    right: -6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.progress,
  },
});
