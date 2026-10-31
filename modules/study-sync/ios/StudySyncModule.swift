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

        /// statusはlease不要snapshot。操作の認可には使わない。
        Function("isAccountOperationBlocked") { () -> Bool in
            // 不明な永続状態では通常操作を許可しない。
            (try? StudySyncAccountGate().isPersistentlyBlocked()) ?? true
        }

        /// 詳細取得はlease内fresh read。busy/破損をnullとして隠さない。
        Function("getAccountOperationBlock") { () -> [String: Any]? in
            guard let block = try StudySyncAccountGate().readFreshBlock() else { return nil }
            return [
                "version": block.version,
                "uid": block.uid,
                "action": block.action.rawValue,
                "operationId": block.operationId.uuidString,
            ]
        }

        Function("beginAccountOperation") { (uid: String, action: String) -> [String: Any] in
            guard let action = StudySyncAccountGate.Action(rawValue: action) else {
                throw StudySyncAccountGate.GateError.invalidIdentity
            }
            let block = try StudySyncAccountOperations().begin(uid: uid, action: action)
            return ["version": block.version, "uid": block.uid,
                "action": block.action.rawValue, "operationId": block.operationId.uuidString]
        }

        AsyncFunction("inspectAccountOperation") {
            (uid: String, action: String, operationId: String) -> [String: Any] in
            guard let action = StudySyncAccountGate.Action(rawValue: action),
                let id = UUID(uuidString: operationId)
            else { throw StudySyncAccountGate.GateError.invalidIdentity }
            return try await StudySyncAccountOperations().inspect(
                uid: uid, action: action, operationId: id
            ).asDictionary()
        }

        AsyncFunction("drainAccountOperation") {
            (uid: String, action: String, operationId: String) -> Int in
            guard let action = StudySyncAccountGate.Action(rawValue: action),
                let id = UUID(uuidString: operationId)
            else { throw StudySyncAccountGate.GateError.invalidIdentity }
            return try await StudySyncAccountOperations().drain(uid: uid, action: action, operationId: id)
        }

        AsyncFunction("cleanupAccountOperation") {
            (uid: String, action: String, operationId: String) -> Void in
            guard let action = StudySyncAccountGate.Action(rawValue: action),
                let id = UUID(uuidString: operationId)
            else { throw StudySyncAccountGate.GateError.invalidIdentity }
            try await StudySyncAccountOperations().cleanup(uid: uid, action: action, operationId: id)
        }

        AsyncFunction("finishAccountOperation") {
            (uid: String, action: String, operationId: String) -> Void in
            guard let action = StudySyncAccountGate.Action(rawValue: action),
                let id = UUID(uuidString: operationId)
            else { throw StudySyncAccountGate.GateError.invalidIdentity }
            try await StudySyncAccountOperations().finish(uid: uid, action: action, operationId: id)
        }

        /// cloud開始前・JS checkpoint無しを保証したcallerだけが呼ぶ。
        Function("cancelAccountOperation") {
            (uid: String, action: String, operationId: String) -> Void in
            guard let action = StudySyncAccountGate.Action(rawValue: action),
                let id = UUID(uuidString: operationId)
            else { throw StudySyncAccountGate.GateError.invalidIdentity }
            try StudySyncAccountOperations().cancel(uid: uid, action: action, operationId: id)
        }

        /// 検証用のデバイストークンを Keychain(App Group 共有)に保存する。
        /// 本来の発行方法(Firebase Auth との紐付け等)は 3-5・5-3 で確定する。
        /// Keychain への書き込みに失敗した場合は例外を投げる(JS 側に呼び出し元として伝える。problem P-012)
        ///
        /// 5-3c-6: 保存できたら、この uid の「トークンを待つ」印が付いたキューの項目
        /// (以前の 401 で溜めていた操作)を送り直す(requirements 3-2)。待たずに返す(fire-and-forget。
        /// 失敗してもキューに残り続けるだけで、次の機会にまた試みられる)
        Function("setAuthContext") { (uid: String, deviceToken: String) in
            try StudySyncAccountGate().withNormalOperation {
                try StudySyncKeychain.save(uid: uid, token: deviceToken)
            }
            Task {
                _ = await StudySyncAPI.flushWaitingForToken(forUid: uid)
            }
        }

        Function("clearAuthContext") {
            try StudySyncAccountGate().withNormalOperation {
                try StudySyncKeychain.clear()
            }
        }

        /// 直前の送信(startMeasurement/stopMeasurement/flushQueue)が失敗した理由。
        /// 成功している場合、または理由が記録されていない場合は nil
        Function("getLastSyncErrorReason") { () -> String? in
            StudySyncLastSyncError.get()
        }

        Function("setCurrentGoalId") { (goalId: String?) in
            try StudySyncAccountGate().withNormalOperation {
                try StudySyncAccountData.invalidateOwnerReceipt(field: .currentGoalId)
                StudySyncSharedState.setCurrentGoalId(goalId)
            }
        }

        /// 新値の書き込みだけを明示UIDに帰属させる。既存値の追認には使わない。
        Function("setCurrentGoalIdForAccount") { (uid: String, goalId: String) in
            try StudySyncAccountGate().withNormalOperation {
                guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw StudySyncAccountGate.GateError.invalidIdentity
                }
                try StudySyncAccountData.invalidateOwnerReceipt(field: .currentGoalId)
                StudySyncSharedState.setCurrentGoalId(goalId)
                try StudySyncAccountData.recordOwnerReceipt(
                    field: .currentGoalId, uid: uid, value: goalId
                )
            }
        }

        Function("setCheckEnabledSettingForAccount") { (uid: String, enabled: Bool) in
            try StudySyncAccountGate().withNormalOperation {
                guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw StudySyncAccountGate.GateError.invalidIdentity
                }
                try StudySyncAccountData.invalidateOwnerReceipt(field: .checkEnabledSetting)
                StudySyncSharedState.setCheckEnabledSetting(enabled)
                try StudySyncAccountData.recordOwnerReceipt(
                    field: .checkEnabledSetting, uid: uid, value: enabled
                )
            }
        }

        // 5-3c-3: 計測中の状態(sessionId・uid・goalId・startAt・checkEnabled・confirmations)を
        // App Group に 1 件だけ置く。アプリ・ロック画面のどちらからも読み書き・消去できる
        // (この時点ではタイマー画面・Intent からはまだ呼ばれない。5-3c-4・5-3c-5 でつなぐ)
        Function("getActiveSession") { () -> [String: Any]? in
            StudySyncSharedState.activeSession()?.asDictionary()
        }

        /// 不正な値・gate取得失敗は書き込みを断りfalseを返す。
        Function("setActiveSession") { (session: [String: Any]) -> Bool in
            do {
                return try StudySyncAccountGate().withNormalOperation {
                    guard let parsed = StudySyncActiveSession(dictionary: session) else {
                        return false
                    }
                    return StudySyncSharedState.setActiveSession(parsed)
                }
            } catch {
                StudySyncLastSyncError.set("native操作を実行できませんでした。再試行してください")
                return false
            }
        }

        Function("clearActiveSession") {
            try StudySyncAccountGate().withNormalOperation {
                StudySyncSharedState.clearActiveSession()
            }
        }

        /// 確認 ON/OFF の設定(計測中の状態とは別に App Group に覚えておく値。初期値 true)
        Function("getCheckEnabledSetting") { () -> Bool in
            StudySyncSharedState.checkEnabledSetting()
        }

        Function("setCheckEnabledSetting") { (enabled: Bool) in
            try StudySyncAccountGate().withNormalOperation {
                try StudySyncAccountData.invalidateOwnerReceipt(field: .checkEnabledSetting)
                StudySyncSharedState.setCheckEnabledSetting(enabled)
            }
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
        // 不正・gate取得失敗はfalse。ライブアクティビティの表示が OS 側の制約で失敗しても
        // (Live Activities が無効など)戻り値には反映しない=false にしない)
        AsyncFunction("startMeasurement") { (uid: String, goalId: String, sessionId: String, startAt: Double, checkEnabled: Bool) -> Bool in
            do {
                return try await StudySyncAccountGate().withNormalOperation { () async throws -> Bool in
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
            } catch {
                StudySyncLastSyncError.set("native操作を実行できませんでした。再試行してください")
                return false
            }
        }

        // 5-3c-5a: アプリから呼ぶ stopMeasurement も nativeSync に送らない(理由は startMeasurement と同じ)。
        // 通知の取り消しは JS(5-3c-5b)が行う。
        // 戻り値: 消す前に計測中の状態が実際にあったか(true=あった・消した、false=すでに無かった。
        // 例えばロック画面の停止が先に届いていた場合)
        AsyncFunction("stopMeasurement") { (uid: String, goalId: String, sessionId: String) -> Bool in
            do {
                return try await StudySyncAccountGate().withNormalOperation {
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
            } catch {
                StudySyncLastSyncError.set("native操作を実行できませんでした。再試行してください")
                return false
            }
        }

        /// ロック画面(StopStudyIntent)で止めた最後の計測(sessionId・stopAt)。無ければ nil(5-3c-5a)
        Function("getLastLockscreenStop") { () -> [String: Any]? in
            StudySyncSharedState.lastLockscreenStop()?.asDictionary()
        }

        Function("clearLastLockscreenStop") {
            try StudySyncAccountGate().withNormalOperation {
                try StudySyncAccountData.invalidateOwnerReceipt(field: .lastLockscreenStop)
                StudySyncSharedState.clearLastLockscreenStop()
            }
        }

        AsyncFunction("flushQueue") { () -> Int in
            await StudySyncAPI.flushQueue()
        }

        Function("getPendingQueueCount") { () -> Int in
            StudySyncQueue.count()
        }

        #if DEBUG
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
        #endif

        AsyncFunction("requestNotificationPermission") { () -> Bool in
            (try? await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound]
            )) ?? false
        }

        #if DEBUG
        /// 開発ビルド専用(5-3e-2。problem P-011 (3)): 「勉強中？」確認の間隔・応答期限を開発用の
        /// 短い値に切り替える(App Group に保存)。両方 nil を渡すと本番の値に戻す(設定を消す)。
        /// #if DEBUG でくくっているため、本番ビルド(Release)にはこの関数自体が存在しない
        /// (JS から呼ぶと "method not found" 相当の例外になるが、呼び出し側(studyCheckDevOverride.ts)が
        /// __DEV__ のときだけ呼ぶため実害はない)
        Function("setStudyCheckDevOverride") { (intervalMs: Double?, responseWindowMs: Double?) in
            try StudySyncAccountGate().withNormalOperation {
                guard let intervalMs, let responseWindowMs else {
                    StudySyncSharedState.setCheckDevOverride(nil)
                    return
                }
                StudySyncSharedState.setCheckDevOverride(
                    StudySyncCheckDevOverride(intervalMs: intervalMs, responseWindowMs: responseWindowMs)
                )
            }
        }

        /// 開発ビルド専用(5-3e-2): 上書き設定を読む。無ければ nil
        Function("getStudyCheckDevOverride") { () -> [String: Double]? in
            guard let override = StudySyncSharedState.checkDevOverride() else { return nil }
            return ["intervalMs": override.intervalMs, "responseWindowMs": override.responseWindowMs]
        }
        #endif
    }
}
