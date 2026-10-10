/**
 * 発行したデバイストークンを Keychain(App Group 共有)に保存する(5-3a-2。requirements 3-2)。
 * StudySync(modules/study-sync。ローカルの Expo Module)の setAuthContext を呼ぶだけの薄い層。
 *
 * modules/study-sync/src/StudySyncModule は import すると requireNativeModule が即座に実行され、
 * @react-native-firebase/* と違って呼び出し時まで遅延しない。このファイルを呼ぶ ensureDeviceToken.ts は
 * src/app/_layout.tsx(expo-router が常に読み込むファイル)から呼ばれるため、import した時点では
 * 走らないよう、実際に呼ぶこの関数の中でだけ require する
 * (テスト(renderRouter で _layout を描画する)でネイティブモジュール未登録のクラッシュを避けるため)
 */

type StudySyncAuthBridge = {
  setAuthContext(uid: string, deviceToken: string): void;
};

/**
 * 保存できたら true、Keychain への書き込みに失敗したら false を返す(StudySyncKeychain.save が
 * 例外を投げる。problem P-012)。呼び出し元(ensureDeviceToken)は false のとき AsyncStorage の
 * expiresAt を更新せず、次の機会に再試行する
 */
export function saveDeviceTokenToKeychain(uid: string, deviceToken: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StudySync = (require('../../../modules/study-sync/src/StudySyncModule') as { default: StudySyncAuthBridge })
      .default;
    StudySync.setAuthContext(uid, deviceToken);
    return true;
  } catch {
    return false;
  }
}
