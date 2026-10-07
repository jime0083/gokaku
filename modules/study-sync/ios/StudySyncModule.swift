import ActivityKit
import ExpoModulesCore
import UserNotifications

/// Phase 1-4 技術検証用の最小ブリッジ。JS(アプリ内タイマー画面の予定地。Phase 5 で本実装)から
/// ライブアクティビティ・ロック画面コントロールの土台となる native 処理を呼び出せるようにする。
/// このモジュール自体は 1-4 の検証用スキャフォルドであり、5-3 で正式な形に置き換える
public class StudySyncModule: Module {
    public func definition() -> ModuleDefinition {
        Name("StudySync")

        /// 検証用のデバイストークンを Keychain(App Group 共有)に保存する。
        /// 本来の発行方法(Firebase Auth との紐付け等)は 3-5・5-3 で確定する。
        /// Keychain への書き込みに失敗した場合は例外を投げる(JS 側に呼び出し元として伝える。problem P-012)
        Function("setAuthContext") { (uid: String, deviceToken: String) in
            try StudySyncKeychain.save(uid: uid, token: deviceToken)
        }

        Function("clearAuthContext") {
            try StudySyncKeychain.clear()
        }

        /// 直前の送信(startMeasurement/stopMeasurement/flushQueue)が失敗した理由。
        /// 成功している場合、または理由が記録されていない場合は nil
        Function("getLastSyncErrorReason") { () -> String? in
            StudySyncLastSyncError.get()
        }

        Function("setCurrentGoalId") { (goalId: String?) in
            StudySyncSharedState.setCurrentGoalId(goalId)
        }

        AsyncFunction("startMeasurement") { (uid: String, goalId: String) -> Bool in
            let startedAt = Date()
            let event = StudySyncEvent(
                uid: uid,
                goalId: goalId,
                action: .start,
                source: .app,
                clientTimeMs: startedAt.timeIntervalSince1970 * 1000,
                idempotencyKey: UUID().uuidString
            )
            let sent = await StudySyncAPI.send(event)

            let attributes = StudyActivityAttributes(uid: uid)
            let state = StudyActivityAttributes.ContentState(startedAt: startedAt, goalId: goalId)
            _ = try? Activity<StudyActivityAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil)
            )
            return sent
        }

        AsyncFunction("stopMeasurement") { (uid: String, goalId: String) -> Bool in
            let event = StudySyncEvent(
                uid: uid,
                goalId: goalId,
                action: .stop,
                source: .app,
                clientTimeMs: Date().timeIntervalSince1970 * 1000,
                idempotencyKey: UUID().uuidString
            )
            let sent = await StudySyncAPI.send(event)

            for activity in Activity<StudyActivityAttributes>.activities
            where activity.attributes.uid == uid {
                await activity.end(
                    ActivityContent(state: activity.content.state, staleDate: nil),
                    dismissalPolicy: .immediate
                )
            }
            return sent
        }

        /// 検証用: 指定秒後に「勉強中？」確認の通知を出す
        /// (本番は計測開始から60分ごと。requirements.md 3-2。時刻は Phase 5-2 で本実装)
        AsyncFunction("scheduleCheckNotification") { (afterSeconds: Double, goalId: String) in
            let content = UNMutableNotificationContent()
            content.title = "勉強中？"
            content.categoryIdentifier = StudySyncConstants.notificationCategoryStudyCheck
            content.userInfo = ["goalId": goalId]
            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(afterSeconds, 1),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "study-check-\(UUID().uuidString)",
                content: content,
                trigger: trigger
            )
            try? await UNUserNotificationCenter.current().add(request)
        }

        AsyncFunction("flushQueue") { () -> Int in
            await StudySyncAPI.flushQueue()
        }

        Function("getPendingQueueCount") { () -> Int in
            StudySyncQueue.count()
        }

        AsyncFunction("requestNotificationPermission") { () -> Bool in
            (try? await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound]
            )) ?? false
        }
    }
}
