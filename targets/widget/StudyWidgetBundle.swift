import SwiftUI
import WidgetKit

/// WidgetKit 拡張のエントリポイント。
/// ライブアクティビティ(iOS 17+)は常に登録し、ロック画面コントロール(iOS 18+)は
/// `if #available` で分岐する。iOS 17 実行時はこの分岐がスキップされ、ControlWidget は
/// 一切登録されない(クラッシュしない。requirements.md 3-2・progress.txt 1-4 完了条件)
@main
struct StudyWidgetBundle: WidgetBundle {
    var body: some Widget {
        StudyLiveActivityWidget()
        if #available(iOS 18.0, *) {
            StudyControlWidget()
        }
    }
}
