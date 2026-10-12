import ActivityKit
import ExpoModulesCore
import UserNotifications

/// JS(アプリ内タイマー画面。src/features/timer)から、ライブアクティビティ・ロック画面コントロール・
/// 計測中の状態(App Group)・デバイストークン(Keychain)を扱う native 処理を呼び出すブリッジ。
/// 1-4 の技術検証用スキャフォルドから、5-3 で requirements 3-2 の正式な形に合わせてきている
/// (startMeasurement/stopMeasurement の sessionId・checkEnabled は 5-3c-4 で揃えた)
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

        // 5-3c-4: sessionId はアプリ(JS)側で作って渡す(5-1b-2 の id.ts で作る sessionId と、
        // 端末内保存(LocalStudySession)・Callable への記録(recordStudyEvent)に使う sessionId を
        // 1つに揃えるため。checkEnabled も、start のときに nativeSync へ送る値として受け取る
        AsyncFunction("startMeasurement") { (uid: String, goalId: String, sessionId: String, checkEnabled: Bool) -> Bool in
            let startedAt = Date()
            let event = StudySyncEvent(
                uid: uid,
                sessionId: sessionId,
                goalId: goalId,
                action: .start,
                clientTimeMs: startedAt.timeIntervalSince1970 * 1000,
                idempotencyKey: UUID().uuidString,
                checkEnabled: checkEnabled
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

        AsyncFunction("stopMeasurement") { (uid: String, goalId: String, sessionId: String) -> Bool in
            let event = StudySyncEvent(
                uid: uid,
                sessionId: sessionId,
                goalId: goalId,
                action: .stop,
                clientTimeMs: Date().timeIntervalSince1970 * 1000,
                idempotencyKey: UUID().uuidString,
                checkEnabled: nil
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
