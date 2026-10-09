import { FUNCTIONS_REGION } from '@shared/index';

/**
 * Firebase Emulator Suite の接続先(開発ビルド専用)。
 * 値は firebase.json の emulators 設定と一致させること。
 * Firebase SDK の導入と接続処理は別タスクで行う。本番ビルドでは使わない(`getFirebaseEmulatorConfig` が null を返す)。
 */
export type FirebaseEmulatorConfig = {
  readonly host: string;
  readonly authPort: number;
  readonly firestorePort: number;
  readonly functionsPort: number;
  /** Cloud Functions のデプロイ先リージョン(shared/functionsRegion.ts の FUNCTIONS_REGION と同じ値) */
  readonly functionsRegion: string;
};

/** iOS シミュレータからは Mac の localhost に到達できるため 127.0.0.1 を使う */
export const FIREBASE_EMULATOR_CONFIG: FirebaseEmulatorConfig = Object.freeze({
  host: '127.0.0.1',
  authPort: 9099,
  firestorePort: 8080,
  functionsPort: 5001,
  functionsRegion: FUNCTIONS_REGION,
});

/** 開発ビルド(__DEV__ が true)の場合のみ Emulator の接続先を返す。それ以外は null */
export function getFirebaseEmulatorConfig(
  isDev: boolean = __DEV__,
): FirebaseEmulatorConfig | null {
  return isDev ? FIREBASE_EMULATOR_CONFIG : null;
}
