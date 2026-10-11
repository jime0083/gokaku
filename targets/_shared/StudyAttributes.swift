import ActivityKit
import Foundation

/// ライブアクティビティ(requirements.md 3-2)の属性。
/// `targets/_shared/` に置くことで、メインアプリターゲット・StudyWidget 拡張ターゲット・
/// modules/study-sync の CocoaPod(podspec で同じファイルを source_files に指定)のどこからでも
/// 同じ型を使う。ActivityKit は Codable の形で OS 経由でシリアライズするため、実行前に
/// コンパイルされたモジュールが違っていても、構造(プロパティ名・型)が一致していれば
/// Activity の作成・表示が成立する(別モジュールで同名の型として扱われるだけで問題ない)
struct StudyActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 計測開始時刻(端末時刻)。経過時間表示は Text(timeInterval:) でこの値から計算する
        var startedAt: Date
        var goalId: String
    }

    var uid: String
}
