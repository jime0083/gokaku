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

/// ロック画面・Dynamic Island の停止ボタン。
/// `LiveActivityIntent` に準拠させることで、アプリを開かずに WidgetKit 拡張プロセス内で実行される
struct StopStudyIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "勉強を停止"

    @Parameter(title: "uid")
    var uid: String

    @Parameter(title: "goalId")
    var goalId: String

    init() {
        self.uid = ""
        self.goalId = ""
    }

    init(uid: String, goalId: String) {
        self.uid = uid
        self.goalId = goalId
    }

    func perform() async throws -> some IntentResult {
        let event = StudySyncEvent(
            uid: uid,
            goalId: goalId,
            action: .stop,
            source: .liveActivity,
            clientTimeMs: Date().timeIntervalSince1970 * 1000,
            idempotencyKey: UUID().uuidString
        )
        await StudySyncAPI.send(event)

        for activity in Activity<StudyActivityAttributes>.activities
        where activity.attributes.uid == uid {
            await activity.end(
                ActivityContent(state: activity.content.state, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }
        return .result()
    }
}
