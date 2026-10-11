import Foundation
import Security

/// Phase 5-3c-2: アプリ側(Expo Module)・ロック画面側(WidgetKit 拡張)の両方が使う、
/// Cloud Functions(nativeSync)への送信・Keychain(デバイストークン)・App Group キュー
/// (オフライン時の再送)。`targets/_shared/` に置く理由は StudySyncConstants.swift と同じ
/// (以前は modules/study-sync/ios と targets/widget に少しずつ違う内容で複製されていた。5-3c-0)
enum StudySyncAction: String, Codable {
    case start
    case stop
    case confirm
}

enum StudySyncSource: String, Codable {
    case app
    case liveActivity = "live_activity"
    case controlWidget = "control_widget"
    case notificationAction = "notification_action"
}

struct StudySyncEvent: Codable {
    let uid: String
    let goalId: String
    let action: StudySyncAction
    let source: StudySyncSource
    /// 端末時刻(epoch ms)。サーバー側は受信時刻(serverReceivedAt)も別途記録する
    let clientTimeMs: Double
    /// 再送時の重複書き込みを防ぐための冪等キー(UUID)
    let idempotencyKey: String
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

/// 送れなかった操作を App Group の UserDefaults に溜めておく簡易キュー
enum StudySyncQueue {
    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: StudySyncConstants.appGroupIdentifier)
    }

    static func enqueue(_ event: StudySyncEvent) {
        guard let defaults = defaults, let data = try? JSONEncoder().encode(event) else { return }
        var items = rawItems()
        items.append(data)
        defaults.set(items, forKey: StudySyncConstants.pendingQueueKey)
    }

    static func drain() -> [StudySyncEvent] {
        let items = rawItems()
        defaults?.removeObject(forKey: StudySyncConstants.pendingQueueKey)
        return items.compactMap { try? JSONDecoder().decode(StudySyncEvent.self, from: $0) }
    }

    static func count() -> Int {
        rawItems().count
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

enum StudySyncAPI {
    /// 操作を nativeSync(Cloud Functions)へ送る。失敗した場合は App Group のキューに積んで false を返す
    @discardableResult
    static func send(_ event: StudySyncEvent) async -> Bool {
        let ok = await post(event)
        if !ok {
            StudySyncQueue.enqueue(event)
        }
        return ok
    }

    /// 次の機会(アプリ起動時・次の操作時)に溜まっていたキューを送り直す
    static func flushQueue() async -> Int {
        let pending = StudySyncQueue.drain()
        var sentCount = 0
        for event in pending {
            if await post(event) {
                sentCount += 1
            } else {
                StudySyncQueue.enqueue(event)
            }
        }
        return sentCount
    }

    private static func post(_ event: StudySyncEvent) async -> Bool {
        guard let auth = StudySyncKeychain.readDeviceToken() else {
            StudySyncLastSyncError.set("Keychainにデバイストークンが無い(未発行、または書き込み失敗)")
            return false
        }
        guard auth.uid == event.uid else {
            StudySyncLastSyncError.set("Keychainのuidと送信対象のuidが一致しない")
            return false
        }
        guard let body = try? JSONEncoder().encode(event) else {
            StudySyncLastSyncError.set("イベントのエンコードに失敗した")
            return false
        }
        guard let baseURL = StudySyncConstants.nativeSyncBaseURL else {
            StudySyncLastSyncError.set(
                "送信先の設定(Info.plist の NativeSyncBaseURL)が読めない・不正なため送信できない"
            )
            return false
        }

        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                StudySyncLastSyncError.set("HTTPURLResponseを取得できなかった")
                return false
            }
            if (200..<300).contains(http.statusCode) {
                StudySyncLastSyncError.set(nil)
                return true
            }
            StudySyncLastSyncError.set("サーバーが \(http.statusCode) を返した")
            return false
        } catch {
            StudySyncLastSyncError.set("通信エラー: \(error.localizedDescription)")
            return false
        }
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

extension StudySyncSharedState {
    private static let activeSessionKey = "studySync.activeSession.v1"
    /// 確認 ON/OFF の設定を覚えておく値(計測中の状態とは別に持つ。requirements 3-2:
    /// 「確認の ON/OFF は、アプリが端末に覚えておいた設定を使う」。ロック画面から計測を開始したとき
    /// (5-3c-4)に、計測中でなくてもこの設定を読めるようにするため、活動中の状態(activeSessionKey)とは
    /// 別のキーにする
    private static let checkEnabledSettingKey = "studySync.checkEnabledSetting.v1"

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
}
