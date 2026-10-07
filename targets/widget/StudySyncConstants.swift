import Foundation

/// Phase 1-4 技術検証用の定数。
/// 本番の接続先は存在しない(この検証では Firebase Emulator 専用)。
/// 値は modules/study-sync/ios/StudySyncConstants.swift 側にも同じ内容を複製している
/// (WidgetKit 拡張とメインアプリ側の Expo Module は別コンパイル単位のため。重複は既知の制約。
///  Phase 5-3 で本実装に移す際は Swift Package 化などで一本化を検討する)
enum StudySyncConstants {
    /// App Group ID (requirements.md 7)
    static let appGroupIdentifier = "group.com.jime0083.gokakuwatch"

    /// Keychain 共有グループに保存するデバイストークンのアカウント名
    static let keychainService = "com.jime0083.gokakuwatch.studysync"
    static let keychainAccountDeviceToken = "deviceToken"
    static let keychainAccountUid = "uid"

    /// Firebase Emulator(demo-gokaku, asia-northeast1)の nativeSync 関数エンドポイント。
    /// シミュレータは Mac 本体と同じネットワーク名前空間を使うため 127.0.0.1 で Emulator に届く
    static let emulatorNativeSyncURL = URL(
        string: "http://127.0.0.1:5001/demo-gokaku/asia-northeast1/nativeSync"
    )!

    /// App Group の UserDefaults に溜める「送信できなかった操作」のキュー用キー
    static let pendingQueueKey = "studySync.pendingEvents.v1"
}
