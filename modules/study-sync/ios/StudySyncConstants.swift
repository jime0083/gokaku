import Foundation

/// Phase 1-4 技術検証用の定数(メインアプリ側/study-sync Expo Module)。
/// targets/widget/StudySyncConstants.swift と同じ内容を複製している
/// (Expo Module は別コンパイル単位の CocoaPod のため。重複は既知の制約。
///  Phase 5-3 で本実装に移す際は一本化を検討する)
enum StudySyncConstants {
    static let appGroupIdentifier = "group.com.jime0083.gokakuwatch"

    static let keychainService = "com.jime0083.gokakuwatch.studysync"
    static let keychainAccountDeviceToken = "deviceToken"
    static let keychainAccountUid = "uid"

    static let emulatorNativeSyncURL = URL(
        string: "http://127.0.0.1:5001/demo-gokaku/asia-northeast1/nativeSync"
    )!

    static let pendingQueueKey = "studySync.pendingEvents.v1"

    static let notificationCategoryStudyCheck = "STUDY_CHECK"
    static let notificationActionConfirm = "STUDY_CONFIRM"
}
