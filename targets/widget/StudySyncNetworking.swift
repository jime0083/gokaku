import Foundation
import Security

/// Phase 1-4 技術検証: ロック画面(ライブアクティビティ・ロック画面コントロール)からの
/// 操作を、アプリを開かずに Cloud Functions(Emulator)へ送る処理。
/// WidgetKit 拡張プロセス側のコード(App Intent の perform() から呼ばれる)。
enum StudySyncAction: String, Codable {
    case start
    case stop
    case confirm
}

enum StudySyncSource: String, Codable {
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

/// App Group を介してメインアプリと共有する Keychain アクセスグループから
/// デバイストークン(なりすまし対策の認証情報。候補A。詳細は報告を参照)を読む
enum StudySyncKeychain {
    static func readDeviceToken() -> (uid: String, token: String)? {
        guard let token = read(account: StudySyncConstants.keychainAccountDeviceToken),
            let uid = read(account: StudySyncConstants.keychainAccountUid)
        else {
            return nil
        }
        return (uid: uid, token: token)
    }

    private static func read(account: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: StudySyncConstants.keychainService,
            kSecAttrAccount: account,
            kSecAttrAccessGroup: keychainAccessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// `$(AppIdentifierPrefix)` はビルド時に Xcode が Team ID に展開するため、
    /// 実行時の Keychain クエリでは実際のプレフィックス(Team ID)を使う必要がある。
    /// entitlements ファイルに書いた値をそのまま使うのではなく、実行時は
    /// kSecAttrAccessGroup にチーム prefix なしのグループ名を渡しても OS が解決してくれる
    /// (同一 App Group 内であれば1つしかプレフィックスが無いため)
    private static var keychainAccessGroup: String {
        StudySyncConstants.appGroupIdentifier
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

enum StudySyncAPI {
    /// 操作を Functions(Emulator)へ送る。失敗した場合は App Group のキューに積んで false を返す
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
                // 失敗した分だけ再度キューへ戻す
                StudySyncQueue.enqueue(event)
            }
        }
        return sentCount
    }

    private static func post(_ event: StudySyncEvent) async -> Bool {
        guard let auth = StudySyncKeychain.readDeviceToken(), auth.uid == event.uid else {
            return false
        }
        guard let body = try? JSONEncoder().encode(event) else { return false }

        var request = URLRequest(url: StudySyncConstants.emulatorNativeSyncURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            return false
        }
    }
}
