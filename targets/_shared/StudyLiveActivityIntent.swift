import ActivityKit
import AppIntents

/// ライブアクティビティ・Dynamic Island の「停止」ボタン(requirements.md 3-2)。
///
/// problem P-011 (1): この型を `targets/widget`(ウィジェット拡張ターゲット)だけに置いていたところ、
/// 「停止」をタップしても `nativeSync` への送信は成功するのにライブアクティビティの表示が消えない
/// (`Activity<StudyActivityAttributes>.activities` が空配列を返し `activity.end()` が実行されない)
/// 不具合があった。
///
/// Apple の公式ドキュメント(Adding interactivity to widgets and Live Activities。
/// https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)に
/// 次のとおり明記されている:
/// 「If you adopt the LiveActivityIntent or AudioPlaybackIntent protocol, the system runs the app intent
/// in the app's process. Make sure to add your custom app intent to your app target.」
/// (`LiveActivityIntent` に準拠する intent は、システムがアプリ本体のプロセスで実行する。
/// その intent をアプリ本体のターゲットにも必ず追加すること)
///
/// つまり `LiveActivityIntent` はウィジェット拡張のプロセスではなくアプリ本体のプロセスで実行される
/// ("same process as the widget extension" になるのは素の `AppIntent` のみで、`LiveActivityIntent` は
/// 明示的な例外)。この型をウィジェット拡張ターゲットにしか追加していなかったため、`Activity.request()`
/// をアプリ本体のプロセスで呼んでいる既存のライブアクティビティ(5-3c-5a の `startMeasurement`)を、
/// 実行先の異なるプロセスから見つけられなかった(5-3d で特定)。
///
/// 修正: この型を `targets/_shared/` に置き、アプリ本体ターゲット(`modules/study-sync` の podspec が
/// この symlink を取り込む)・ウィジェット拡張ターゲットの両方に含める(`StudyAttributes.swift` と同じ方式)。
/// `targets/widget/StudyLiveActivityWidget.swift` の `StopButton`(ライブアクティビティの UI。
/// ウィジェット拡張ターゲットのみに存在)からは、同じ型名としてそのまま参照できる。
///
/// 5-3c-4(requirements 3-2「アプリとロック画面の計測の共有」): sessionId は計測中の状態
/// (5-3c-3。App Group に 1 件だけ置く)から読む。uid・goalId パラメータはライブアクティビティの
/// 属性から渡ってくる値で、どの Activity を終了するかの判定に使う。
/// 5-3c-5a: 計測中の状態を消すときに「最後にロック画面で止めた計測」(sessionId・stopAt)を残す
struct StopStudyIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "勉強を停止"
    static var isDiscoverable: Bool = false

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
        // busy/blockedは状態を読む前にthrowし、OSによる再試行に委ねる。
        try await StudySyncAccountGate().withNormalOperation {
            // 計測中の状態があれば、その sessionId で stop を送り、状態を消し、通知の予約を取り消す
            // (計測中の状態がすでに無い=別の経路でこの計測が止められている場合は、送信せずに
            // ライブアクティビティの後片付けだけ行う)。
            // 5-3c-5a: 消す前に、この sessionId・止めた時刻(stopAt)を「最後にロック画面で止めた計測」
            // として App Group に残す(1件だけ。上書き)。アプリを次に開いたとき(5-3c-5b)に、
            // この sessionId・stopAt を使って端末内の記録を「ロック画面で止まった計測」として取り込むため
            if let session = StudySyncSharedState.activeSession() {
                let stoppedAt = Date()
                let event = StudySyncEvent(
                    uid: session.uid,
                    sessionId: session.sessionId,
                    goalId: session.goalId,
                    action: .stop,
                    clientTimeMs: stoppedAt.timeIntervalSince1970 * 1000,
                    idempotencyKey: UUID().uuidString,
                    checkEnabled: nil
                )
                await StudySyncAPI.sendUnlocked(event)
                StudySyncSharedState.setLastLockscreenStop(
                    StudySyncLastLockscreenStop(
                        sessionId: session.sessionId,
                        stopAt: stoppedAt.timeIntervalSince1970 * 1000
                    ),
                    uid: session.uid
                )
                StudySyncSharedState.clearActiveSession()
                StudySyncCheckNotification.cancel()
            }

            for activity in Activity<StudyActivityAttributes>.activities
            where activity.attributes.uid == uid {
                await activity.end(
                    ActivityContent(state: activity.content.state, staleDate: nil),
                    dismissalPolicy: .immediate
                )
            }
        }
        return .result()
    }
}

/// ロック画面コントロールから計測を開始する App Intent(requirements.md 3-2「アプリとロック画面の
/// 計測の共有」iOS 18+。`ControlWidgetButton` の action に使うため `targets/widget/StudyControlWidget.swift`
/// から呼ばれる)。uid・現在の goalId はログイン・目標設定済みのメインアプリが App Group に
/// 書き込んでおいた値を読む。
///
/// problem P-038: この型はもともと `AppIntent`(無印)に準拠しており、`targets/widget`
/// (ウィジェット拡張ターゲット)にしか定義されていなかった。Apple の公式ドキュメント
/// (ActivityKit の `Activity.request(attributes:content:pushType:)`)に次の記述がある:
/// 「Use this function to request and start a Live Activity from your app while it's in the
/// foreground. Note that you can't do this while your app is in the background, unless you
/// adopt AppIntents and start the Live Activity using a LiveActivityIntent.」
/// つまりロック画面コントロール(アプリが前面にない状態)から `Activity.request()` を確実に
/// 実行するには、素の `AppIntent` ではなく `LiveActivityIntent` に準拠させる必要がある。
/// `StopStudyIntent` と同じ理由(上記コメント参照)で、`LiveActivityIntent` はアプリ本体の
/// プロセスで実行されるため、この型を `targets/_shared/` に置いてアプリ本体ターゲット・
/// ウィジェット拡張ターゲットの両方に含める(5-3d-2)。
///
/// `LiveActivityIntent` は iOS 17.0 以降で使える(AppIntents.framework の
/// `@available(iOS 17.0, *) public protocol LiveActivityIntent`)。このプロジェクトの
/// deploymentTarget はすでに 17.0 のため、`@available` の指定は不要(`StopStudyIntent` と同じ)。
/// `ControlWidgetButton(action:)` は `Action: AppIntents.AppIntent` を要求するが、
/// `LiveActivityIntent: SystemIntent: AppIntent` のためこの型のままで渡せる
/// (WidgetKit.framework の swiftinterface で確認)。
///
/// 5-3c-4(requirements 3-2): 計測中の状態(5-3c-3。App Group に 1 件だけ置く)を正として扱う。
/// すでに計測中であれば何もしない(アプリで始めた計測をロック画面から二重に start しない)。
/// uid・デバイストークン・goalId のどれかが分からない場合も何もしない
/// (ログイン・目標設定が済んでいない端末からの操作を無視する)
struct StartStudyIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "勉強を開始"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        // busy/blockedは状態を読む前にthrowし、OSによる再試行に委ねる。
        try await StudySyncAccountGate().withNormalOperation {
            guard StudySyncSharedState.activeSession() == nil else {
                return
            }
            guard let auth = StudySyncKeychain.readDeviceToken() else {
                return
            }
            guard let goalId = StudySyncSharedState.currentGoalId(), !goalId.isEmpty else {
                return
            }

            let sessionId = UUID().uuidString
            let startedAt = Date()
            let checkEnabled = StudySyncSharedState.checkEnabledSetting()

            // ネットワークの成否に関わらず、計測中の状態はまず App Group に書く
            // (アプリ側の表示・ロック画面の停止操作は、この状態を正として動く。5-3c-3)
            let session = StudySyncActiveSession(
                sessionId: sessionId,
                uid: auth.uid,
                goalId: goalId,
                startAt: startedAt.timeIntervalSince1970 * 1000,
                checkEnabled: checkEnabled,
                confirmations: []
            )
            StudySyncSharedState.setActiveSession(session)

            let event = StudySyncEvent(
                uid: auth.uid,
                sessionId: sessionId,
                goalId: goalId,
                action: .start,
                clientTimeMs: startedAt.timeIntervalSince1970 * 1000,
                idempotencyKey: UUID().uuidString,
                checkEnabled: checkEnabled
            )
            // 送れなければ sendUnlocked が同じlease内で App Group のキューに積む(5-3c-6 で送り直し方を整理する)
            await StudySyncAPI.sendUnlocked(event)

            let attributes = StudyActivityAttributes(uid: auth.uid)
            let state = StudyActivityAttributes.ContentState(startedAt: startedAt, goalId: goalId)
            _ = try? Activity<StudyActivityAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil)
            )

            if checkEnabled {
                await StudySyncCheckNotification.scheduleFirstCheck(uid: session.uid)
            }
        }
        return .result()
    }
}
