import ActivityKit
import Foundation
import UserNotifications

/// 6-4: 専用gateのlease内で既存raw/helper・Keychain・queueへ接続する。
/// 通常producer用のgate入口は呼ばない。消去・block解除は次の単位で扱う。
struct StudySyncAccountOperations {
    struct Inspection {
        let measuring: Bool
        let ownership: String
        let pendingRecords: Bool

        func asDictionary() -> [String: Any] {
            ["measuring": measuring, "ownership": ownership, "pendingRecords": pendingRecords]
        }
    }

    /// OSから読んだ通知の所有情報だけを持つ。テストではOS操作を使わず注入する。
    struct Notification {
        let identifier: String
        let uid: String?
    }

    enum OperationError: Error {
        case measuring
        case unknownOwnership
        case missingTargetCredential
        case pendingRecords
        case incompleteDrain
        case incompleteCleanup
    }

    private static let checkNotificationIdentifier = "study-check-notification"
    private let gate: StudySyncAccountGate
    private let data: StudySyncAccountData
    private let inspectKeychain: () throws -> StudySyncKeychain.AccountInspection
    private let notifications: () async throws -> [Notification]
    private let flush: ((StudySyncQueueItem) -> Bool) async -> Int
    private let clearKeychain: (String) throws -> Void
    private let removeOwnedNotifications: (String) async throws -> Void
    private let activityOwners: () throws -> [String]
    private let endOwnedActivities: (String) async throws -> Void

    init() throws {
        self.init(gate: try StudySyncAccountGate())
    }

    /// 隔離検証用。live依存をテストから実行しない。
    init(
        gate: StudySyncAccountGate,
        data: StudySyncAccountData = StudySyncAccountData(),
        inspectKeychain: @escaping () throws -> StudySyncKeychain.AccountInspection =
            StudySyncKeychain.inspectForAccountOperation,
        notifications: @escaping () async throws -> [Notification] =
            StudySyncAccountOperations.loadNotifications,
        flush: @escaping ((StudySyncQueueItem) -> Bool) async -> Int =
            { predicate in
                await StudySyncAPI.flushUnlocked(retainDiscarded: true, matching: predicate)
            },
        clearKeychain: @escaping (String) throws -> Void =
            { _ = try StudySyncKeychain.clear(expectedUid: $0) },
        removeOwnedNotifications: @escaping (String) async throws -> Void =
            StudySyncAccountOperations.removeNotificationsForAccount,
        activityOwners: @escaping () throws -> [String] =
            StudySyncAccountOperations.loadActivityOwners,
        endOwnedActivities: @escaping (String) async throws -> Void =
            StudySyncAccountOperations.endActivitiesForAccount
    ) {
        self.gate = gate
        self.data = data
        self.inspectKeychain = inspectKeychain
        self.notifications = notifications
        self.flush = flush
        self.clearKeychain = clearKeychain
        self.removeOwnedNotifications = removeOwnedNotifications
        self.activityOwners = activityOwners
        self.endOwnedActivities = endOwnedActivities
    }

    /// 新規beginはblock確立だけ。所属の追認・計測停止・queue操作はしない。
    /// blockedの場合だけ専用resumeでUID/actionを再照合し、既存IDを保持する。
    func begin(uid: String, action: StudySyncAccountGate.Action) throws -> StudySyncAccountGate.Block {
        guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw StudySyncAccountGate.GateError.invalidIdentity
        }
        do {
            return try gate.beginAccount(uid: uid, action: action, validate: {})
        } catch StudySyncAccountGate.GateError.blocked {
            return try gate.resumeAccount(boundUid: uid, action: action, validateBoundIdentity: {})
        }
    }

    func inspect(
        uid: String, action: StudySyncAccountGate.Action, operationId: UUID
    ) async throws -> Inspection {
        try await gate.withAccountOperation(uid: uid, action: action, operationId: operationId) {
            try await inspectUnlocked(uid: uid).state
        }
    }

    /// strict検査とHTTP後の保存・再検査まで同じ専用leaseを保持する。
    func drain(
        uid: String, action: StudySyncAccountGate.Action, operationId: UUID
    ) async throws -> Int {
        try await gate.withAccountOperation(uid: uid, action: action, operationId: operationId) {
            let before = try await inspectUnlocked(uid: uid)
            try requireDrainable(before.state)
            guard before.state.pendingRecords else { return 0 }
            guard case .owned(let owner, let hasToken) = before.keychain,
                owner == uid, hasToken
            else { throw OperationError.missingTargetCredential }

            let sent = await flush { $0.event.uid == uid }
            let after = try await inspectUnlocked(uid: uid)
            try requireDrainable(after.state)
            guard !after.state.pendingRecords else { throw OperationError.pendingRecords }
            // 既存flushがdiscardや保存失敗を返しても同期成功の証拠にしない。
            guard sent == before.targetQueueCount else { throw OperationError.incompleteDrain }
            return sent
        }
    }

    /// exact block照合からOS await・消去・再検査まで専用leaseを保持する。
    /// HTTP・通常producer用gate・所属の追認は行わない。
    func cleanup(
        uid: String, action: StudySyncAccountGate.Action, operationId: UUID
    ) async throws {
        try await gate.withAccountOperation(uid: uid, action: action, operationId: operationId) {
            let before = try await inspectUnlocked(uid: uid)
            try requireDrainable(before.state)
            guard !before.state.pendingRecords else { throw OperationError.pendingRecords }
            let owners = try activityOwners()
            guard owners.allSatisfy({
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) else { throw OperationError.unknownOwnership }
            try Task.checkCancellation()

            try await removeOwnedNotifications(uid)
            try await endOwnedActivities(uid)
            try Task.checkCancellation()
            try data.eraseScalarsForAccountUnlocked(uid: uid)
            try clearKeychain(uid)
            try await requireErasedUnlocked(uid: uid)
            try Task.checkCancellation()
        }
    }

    /// async finishのvalidate内で検査し、block解除まで同じleaseを保持する。
    func finish(
        uid: String, action: StudySyncAccountGate.Action, operationId: UUID
    ) async throws {
        try await gate.finishAccount(
            uid: uid, action: action, operationId: operationId
        ) { () async throws -> Void in
            try await requireErasedUnlocked(uid: uid)
        }
    }

    /// caller限定契約: cloud開始前かつJS checkpoint不存在を保証した場合だけ呼ぶ。
    /// nativeではそのJS/cloud状態を推定しない。userdataを検査・消去しない。
    /// block不存在の再実行は既存gateの冪等契約に従う。
    func cancel(
        uid: String, action: StudySyncAccountGate.Action, operationId: UUID
    ) throws {
        guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw StudySyncAccountGate.GateError.invalidIdentity
        }
        try gate.cancelAccount(uid: uid, action: action, operationId: operationId, validate: {})
    }

    /// 呼出し側の専用lease内だけで使う。読み取りによる所属の追認はしない。
    private func requireErasedUnlocked(uid: String) async throws {
        let inspection = try await inspectUnlocked(uid: uid)
        try requireDrainable(inspection.state)
        guard !inspection.state.pendingRecords else { throw OperationError.pendingRecords }
        let raw = try data.inspectUnlocked()
        guard !raw.scalarOwners.values.contains(.unknown) else {
            throw OperationError.unknownOwnership
        }
        guard !raw.scalarOwners.values.contains(.owned(uid)) else {
            throw OperationError.incompleteCleanup
        }
        if case .owned(let owner, _) = inspection.keychain, owner == uid {
            throw OperationError.incompleteCleanup
        }
        for notice in try await notifications()
        where notice.identifier == Self.checkNotificationIdentifier {
            guard let owner = notice.uid,
                !owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { throw OperationError.unknownOwnership }
            guard owner != uid else { throw OperationError.incompleteCleanup }
        }
        let owners = try activityOwners()
        guard owners.allSatisfy({
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) else { throw OperationError.unknownOwnership }
        guard !owners.contains(uid) else { throw OperationError.incompleteCleanup }
    }

    private static func removeNotificationsForAccount(uid: String) async throws {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        // 両方の所有を確認してから取消する。同一IDでも別UIDの反対側は保持する。
        for request in pending + delivered.map({ $0.request })
        where request.identifier == checkNotificationIdentifier {
            guard let owner = request.content.userInfo["uid"] as? String,
                !owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { throw OperationError.unknownOwnership }
        }
        try Task.checkCancellation()
        let pendingIds = pending.filter {
            $0.identifier == checkNotificationIdentifier &&
                $0.content.userInfo["uid"] as? String == uid
        }.map { $0.identifier }
        let deliveredIds = delivered.filter {
            $0.request.identifier == checkNotificationIdentifier &&
                $0.request.content.userInfo["uid"] as? String == uid
        }.map { $0.request.identifier }
        if !pendingIds.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: pendingIds)
        }
        if !deliveredIds.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: deliveredIds)
        }
        for notice in try await loadNotifications()
        where notice.identifier == checkNotificationIdentifier {
            guard let owner = notice.uid,
                !owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { throw OperationError.unknownOwnership }
            guard owner != uid else { throw OperationError.incompleteCleanup }
        }
    }

    private static func loadActivityOwners() throws -> [String] {
        Activity<StudyActivityAttributes>.activities.filter {
            $0.activityState != .ended && $0.activityState != .dismissed
        }.map { $0.attributes.uid }
    }

    private static func endActivitiesForAccount(uid: String) async throws {
        for activity in Activity<StudyActivityAttributes>.activities
        where activity.attributes.uid == uid {
            try Task.checkCancellation()
            await activity.end(
                ActivityContent(state: activity.content.state, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }
    }

    private func requireDrainable(_ state: Inspection) throws {
        guard !state.measuring else { throw OperationError.measuring }
        guard state.ownership == "known" else { throw OperationError.unknownOwnership }
    }

    private func inspectUnlocked(uid: String) async throws -> (
        state: Inspection, keychain: StudySyncKeychain.AccountInspection?, targetQueueCount: Int
    ) {
        var known = true
        var raw: StudySyncAccountData.Inspection?
        do {
            raw = try data.inspectUnlocked()
            if raw!.scalarOwners.values.contains(.unknown) { known = false }
        } catch StudySyncAccountData.DataError.unknownOwnership {
            // 破損/legacyは保持してunknown。同期などのIO失敗はcatchせず伝える。
            known = false
        }
        var keychain: StudySyncKeychain.AccountInspection?
        do {
            keychain = try inspectKeychain()
        } catch StudySyncKeychain.AccountInspectionError.unknownOwner {
            known = false
        } catch StudySyncKeychain.AccountInspectionError.invalidData {
            known = false
        }
        for notice in try await notifications()
        where notice.identifier == Self.checkNotificationIdentifier {
            guard let owner = notice.uid,
                !owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                known = false
                continue
            }
        }
        let count = raw?.queueOwners.filter { $0 == uid }.count ?? 0
        return (
            Inspection(measuring: raw?.activeOwner != nil,
                ownership: known ? "known" : "unknown", pendingRecords: count > 0),
            keychain, count
        )
    }

    private static func loadNotifications() async throws -> [Notification] {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        return (pending + delivered.map { $0.request }).map {
            Notification(identifier: $0.identifier, uid: $0.content.userInfo["uid"] as? String)
        }
    }
}
