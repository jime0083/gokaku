import Foundation
import os
import Security
import UserNotifications

/// Console.app(unified logging)で確認するためのログ。メインアプリ・WidgetKit 拡張のどちらの
/// プロセスで実行していても、それぞれの実行時に出力される(5-3c-4: ウィジェットの拡張からも
/// NativeSyncBaseURL が読めていることを確かめるため)
private let studySyncLogger = Logger(subsystem: "com.jime0083.gokakuwatch.studysync", category: "StudySyncAPI")

/// Phase 5-3c-2: アプリ側(Expo Module)・ロック画面側(WidgetKit 拡張)の両方が使う、
/// Cloud Functions(nativeSync)への送信・Keychain(デバイストークン)・App Group キュー
/// (オフライン時の再送)。`targets/_shared/` に置く理由は StudySyncConstants.swift と同じ
/// (以前は modules/study-sync/ios と targets/widget に少しずつ違う内容で複製されていた。5-3c-0)
enum StudySyncAction: String, Codable {
    case start
    case stop
    case confirm
}

/// nativeSync(functions/src/nativeSync.ts)が受け取る本文の形(5-3c-4。requirements 3-2)。
/// アプリの記録(recordStudyEvent。5-1b-1・5-2a)と揃えてある: sessionId・action・clientTimeMs・
/// idempotencyKey・goalId、action が start のときだけ checkEnabled を送る。
/// source は本文に含めない(nativeSync からの記録は常に 'lockscreen' とサーバー側が決める)
struct StudySyncEvent: Codable {
    let uid: String
    let sessionId: String
    let goalId: String
    let action: StudySyncAction
    /// 端末時刻(epoch ms)。サーバー側は受信時刻(serverReceivedAt)も別途記録する
    let clientTimeMs: Double
    /// 再送時の重複書き込みを防ぐための冪等キー(UUID)
    let idempotencyKey: String
    /// action が .start のときだけ値を持つ。nil の場合、JSONEncoder はキー自体を省く
    /// (Swift の自動合成された Encodable は Optional プロパティに encodeIfPresent を使うため)
    let checkEnabled: Bool?
}

/// Keychain への書き込み(delete→add)が失敗した場合に投げるエラー。
/// OSStatus を含めて呼び出し元(JS)まで伝える(problem P-012: 失敗を握りつぶして
/// 古いデバイストークンが Keychain に残ったまま認証に使われる不具合の再発防止)
struct StudySyncKeychainError: Error, LocalizedError {
    let operation: String
    let account: String
    let status: OSStatus

    var errorDescription: String? {
        "Keychain \(operation) 失敗 (account=\(account), OSStatus=\(status))"
    }
}

/// App Group を介してメインアプリと共有する Keychain アクセスグループ。
/// kSecAttrAccessible は kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly を使う(P-033 修正。5-3c-2 決定):
/// 端末再起動後に一度でもロック解除されていれば、以後は画面がロックされていても
/// (ロック画面コントロール・ライブアクティビティ・通知アクションからの)操作でトークンを読める必要があるため。
/// もっと厳しい kSecAttrAccessibleWhenUnlocked だと、画面ロック中はまさにこの用途(ロック画面からの操作)で
/// 読めなくなってしまう。
/// `ThisDeviceOnly` を付けるのは、暗号化された iCloud・Finder のバックアップにデバイストークンが
/// 含まれて別の端末に復元されてしまうと、本人になりすましてロック画面の操作(開始・停止・確認)を
/// 送れてしまうため(P-033)。機種変更など端末が変わった場合は、デバイストークンが無い状態から
/// issueDeviceToken で作り直す設計(5-3a-2)になっており、デバイストークンを端末間で引き継ぐ想定が
/// そもそもないため、ThisDeviceOnly にしても不都合はない
///
/// kSecAttrAccessible は read/delete の検索条件(baseQuery)には含めない。Keychain の項目を
/// 一意に決めるのは class・service・account・accessGroup で、accessible は検索条件ではなく
/// 「書き込み時に付ける属性」(Apple のドキュメント通り)。検索条件に含めてしまうと、
/// 古い accessible 値(このアプリでは以前は未指定=既定の kSecAttrAccessibleWhenUnlocked)で
/// 保存済みの項目が見つからず delete できないまま、SecItemAdd が同じ項目に衝突して
/// errSecDuplicateItem(-25299)で失敗する(実機・シミュレータで実際に確認した不具合。
/// 以前保存した項目がある状態で動作検証した際に発生し、原因を特定して本実装にした)。
/// delete を accessible 無しの条件にすることで、古い accessible 値の項目も確実に消してから
/// add できるため、既存に保存済みの項目の移行(書き込みし直し)は特別な処理なしで次回の
/// 発行・保存時に自動的に行われる
enum StudySyncKeychain {
    static func readDeviceToken() -> (uid: String, token: String)? {
        guard let token = read(account: StudySyncConstants.keychainAccountDeviceToken),
            let uid = read(account: StudySyncConstants.keychainAccountUid)
        else {
            return nil
        }
        return (uid: uid, token: token)
    }

    static func save(uid: String, token: String) throws {
        try write(account: StudySyncConstants.keychainAccountUid, value: uid)
        try write(account: StudySyncConstants.keychainAccountDeviceToken, value: token)
    }

    static func clear() throws {
        try deleteOrThrow(account: StudySyncConstants.keychainAccountUid)
        try deleteOrThrow(account: StudySyncConstants.keychainAccountDeviceToken)
    }

    private static var keychainAccessGroup: String {
        StudySyncConstants.appGroupIdentifier
    }

    private static func baseQuery(account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: StudySyncConstants.keychainService,
            kSecAttrAccount: account,
            kSecAttrAccessGroup: keychainAccessGroup,
        ]
    }

    private static func read(account: String) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 既存の値を削除してから書き込む。delete・add のどちらの OSStatus も確認し、
    /// 失敗時は例外を投げる(以前は戻り値を見ておらず、add が errSecDuplicateItem 等で
    /// 失敗しても古い値が残ったまま成功したかのように扱われていた)
    private static func write(account: String, value: String) throws {
        try deleteOrThrow(account: account)
        var query = baseQuery(account: account)
        query[kSecValueData] = value.data(using: .utf8)
        query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw StudySyncKeychainError(operation: "add", account: account, status: status)
        }
    }

    /// 項目が無い(errSecItemNotFound)は正常(初回書き込み時など)。それ以外の失敗は例外にする
    private static func deleteOrThrow(account: String) throws {
        let query = baseQuery(account: account)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StudySyncKeychainError(operation: "delete", account: account, status: status)
        }
    }
}

/// App Group のキューに積む1件(5-3c-6)。元の操作(event)に加え、nativeSync から 401 を受けたときに
/// 立てる「トークンを待つ」印(waitingForToken)を持たせる。印の付いた項目は、通常の再送
/// (StudySyncAPI.flushQueue)では送らない(同じ古いトークンで何度も401を受けないため)。
/// アプリが StudySyncModule.setAuthContext で新しいトークンを保存したときだけ、その uid の
/// 印付きの項目を送り直す(StudySyncAPI.flushWaitingForToken)
struct StudySyncQueueItem: Codable {
    let event: StudySyncEvent
    var waitingForToken: Bool
}

/// 送れなかった操作を App Group の UserDefaults に溜めておく簡易キュー
enum StudySyncQueue {
    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: StudySyncConstants.appGroupIdentifier)
    }

    /// キューに積める件数の上限(StudySyncConstants.queueMaxItems を参照。5-3c-6)
    static var maxItems: Int { StudySyncConstants.queueMaxItems }

    /// 末尾に積む。上限(maxItems)を超えたら、最も古いものから捨てる(古い順に並んでいる前提。5-3c-6)
    static func enqueue(_ item: StudySyncQueueItem) {
        guard let defaults = defaults, let data = try? JSONEncoder().encode(item) else { return }
        var items = rawItems()
        items.append(data)
        if items.count > maxItems {
            items.removeFirst(items.count - maxItems)
        }
        defaults.set(items, forKey: StudySyncConstants.pendingQueueKey)
    }

    /// キューの内容を全て読み出す(空にはしない。読み込めない項目は捨てる。既存の動き)。
    /// 5-3c-6: 以前はここでキューを空にしてから(drain)、送信結果に応じて書き戻していたが、
    /// 書き戻す前にプロセスが終了する(setAuthContext の fire-and-forget な Task が
    /// 完了を待たれずにプロセスごと終了する等)と、まだ一度も読み出していない・このフラッシュの
    /// 対象ですらない項目までキューから消えてしまう(実機の確認で再現した)。
    /// そのため読み出し(peekAll)と置き換え(replaceAll)を分離し、StudySyncAPI.flush が
    /// 計算を終えた最後に1回だけ replaceAll で書き戻す形にする(book 木に途中経過を書かない)
    static func peekAll() -> [StudySyncQueueItem] {
        decodedItems()
    }

    /// キューの内容を丸ごと置き換える(1回の書き込み)。上限(maxItems)を超えたら、
    /// 最も古いものから捨てる(渡された配列が古い順に並んでいる前提)
    static func replaceAll(_ items: [StudySyncQueueItem]) {
        guard let defaults = defaults else { return }
        var trimmed = items
        if trimmed.count > maxItems {
            trimmed.removeFirst(trimmed.count - maxItems)
        }
        let encoded = trimmed.compactMap { try? JSONEncoder().encode($0) }
        defaults.set(encoded, forKey: StudySyncConstants.pendingQueueKey)
    }

    static func count() -> Int {
        rawItems().count
    }

    /// 「トークンを待つ」印が付いている件数(キューを空にせずに数えるだけ。確認画面での表示用。5-3c-6)
    static func waitingForTokenCount() -> Int {
        decodedItems().filter(\.waitingForToken).count
    }

    private static func decodedItems() -> [StudySyncQueueItem] {
        rawItems().compactMap { try? JSONDecoder().decode(StudySyncQueueItem.self, from: $0) }
    }

    private static func rawItems() -> [Data] {
        (defaults?.array(forKey: StudySyncConstants.pendingQueueKey) as? [Data]) ?? []
    }
}

/// 直前の送信失敗の理由(検証画面での表示用。problem P-012: 「送信: false」だけでは
/// 認証失敗(Keychainのトークン不整合)・サーバー拒否(401等)・通信不可のどれかが分からなかった)
enum StudySyncLastSyncError {
    private static let lock = NSLock()
    private static var message: String?

    static func set(_ value: String?) {
        lock.lock()
        message = value
        lock.unlock()
    }

    static func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return message
    }
}

/// nativeSync への1回の送信結果の扱い(5-3c-6。functions/src/nativeSync.ts のエラー応答のコメントに対応)。
/// - success: 200。キューから消す(呼び出し元は再度積まない)
/// - retry(reason): 送り直す(500・通信エラー・429 rate_limited・本文が読めない429・それ以外の想定外の
///   応答。いずれも「少し待てば・設定が直れば通る可能性がある」失敗)。キューに残す(印は付けない)
/// - discard(reason): 捨てる(400・413・429 confirmation_limit_exceeded。送り直しても結果が変わらない)。
///   キューに戻さない(理由だけ StudySyncLastSyncError に記録する)
/// - waitingForToken(reason): 401。アプリが setAuthContext で新しいトークンを保存するまで、
///   「トークンを待つ」印を付けてキューに残す(Keychain にトークンが無い場合も同じ扱い。
///   どちらも「有効なトークンが無い」という同じ状態のため)
private enum StudySyncPostResult {
    case success
    case retry(reason: String)
    case discard(reason: String)
    case waitingForToken(reason: String)
}

enum StudySyncAPI {
    /// 操作を nativeSync(Cloud Functions)へ送る。送れなければ応答に応じてキューに積む
    /// (捨てる場合は積まない)。戻り値は送れたか(true=200)
    @discardableResult
    static func send(_ event: StudySyncEvent) async -> Bool {
        let result = await post(event)
        return applyAndEnqueueIfNeeded(event: event, result: result)
    }

    /// 次の機会(アプリ起動時・次の操作時)に溜まっていたキューを送り直す。
    /// 「トークンを待つ」印の付いた項目は送らない(印の付いていない項目だけが対象。5-3c-6)
    static func flushQueue() async -> Int {
        await flush { !$0.waitingForToken }
    }

    /// setAuthContext で新しいトークンを保存した直後に呼ぶ(5-3c-6)。その uid の
    /// 「トークンを待つ」印が付いた項目だけを送り直す(ほかの uid の印付き項目はそのまま残す)
    static func flushWaitingForToken(forUid uid: String) async -> Int {
        await flush { $0.waitingForToken && $0.event.uid == uid }
    }

    /// キューを(空にせずに)読み出し、`shouldSend` に合う項目だけを古い順に送る。合わない項目は
    /// そのまま残す。送信を試みて「送り直す」または「トークンを待つ」になった項目が出た時点で、
    /// それ以降の項目は試みずそのまま残す(同じ原因(通信不可・サーバー障害・同じ古いトークン)で
    /// 後続も同じ結果になると見込まれるため。5-3c-6 で決定)。「捨てる」になった項目は残さず、
    /// 後続の項目は引き続き試みる(その項目限りの失敗のため)。
    /// 計算した新しいキューの内容は、最後に1回だけ書き戻す(StudySyncQueue.replaceAll。
    /// 送信中にプロセスが終了しても、書き戻し前であれば元のキューの内容がそのまま残る)
    private static func flush(matching shouldSend: (StudySyncQueueItem) -> Bool) async -> Int {
        let pending = StudySyncQueue.peekAll()
        var sentCount = 0
        var newQueue: [StudySyncQueueItem] = []
        var stopped = false

        for item in pending {
            guard !stopped, shouldSend(item) else {
                newQueue.append(item)
                continue
            }
            let result = await post(item.event)
            switch result {
            case .success:
                sentCount += 1
                StudySyncLastSyncError.set(nil)
            case .retry(let reason):
                StudySyncLastSyncError.set(reason)
                newQueue.append(StudySyncQueueItem(event: item.event, waitingForToken: false))
                stopped = true
            case .waitingForToken(let reason):
                StudySyncLastSyncError.set(reason)
                newQueue.append(StudySyncQueueItem(event: item.event, waitingForToken: true))
                stopped = true
            case .discard(let reason):
                StudySyncLastSyncError.set(reason)
                // 新しいキューに入れない(捨てる)。後続の項目は引き続き試みる
            }
        }

        StudySyncQueue.replaceAll(newQueue)
        return sentCount
    }

    /// post の結果を StudySyncLastSyncError に記録し、必要ならキューに積む。戻り値は送れたか
    @discardableResult
    private static func applyAndEnqueueIfNeeded(event: StudySyncEvent, result: StudySyncPostResult) -> Bool {
        switch result {
        case .success:
            StudySyncLastSyncError.set(nil)
            return true
        case .retry(let reason):
            StudySyncLastSyncError.set(reason)
            StudySyncQueue.enqueue(StudySyncQueueItem(event: event, waitingForToken: false))
            return false
        case .waitingForToken(let reason):
            StudySyncLastSyncError.set(reason)
            StudySyncQueue.enqueue(StudySyncQueueItem(event: event, waitingForToken: true))
            return false
        case .discard(let reason):
            StudySyncLastSyncError.set(reason)
            return false
        }
    }

    private static func post(_ event: StudySyncEvent) async -> StudySyncPostResult {
        guard let auth = StudySyncKeychain.readDeviceToken() else {
            // トークンが無い(未発行・ログアウト直後など)のは、401(トークンが無効)と同じ
            // 「有効なトークンが無い」状態なので同じ扱いにする(setAuthContext 後に送り直す)
            return .waitingForToken(reason: "Keychainにデバイストークンが無い(未発行、または書き込み失敗)")
        }
        guard auth.uid == event.uid else {
            // Keychain の uid(今ログイン中のアカウント)と、この操作の uid が異なる。
            // 別アカウントの操作であり、今のトークンでは(新しいトークンに替わっても他人の uid のままなら)
            // 届けられないため、送り直さず捨てる
            return .discard(reason: "Keychainのuidと送信対象のuidが一致しない(別アカウントの操作)")
        }
        guard let body = try? JSONEncoder().encode(event) else {
            return .discard(reason: "イベントのエンコードに失敗した")
        }
        guard let baseURL = StudySyncConstants.nativeSyncBaseURL else {
            studySyncLogger.error("NativeSyncBaseURL が読めない・不正(action=\(event.action.rawValue, privacy: .public))")
            // 設定が直れば送れるようになるため、捨てずに送り直す対象にする
            return .retry(reason: "送信先の設定(Info.plist の NativeSyncBaseURL)が読めない・不正なため送信できない")
        }
        studySyncLogger.info(
            "NativeSyncBaseURL を読めた(host=\(baseURL.host ?? "?", privacy: .public), action=\(event.action.rawValue, privacy: .public))"
        )

        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .retry(reason: "HTTPURLResponseを取得できなかった")
            }
            if (200..<300).contains(http.statusCode) {
                return .success
            }
            return classifyFailureResponse(statusCode: http.statusCode, body: data)
        } catch {
            return .retry(reason: "通信エラー: \(error.localizedDescription)")
        }
    }

    /// nativeSync(functions/src/nativeSync.ts)のエラー応答を、送り直す・捨てる・トークンを待つに分ける
    /// (5-3c-6)。応答の形は `{ "error": "<理由>" }`
    private static func classifyFailureResponse(statusCode: Int, body: Data) -> StudySyncPostResult {
        switch statusCode {
        case 401:
            // トークンが無い・ハッシュが不一致・期限切れのいずれも 401(nativeSync.ts)。
            // アプリが setAuthContext で新しいトークンを保存するまで待つ
            return .waitingForToken(reason: "サーバーが 401 を返した(トークンが無効・期限切れ)")
        case 400:
            // invalid_body(本文の形が不正)・goal_not_found(架空の goalId)のいずれも、
            // 送り直しても結果は変わらない(nativeSync.ts のコメント参照)
            return .discard(reason: "サーバーが 400 を返した(本文が不正、または存在しない目標)")
        case 413:
            // payload_too_large。正しい形の本文はこの大きさを超えないため、送り直しても変わらない
            return .discard(reason: "サーバーが 413 を返した(本文が大きすぎる)")
        case 429:
            guard let errorReason = errorField(from: body) else {
                // 本文が読めない(壊れている・空)場合は、原因を区別できないので送り直す側に倒す(5-3c-6 決定)
                return .retry(reason: "サーバーが 429 を返したが、本文から理由を読み取れなかった")
            }
            if errorReason == "confirmation_limit_exceeded" {
                // 確認の上限超え。送り直しても結果は変わらない
                return .discard(reason: "サーバーが 429(confirmation_limit_exceeded)を返した")
            }
            // rate_limited、または未知の理由は、少し待てば通る可能性があるため送り直す
            return .retry(reason: "サーバーが 429(\(errorReason))を返した")
        case 500:
            return .retry(reason: "サーバーが 500 を返した")
        default:
            // nativeSync.ts が返すのは上記のみだが、想定外の応答(502 等)は安全側に倒して送り直す
            return .retry(reason: "サーバーが \(statusCode) を返した")
        }
    }

    /// 応答本文の `{ "error": "..." }` を読む。形が JSON でない・error が文字列でない場合は nil
    private static func errorField(from body: Data) -> String? {
        guard
            let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let error = json["error"] as? String
        else {
            return nil
        }
        return error
    }
}

/// ロック画面コントロール・ライブアクティビティが参照する「現在の目標ID」等の共有状態。
/// アプリ側(StudySyncModule.swift)が setCurrentGoalId で書き、ロック画面コントロール
/// (targets/widget/StudyControlWidget.swift の StartStudyIntent)が currentGoalId() で読む
enum StudySyncSharedState {
    fileprivate static var defaults: UserDefaults? {
        UserDefaults(suiteName: StudySyncConstants.appGroupIdentifier)
    }

    static func setCurrentGoalId(_ goalId: String?) {
        defaults?.set(goalId, forKey: "studySync.currentGoalId")
    }

    static func currentGoalId() -> String? {
        defaults?.string(forKey: "studySync.currentGoalId")
    }
}

/// 計測中の状態(5-3c-3。requirements 3-2「アプリとロック画面の計測の共有」)。
/// アプリ・ロック画面(ライブアクティビティ・ロック画面コントロール)のどちらで開始した計測でも、
/// App Group に 1 件だけ置く(計測中でなければ存在しない)。どちらからも読み書き・消去できる。
/// shared/studyCheck.ts の CheckedStudySession(JS 側の計測中セッションの形)と対応させてある
/// (sessionId・goalId は StudySyncEvent と同じ役割、startAt・confirmations は epoch ミリ秒)
struct StudySyncActiveSession: Codable, Equatable {
    let sessionId: String
    let uid: String
    let goalId: String
    /// 計測開始時刻(epoch ミリ秒)
    let startAt: Double
    let checkEnabled: Bool
    /// 「勉強中」と応答した時刻(epoch ミリ秒)の配列。順不同
    let confirmations: [Double]
}

extension StudySyncActiveSession {
    /// JS(ExpoModulesCore)へ渡すための辞書形式。`[String: Any]` はそのまま JS のオブジェクトに変換される
    /// (expo-iap の fetchProducts 等と同じ、ExpoModulesCore が提供する Dictionary の AnyArgument 対応)
    func asDictionary() -> [String: Any] {
        [
            "sessionId": sessionId,
            "uid": uid,
            "goalId": goalId,
            "startAt": startAt,
            "checkEnabled": checkEnabled,
            "confirmations": confirmations,
        ]
    }

    /// JS から受け取った辞書を検査し、妥当な値なら StudySyncActiveSession を作る。
    /// 必須項目が無い・型が違う・confirmations に数値でない要素がある場合は nil
    /// (呼び出し元の StudySyncModule.setActiveSession が false を返し、書き込みを断る。5-3c-3)
    init?(dictionary: [String: Any]) {
        guard
            let sessionId = dictionary["sessionId"] as? String, !sessionId.isEmpty,
            let uid = dictionary["uid"] as? String, !uid.isEmpty,
            let goalId = dictionary["goalId"] as? String, !goalId.isEmpty,
            let startAt = dictionary["startAt"] as? Double, startAt.isFinite,
            let checkEnabled = dictionary["checkEnabled"] as? Bool
        else {
            return nil
        }
        let confirmationsRaw = dictionary["confirmations"] as? [Any] ?? []
        let confirmations = confirmationsRaw.compactMap { $0 as? Double }.filter { $0.isFinite }
        guard confirmations.count == confirmationsRaw.count else {
            // 数値でない要素があった(壊れた入力)。全体を不正として扱う
            return nil
        }
        self.sessionId = sessionId
        self.uid = uid
        self.goalId = goalId
        self.startAt = startAt
        self.checkEnabled = checkEnabled
        self.confirmations = confirmations
    }
}

/// ロック画面から開始した計測の「勉強中？」確認の通知(5-3c-4。requirements 3-2)。
/// JS 側(src/features/timer/studyCheckNotifications.ts)とまったく同じ識別子・カテゴリ・アクション・
/// 文言を使う(通知センター・ロック画面には区別がないため、どちらから予約しても同じ見え方・同じ
/// アクションの応答の受け取り方になる必要がある)。カテゴリ(STUDY_CHECK)・アクション
/// (STUDY_CHECK_CONFIRM)自体の登録は JS 側(configureStudyCheckNotifications)が行うため、
/// ここでは登録しない
enum StudySyncCheckNotification {
    /// 通知のアクションのカテゴリ識別子(JS の STUDY_CHECK_CATEGORY_IDENTIFIER と同じ)
    static let categoryIdentifier = "STUDY_CHECK"
    /// 予約する通知の識別子(JS の STUDY_CHECK_NOTIFICATION_IDENTIFIER と同じ。固定値なので
    /// 同じ識別子で予約し直すと置き換わる)
    static let notificationIdentifier = "study-check-notification"
    /// 「勉強中？」確認の間隔(計測開始から60分ごと。requirements 3-2。shared/studyCheck.ts の
    /// STUDY_CHECK_INTERVAL_MS と同じ値)
    static let firstCheckIntervalSeconds: TimeInterval = 60 * 60

    /// 計測開始から `firstCheckIntervalSeconds` 後に通知を1件予約する(既存の予約があれば置き換える)
    static func scheduleFirstCheck() async {
        let content = UNMutableNotificationContent()
        content.title = "勉強中？"
        content.categoryIdentifier = categoryIdentifier
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: firstCheckIntervalSeconds,
            repeats: false
        )
        let request = UNNotificationRequest(
            identifier: notificationIdentifier,
            content: content,
            trigger: trigger
        )
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// 予約中の確認の通知を取り消す(予約がなくても安全に呼べる)
    static func cancel() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: [notificationIdentifier]
        )
    }
}

/// ロック画面(ライブアクティビティの停止ボタン。StopStudyIntent)で止めた最後の計測
/// (5-3c-5a。requirements 3-2「ロック画面で止めたあとにアプリを開いたときは…」)。
/// アプリが次に開かれたとき(5-3c-5b)に、この sessionId・stopAt を使って端末内の記録を
/// 「止まった計測」として取り込む。1 件だけ(上書き)
struct StudySyncLastLockscreenStop: Codable, Equatable {
    let sessionId: String
    /// ロック画面で止めた時刻(epoch ミリ秒)
    let stopAt: Double
}

extension StudySyncLastLockscreenStop {
    func asDictionary() -> [String: Any] {
        ["sessionId": sessionId, "stopAt": stopAt]
    }
}

extension StudySyncSharedState {
    private static let activeSessionKey = "studySync.activeSession.v1"
    /// 確認 ON/OFF の設定を覚えておく値(計測中の状態とは別に持つ。requirements 3-2:
    /// 「確認の ON/OFF は、アプリが端末に覚えておいた設定を使う」。ロック画面から計測を開始したとき
    /// (5-3c-4)に、計測中でなくてもこの設定を読めるようにするため、活動中の状態(activeSessionKey)とは
    /// 別のキーにする
    private static let checkEnabledSettingKey = "studySync.checkEnabledSetting.v1"
    /// ロック画面で止めた最後の計測(StudySyncLastLockscreenStop)を置くキー(5-3c-5a)
    private static let lastLockscreenStopKey = "studySync.lastLockscreenStop.v1"

    static func activeSession() -> StudySyncActiveSession? {
        guard let data = defaults?.data(forKey: activeSessionKey) else { return nil }
        return try? JSONDecoder().decode(StudySyncActiveSession.self, from: data)
    }

    /// 書き込みに成功したら true。JSON へのエンコードに失敗した場合(通常発生しない)は false
    @discardableResult
    static func setActiveSession(_ session: StudySyncActiveSession) -> Bool {
        guard let data = try? JSONEncoder().encode(session) else { return false }
        defaults?.set(data, forKey: activeSessionKey)
        return true
    }

    static func clearActiveSession() {
        defaults?.removeObject(forKey: activeSessionKey)
    }

    /// 初期値は ON(true)。requirements 3-2「勉強中？」確認(初期値ON)
    static func checkEnabledSetting() -> Bool {
        guard let defaults, defaults.object(forKey: checkEnabledSettingKey) != nil else {
            return true
        }
        return defaults.bool(forKey: checkEnabledSettingKey)
    }

    static func setCheckEnabledSetting(_ enabled: Bool) {
        defaults?.set(enabled, forKey: checkEnabledSettingKey)
    }

    /// ロック画面で止めた最後の計測を読む。無ければ nil
    static func lastLockscreenStop() -> StudySyncLastLockscreenStop? {
        guard let data = defaults?.data(forKey: lastLockscreenStopKey) else { return nil }
        return try? JSONDecoder().decode(StudySyncLastLockscreenStop.self, from: data)
    }

    /// 書き込みに成功したら true。JSON へのエンコードに失敗した場合(通常発生しない)は false
    @discardableResult
    static func setLastLockscreenStop(_ stop: StudySyncLastLockscreenStop) -> Bool {
        guard let data = try? JSONEncoder().encode(stop) else { return false }
        defaults?.set(data, forKey: lastLockscreenStopKey)
        return true
    }

    static func clearLastLockscreenStop() {
        defaults?.removeObject(forKey: lastLockscreenStopKey)
    }
}
