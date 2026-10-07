import ActivityKit
import Foundation

/// targets/widget/StudyAttributes.swift と構造(プロパティ名・型)を一致させること。
/// ActivityKit は Codable 形式で OS 経由でシリアライズするため、別ターゲットでコンパイルされていても
/// 構造が一致していれば Activity の作成(このファイル側)・表示(widget 拡張側)が成立する
struct StudyActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var startedAt: Date
        var goalId: String
    }

    var uid: String
}
