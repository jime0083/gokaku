import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// requirements.md 3-2: 計測中は「勉強中」の文言・経過時間・停止ボタンをライブアクティビティで表示する(iOS 17+)
struct StudyLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: StudyActivityAttributes.self) { context in
            StudyLiveActivityView(context: context)
                .activityBackgroundTint(Color.white)
                .activitySystemActionForegroundColor(Color.black)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("勉強中")
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StopButton(uid: context.attributes.uid, goalId: context.state.goalId)
                }
            } compactLeading: {
                Text("勉強中")
            } compactTrailing: {
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .monospacedDigit()
            } minimal: {
                Text("勉強中")
            }
        }
    }
}

private struct StudyLiveActivityView: View {
    let context: ActivityViewContext<StudyActivityAttributes>

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("勉強中")
                    .font(.headline)
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .font(.title2)
                    .monospacedDigit()
            }
            Spacer()
            StopButton(uid: context.attributes.uid, goalId: context.state.goalId)
        }
        .padding()
    }
}

private struct StopButton: View {
    let uid: String
    let goalId: String

    var body: some View {
        Button(intent: StopStudyIntent(uid: uid, goalId: goalId)) {
            Text("停止")
        }
        .tint(.red)
    }
}

// `StopStudyIntent`(LiveActivityIntent)の定義は `targets/_shared/StudyLiveActivityIntent.swift` に
// 移した(problem P-011 (1)。5-3d で修正)。`LiveActivityIntent` に準拠する intent は、Apple のドキュメント
// (Adding interactivity to widgets and Live Activities)により「システムがアプリ本体のプロセスで実行し、
// アプリ本体のターゲットにも追加すること」と明記されており、ウィジェット拡張ターゲットだけに置くと
// `Activity<StudyActivityAttributes>.activities` が空になり `activity.end()` が実行されない
// (アプリ本体のプロセスで ActivityKit が管理している Activity が、別プロセスのウィジェット拡張からは
// 見えないため)。`_shared` に置くことで、アプリ本体・ウィジェット拡張の両方のターゲットに同じ型が
// コンパイルされ、上のボタンからはそのまま同じ型名で参照できる
