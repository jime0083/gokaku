import Foundation
import Security

/// Phase 1-4 技術検証: メインアプリ側(Expo Module)の、Cloud Functions(Emulator)への送信・
/// Keychain(デバイストークン)・App Group キュー(オフライン時の再送)。
/// targets/widget/StudySyncNetworking.swift と同じ役割を、別コンパイル単位向けに複製している
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
    let clientTimeMs: Double
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
    @discardableResult
    static func send(_ event: StudySyncEvent) async -> Bool {
        let ok = await post(event)
        if !ok {
            StudySyncQueue.enqueue(event)
        }
        return ok
    }

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

        var request = URLRequest(url: StudySyncConstants.emulatorNativeSyncURL)
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

/// ロック画面コントロール・ライブアクティビティが参照する「現在の目標ID」等の共有状態
enum StudySyncSharedState {
    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: StudySyncConstants.appGroupIdentifier)
    }

    static func setCurrentGoalId(_ goalId: String?) {
        defaults?.set(goalId, forKey: "studySync.currentGoalId")
    }
}
