// Jest 全体のセットアップ。
// AsyncStorage はネイティブモジュールのため、公式のモック実装に差し替える
// (参考: https://react-native-async-storage.github.io/async-storage/docs/advanced/jest)
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// @react-native-picker/picker・@react-native-community/datetimepicker はネイティブのホストコンポーネントを
// 提供するため、Jest(react-test-renderer)環境ではそのままレンダリングできない。
// onValueChange / onChange をテストから直接呼べる最小構成のモックに差し替える
// (参考: 画面テストでは fireEvent(getByTestId(id), 'valueChange', value) のように呼ぶ)
jest.mock('@react-native-picker/picker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const Picker = ({ testID, selectedValue, onValueChange, children }: never) =>
    React.createElement(View, { testID, selectedValue, onValueChange }, children);
  function PickerItem() {
    return null;
  }
  Picker.Item = PickerItem;

  return { Picker };
});

// react-native-safe-area-context はネイティブの insets 計測が必要なため、公式のモック実装に差し替える
// (参考: https://github.com/th3rdwave/react-native-safe-area-context#jest)
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('@react-native-community/datetimepicker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: ({ testID, value, onChange }: never) =>
      React.createElement(View, { testID, value, onChange }),
  };
});

// @react-native-firebase/* はネイティブモジュール(NativeRNFBTurboApp 等)を直接 require するため、
// Jest(ネイティブモジュール未登録)環境では import しただけで例外になる(3-5a で確認)。
// このアプリでは Emulator 接続・サインイン・Firestore 読み書きは検証用画面でのみ使うため、
// 呼び出されないことを前提にした最小のモックに差し替える
jest.mock('@react-native-firebase/app', () => ({
  getApp: jest.fn(() => ({})),
}));
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: jest.fn(() => ({ currentUser: null })),
  connectAuthEmulator: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
}));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
}));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: jest.fn(() => ({})),
  connectFunctionsEmulator: jest.fn(),
  httpsCallable: jest.fn(),
}));

// expo-notifications はネイティブの通知センターを使うため、Jest 環境では明示的にモックする(5-2c)。
// 既定値は「許可あり・予約なし」にし、通知の許可・通知レイヤーに関わらないテスト(既存のタイマー画面テスト等)に
// 影響しないようにする。個別のテストは `import * as Notifications from 'expo-notifications'` した上で
// 各 jest.fn() の戻り値を上書きする
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn().mockResolvedValue(undefined),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', granted: true }),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', granted: true }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('mock-notification-id'),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getAllScheduledNotificationsAsync: jest.fn().mockResolvedValue([]),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  SchedulableTriggerInputTypes: { DATE: 'date', TIME_INTERVAL: 'timeInterval' },
}));

// Subscription management uses native StoreKit UI; unit/router tests never open it.
jest.mock('expo-iap', () => ({ showManageSubscriptionsIOS: jest.fn().mockResolvedValue([]) }));
