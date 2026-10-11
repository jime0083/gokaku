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

        // 5-3c-3: 計測中の状態(sessionId・uid・goalId・startAt・checkEnabled・confirmations)を
        // App Group に 1 件だけ置く。アプリ・ロック画面のどちらからも読み書き・消去できる
        // (この時点ではタイマー画面・Intent からはまだ呼ばれない。5-3c-4・5-3c-5 でつなぐ)
        Function("getActiveSession") { () -> [String: Any]? in
            StudySyncSharedState.activeSession()?.asDictionary()
        }

        /// 形が不正な値(必須項目が無い・型が違う)は書き込みを断り false を返す(例外は投げない)
        Function("setActiveSession") { (session: [String: Any]) -> Bool in
            guard let parsed = StudySyncActiveSession(dictionary: session) else {
                return false
            }
            return StudySyncSharedState.setActiveSession(parsed)
        }

        Function("clearActiveSession") {
            StudySyncSharedState.clearActiveSession()
        }

        /// 確認 ON/OFF の設定(計測中の状態とは別に App Group に覚えておく値。初期値 true)
        Function("getCheckEnabledSetting") { () -> Bool in
            StudySyncSharedState.checkEnabledSetting()
        }

        Function("setCheckEnabledSetting") { (enabled: Bool) in
            StudySyncSharedState.setCheckEnabledSetting(enabled)
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
