import ActivityKit
import ExpoModulesCore
import UserNotifications

/// JS(アプリ内タイマー画面。src/features/timer)から、ライブアクティビティ・ロック画面コントロール・
/// 計測中の状態(App Group)・デバイストークン(Keychain)を扱う native 処理を呼び出すブリッジ。
/// 1-4 の技術検証用スキャフォルドから、5-3 で requirements 3-2 の正式な形に合わせてきている
/// (startMeasurement/stopMeasurement の sessionId・checkEnabled は 5-3c-4 で揃えた。
/// nativeSync に送らず計測中の状態(App Group)だけを扱う形には 5-3c-5a で直した)
public class StudySyncModule: Module {
    public func definition() -> ModuleDefinition {
        Name("StudySync")

        /// 検証用のデバイストークンを Keychain(App Group 共有)に保存する。
        /// 本来の発行方法(Firebase Auth との紐付け等)は 3-5・5-3 で確定する。
        /// Keychain への書き込みに失敗した場合は例外を投げる(JS 側に呼び出し元として伝える。problem P-012)
        ///
        /// 5-3c-6: 保存できたら、この uid の「トークンを待つ」印が付いたキューの項目
        /// (以前の 401 で溜めていた操作)を送り直す(requirements 3-2)。待たずに返す(fire-and-forget。
        /// 失敗してもキューに残り続けるだけで、次の機会にまた試みられる)
        Function("setAuthContext") { (uid: String, deviceToken: String) in
            try StudySyncKeychain.save(uid: uid, token: deviceToken)
            Task {
                _ = await StudySyncAPI.flushWaitingForToken(forUid: uid)
            }
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

        // 5-3c-5a: アプリから呼ぶ startMeasurement は nativeSync に送らない(サーバーへの記録は
        // recordStudyEvent(source=app)。アプリと二重に送って sessions.source が届く順番で
        // app/lockscreen のどちらになるか決まってしまう不具合(5-3c-5 の調査)を解消するため。
        // ここでは計測中の状態(App Group。5-3c-3)を書き、ライブアクティビティを出すだけ。
        // 通知の予約は JS(5-3c-5b)が行う。
        // sessionId・startAt は呼び出し側(JS)が作って渡す。startAt を Swift で Date() にせず
        // JS から受け取るのは、JS の端末内の記録(LocalStudySession.startAt)とこの App Group の
        // 計測中の状態の startAt を完全に一致させるため(ずれると、アプリを開き直したときに
        // 経過時間の表示が合わなくなる)。
        // 戻り値: 計測中の状態の書き込みに成功したか(setActiveSession と同じ意味。渡された値の形が
        // 不正な場合だけ false になる。ライブアクティビティの表示が OS 側の制約で失敗しても
        // (Live Activities が無効など)戻り値には反映しない=false にしない)
        AsyncFunction("startMeasurement") { (uid: String, goalId: String, sessionId: String, startAt: Double, checkEnabled: Bool) -> Bool in
            guard let session = StudySyncActiveSession(
                dictionary: [
                    "sessionId": sessionId,
                    "uid": uid,
                    "goalId": goalId,
                    "startAt": startAt,
                    "checkEnabled": checkEnabled,
                    "confirmations": [Double](),
                ]
            ) else {
                return false
            }
            let written = StudySyncSharedState.setActiveSession(session)

            let attributes = StudyActivityAttributes(uid: uid)
            let state = StudyActivityAttributes.ContentState(
                startedAt: Date(timeIntervalSince1970: startAt / 1000),
                goalId: goalId
            )
            _ = try? Activity<StudyActivityAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil)
            )
            return written
        }

        // 5-3c-5a: アプリから呼ぶ stopMeasurement も nativeSync に送らない(理由は startMeasurement と同じ)。
        // 通知の取り消しは JS(5-3c-5b)が行う。
        // 戻り値: 消す前に計測中の状態が実際にあったか(true=あった・消した、false=すでに無かった。
        // 例えばロック画面の停止が先に届いていた場合)
        AsyncFunction("stopMeasurement") { (uid: String, goalId: String, sessionId: String) -> Bool in
            let hadActiveSession = StudySyncSharedState.activeSession() != nil
            StudySyncSharedState.clearActiveSession()

            for activity in Activity<StudyActivityAttributes>.activities
            where activity.attributes.uid == uid {
                await activity.end(
                    ActivityContent(state: activity.content.state, staleDate: nil),
                    dismissalPolicy: .immediate
                )
            }
            return hadActiveSession
        }

        /// ロック画面(StopStudyIntent)で止めた最後の計測(sessionId・stopAt)。無ければ nil(5-3c-5a)
        Function("getLastLockscreenStop") { () -> [String: Any]? in
            StudySyncSharedState.lastLockscreenStop()?.asDictionary()
        }

        Function("clearLastLockscreenStop") {
            StudySyncSharedState.clearLastLockscreenStop()
        }

        AsyncFunction("flushQueue") { () -> Int in
            await StudySyncAPI.flushQueue()
        }

        Function("getPendingQueueCount") { () -> Int in
            StudySyncQueue.count()
        }

        /// キューに溜まっている項目のうち、「トークンを待つ」印が付いている件数(5-3c-6。確認画面での
        /// 証跡用。キューを空にせずに数えるだけ)
        Function("getPendingQueueWaitingForTokenCount") { () -> Int in
            StudySyncQueue.waitingForTokenCount()
        }

        /// 確認用(5-3c-6): nativeSync への1回の送信(StudySyncAPI.send)を直接試す。
        /// ロック画面コントロール・通知アクションからの送信(StartStudyIntent/StopStudyIntent)は
        /// システムの操作でしか起動できず自動化できないため、この関数で同じ送信処理
        /// (応答に応じて送り直す・捨てる・トークンを待つの振り分け)を確認画面(dev-lockscreen-spike)
        /// から直接試せるようにする。戻り値は送れたか(true=200)
        AsyncFunction("debugSendStudySyncEvent") {
            (
                uid: String,
                sessionId: String,
                goalId: String,
                action: String,
                clientTimeMs: Double,
                idempotencyKey: String,
                checkEnabled: Bool?
            ) -> Bool in
            guard let studySyncAction = StudySyncAction(rawValue: action) else {
                return false
            }
            let event = StudySyncEvent(
                uid: uid,
                sessionId: sessionId,
                goalId: goalId,
                action: studySyncAction,
                clientTimeMs: clientTimeMs,
                idempotencyKey: idempotencyKey,
                checkEnabled: checkEnabled
            )
            return await StudySyncAPI.send(event)
        }

        AsyncFunction("requestNotificationPermission") { () -> Bool in
            (try? await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound]
            )) ?? false
        }
    }
}
