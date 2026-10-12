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
/// uid・現在の goalId はログイン・目標設定済みのメインアプリが App Group に書き込んでおいた値を読む。
///
/// 5-3c-4(requirements 3-2「アプリとロック画面の計測の共有」): 計測中の状態(5-3c-3。App Group に
/// 1 件だけ置く)を正として扱う。すでに計測中であれば何もしない(アプリで始めた計測をロック画面から
/// 二重に start しない)。uid・デバイストークン・goalId のどれかが分からない場合も何もしない
/// (ログイン・目標設定が済んでいない端末からの操作を無視する)
@available(iOS 18.0, *)
struct StartStudyIntent: AppIntent {
    static var title: LocalizedStringResource = "勉強を開始"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        guard StudySyncSharedState.activeSession() == nil else {
            return .result()
        }
        guard let auth = StudySyncKeychain.readDeviceToken() else {
            return .result()
        }
        guard let goalId = StudySyncSharedState.currentGoalId(), !goalId.isEmpty else {
            return .result()
        }

        let sessionId = UUID().uuidString
        let startedAt = Date()
        let checkEnabled = StudySyncSharedState.checkEnabledSetting()

        // ネットワークの成否に関わらず、計測中の状態はまず App Group に書く
        // (アプリ側の表示・ロック画面の停止操作は、この状態を正として動く。5-3c-3)
        StudySyncSharedState.setActiveSession(
            StudySyncActiveSession(
                sessionId: sessionId,
                uid: auth.uid,
                goalId: goalId,
                startAt: startedAt.timeIntervalSince1970 * 1000,
                checkEnabled: checkEnabled,
                confirmations: []
            )
        )

        let event = StudySyncEvent(
            uid: auth.uid,
            sessionId: sessionId,
            goalId: goalId,
            action: .start,
            clientTimeMs: startedAt.timeIntervalSince1970 * 1000,
            idempotencyKey: UUID().uuidString,
            checkEnabled: checkEnabled
        )
        // 送れなければ StudySyncAPI.send が App Group のキューに積む(5-3c-6 で送り直し方を整理する)
        await StudySyncAPI.send(event)

        let attributes = StudyActivityAttributes(uid: auth.uid)
        let state = StudyActivityAttributes.ContentState(startedAt: startedAt, goalId: goalId)
        _ = try? Activity<StudyActivityAttributes>.request(
            attributes: attributes,
            content: ActivityContent(state: state, staleDate: nil)
        )

        if checkEnabled {
            await StudySyncCheckNotification.scheduleFirstCheck()
        }

        return .result()
    }
}
