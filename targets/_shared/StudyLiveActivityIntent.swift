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
            await StudySyncAPI.send(event)
            StudySyncSharedState.setLastLockscreenStop(
                StudySyncLastLockscreenStop(
                    sessionId: session.sessionId,
                    stopAt: stoppedAt.timeIntervalSince1970 * 1000
                )
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
        return .result()
    }
}
