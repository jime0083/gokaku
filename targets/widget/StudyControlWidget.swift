import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// requirements.md 3-2: iOS 18 以上は、ロック画面コントロールから計測を開始できる。
/// `ControlWidget` 自体が iOS 18 以降の API のため型ごと @available で囲み、
/// iOS 17 の実行時にはこの型が存在しない(クラッシュしない)ようにする
///
/// `StartStudyIntent`(開始の App Intent)の定義は `targets/_shared/StudyLiveActivityIntent.swift` に
/// 移した(problem P-038。5-3d-2 で修正)。`LiveActivityIntent` に準拠する intent はアプリ本体の
/// プロセスで実行される仕様のため、アプリ本体ターゲットにも型が必要(`StopStudyIntent` と同じ理由。
/// 詳しい出典は移動先のファイルのコメントを参照)。`ControlWidgetButton` の action には
/// `AppIntent` に準拠する型を渡せればよく、`LiveActivityIntent` もこれを満たすため、
/// このファイルからは同じ型名としてそのまま参照できる
@available(iOS 18.0, *)
struct StudyControlWidget: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.jime0083.gokakuwatch.StudyControl"
        ) {
            ControlWidgetButton(action: StartStudyIntent()) {
                Label("勉強を開始", systemImage: "play.fill")
            }
        }
        .displayName("勉強ウォッチ")
        .description("ロック画面から計測を開始します")
    }
}
