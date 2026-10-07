import ActivityKit
import Foundation

/// ライブアクティビティ(requirements.md 3-2)の属性。
/// ActivityKit は Codable の形で OS 経由でシリアライズするため、メインアプリ側
/// (modules/study-sync/ios/StudyAttributes.swift)に構造(プロパティ名・型)が一致する
/// 同名の型を用意しておけば、別ターゲットでコンパイルされていても Activity の作成・表示が成立する
struct StudyActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 計測開始時刻(端末時刻)。経過時間表示は Text(timeInterval:) でこの値から計算する
        var startedAt: Date
        var goalId: String
    }

    var uid: String
}
