import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// requirements.md 3-2: iOS 18 以上は、ロック画面コントロールから計測を開始できる。
/// `ControlWidget` 自体が iOS 18 以降の API のため型ごと @available で囲み、
/// iOS 17 の実行時にはこの型が存在しない(クラッシュしない)ようにする
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

/// ロック画面コントロールから計測を開始する App Intent(iOS 18+)。
/// uid・現在の goalId はログイン・目標設定済みのメインアプリが App Group に書き込んでおいた値を読む
@available(iOS 18.0, *)
struct StartStudyIntent: AppIntent {
    static var title: LocalizedStringResource = "勉強を開始"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        guard let auth = StudySyncKeychain.readDeviceToken() else {
            return .result()
        }
        let goalId = StudySyncSharedState.currentGoalId() ?? ""
        let startedAt = Date()

        let event = StudySyncEvent(
            uid: auth.uid,
            goalId: goalId,
            action: .start,
            source: .controlWidget,
            clientTimeMs: startedAt.timeIntervalSince1970 * 1000,
            idempotencyKey: UUID().uuidString
        )
        await StudySyncAPI.send(event)

        let attributes = StudyActivityAttributes(uid: auth.uid)
        let state = StudyActivityAttributes.ContentState(startedAt: startedAt, goalId: goalId)
        _ = try? Activity<StudyActivityAttributes>.request(
            attributes: attributes,
            content: ActivityContent(state: state, staleDate: nil)
        )
        return .result()
    }
}

/// App Group に保存する「現在の目標ID」等、ロック画面コントロール/通知から参照する最小の共有状態
enum StudySyncSharedState {
    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: StudySyncConstants.appGroupIdentifier)
    }

    static func currentGoalId() -> String? {
        defaults?.string(forKey: "studySync.currentGoalId")
    }
}
