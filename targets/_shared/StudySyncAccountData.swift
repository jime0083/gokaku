import Foundation
import CoreFoundation

/// P-060 C1: raw所有検査と、新規scalar書込のreceiptのみを扱う。
/// 全メソッドで操作gateの保持はcallerの責任。既存値のUID追認に使わない。
struct StudySyncAccountData {
    enum Field: String, CaseIterable, Hashable {
        case currentGoalId = "studySync.currentGoalId"
        case checkEnabledSetting = "studySync.checkEnabledSetting.v1"
        case lastLockscreenStop = "studySync.lastLockscreenStop.v1"

        var receiptKey: String { "studySync.ownerReceipt.v1.\(rawValue)" }
    }

    enum Ownership: Equatable {
        case absent
        case owned(String)
        case unknown
    }

    enum DataError: Error {
        case synchronizationFailed
        case unknownOwnership
        case measuring
        case invalidIdentity
        case valueMismatch
        case writeVerificationFailed
        case pendingRecords
    }

    struct Inspection {
        let queueOwners: [String]
        let activeOwner: String?
        let scalarOwners: [Field: Ownership]
    }

    /// 隔離テストはin-memory実装を注入する。本番domainをテストから触らない。
    struct Preferences {
        let synchronize: () -> Bool
        let read: (String) -> Any?
        let write: (String, Any?) -> Void

        static var live: Preferences {
            let domain = StudySyncConstants.appGroupIdentifier as CFString
            return Preferences(
                synchronize: { CFPreferencesAppSynchronize(domain) },
                read: { CFPreferencesCopyAppValue($0 as CFString, domain) },
                write: { CFPreferencesSetAppValue($0 as CFString, $1 as CFPropertyList?, domain) }
            )
        }
    }

    static let activeSessionKey = "studySync.activeSession.v1"
    private static let receiptVersion = 1
    private let preferences: Preferences

    init(preferences: Preferences = .live) {
        self.preferences = preferences
    }

    static func invalidateOwnerReceipt(field: Field) throws {
        try Self().invalidateReceipt(field: field)
    }

    static func recordOwnerReceipt(field: Field, uid: String, value: String) throws {
        try Self().recordReceipt(field: field, uid: uid, value: value)
    }

    static func recordOwnerReceipt(field: Field, uid: String, value: Bool) throws {
        try Self().recordReceipt(field: field, uid: uid, value: value)
    }

    static func recordOwnerReceipt(field: Field, uid: String, value: Data) throws {
        try Self().recordReceipt(field: field, uid: uid, value: value)
    }

    /// sanitize loaderを介さず、rawの破損・UIDなしをエラーとして保持する。
    /// 検査は読み取りのみ。他UIDの項目も除外・変更しない。
    func inspectUnlocked() throws -> Inspection {
        try synchronize()
        var queueOwners: [String] = []
        if let raw = preferences.read(StudySyncConstants.pendingQueueKey) {
            guard let entries = raw as? [Data] else {
                throw DataError.unknownOwnership
            }
            for data in entries {
                guard let item = try? JSONDecoder().decode(StudySyncQueueItem.self, from: data),
                    Self.validIdentity(item.event.uid),
                    Self.validIdentity(item.event.sessionId),
                    Self.validIdentity(item.event.goalId),
                    Self.validIdentity(item.event.idempotencyKey),
                    item.event.clientTimeMs.isFinite,
                    item.event.action != .start || item.event.checkEnabled != nil
                else { throw DataError.unknownOwnership }
                queueOwners.append(item.event.uid)
            }
        }

        var activeOwner: String?
        if let raw = preferences.read(Self.activeSessionKey) {
            guard let data = raw as? Data,
                let active = try? JSONDecoder().decode(StudySyncActiveSession.self, from: data),
                Self.validIdentity(active.uid),
                Self.validIdentity(active.sessionId),
                Self.validIdentity(active.goalId),
                active.startAt.isFinite,
                active.confirmations.allSatisfy({ $0.isFinite })
            else { throw DataError.unknownOwnership }
            activeOwner = active.uid
        }

        var scalarOwners: [Field: Ownership] = [:]
        for field in Field.allCases {
            scalarOwners[field] = ownership(field: field)
        }
        return Inspection(
            queueOwners: queueOwners, activeOwner: activeOwner,
            scalarOwners: scalarOwners
        )
    }

    /// begin等の前提検証用。どのUIDのactiveでも計測中として拒否する。
    /// queueの同期・消去は行わない（次の単位の責務）。
    func requireKnownOwnershipUnlocked() throws {
        let inspection = try inspectUnlocked()
        guard inspection.activeOwner == nil else { throw DataError.measuring }
        guard !inspection.scalarOwners.values.contains(.unknown) else {
            throw DataError.unknownOwnership
        }
    }

    /// 専用account lease保持下だけで使う。対象UIDのscalarとreceiptだけを消す。
    /// queue/active/permission/dev timingは変更しない。IO/unknownは停止する。
    func eraseScalarsForAccountUnlocked(uid: String) throws {
        guard Self.validIdentity(uid) else { throw DataError.invalidIdentity }
        let before = try inspectUnlocked()
        guard before.activeOwner == nil else { throw DataError.measuring }
        guard !before.scalarOwners.values.contains(.unknown) else {
            throw DataError.unknownOwnership
        }
        guard !before.queueOwners.contains(uid) else { throw DataError.pendingRecords }
        for field in Field.allCases where before.scalarOwners[field] == .owned(uid) {
            preferences.write(field.rawValue, nil)
            preferences.write(field.receiptKey, nil)
            try synchronize()
            guard preferences.read(field.rawValue) == nil,
                preferences.read(field.receiptKey) == nil
            else { throw DataError.writeVerificationFailed }
        }
        let after = try inspectUnlocked()
        guard !after.scalarOwners.values.contains(.unknown) else {
            throw DataError.unknownOwnership
        }
        guard !after.scalarOwners.values.contains(.owned(uid)) else {
            throw DataError.writeVerificationFailed
        }
    }

    /// 通常の新規書込の直前に既存receiptを無効化する。raw値は触らない。
    func invalidateReceipt(field: Field) throws {
        try synchronize()
        preferences.write(field.receiptKey, nil)
        try synchronize()
        guard preferences.read(field.receiptKey) == nil else {
            throw DataError.writeVerificationFailed
        }
    }

    /// callerが明示UIDで新値を書いた直後にのみ呼ぶ。既存値の移行APIではない。
    /// Keychainや現在ログイン中のUIDから所有を推定しない。
    func recordReceipt(field: Field, uid: String, value: String) throws {
        try recordReceiptValue(field: field, uid: uid, value: value)
    }

    func recordReceipt(field: Field, uid: String, value: Bool) throws {
        try recordReceiptValue(field: field, uid: uid, value: value)
    }

    func recordReceipt(field: Field, uid: String, value: Data) throws {
        try recordReceiptValue(field: field, uid: uid, value: value)
    }

    private func recordReceiptValue(field: Field, uid: String, value: Any) throws {
        guard Self.validIdentity(uid) else { throw DataError.invalidIdentity }
        try synchronize()
        guard let raw = preferences.read(field.rawValue),
            Self.validScalar(raw, field: field),
            Self.equalScalar(raw, value, field: field)
        else { throw DataError.valueMismatch }
        preferences.write(field.receiptKey, [
            "version": Self.receiptVersion, "uid": uid, "value": value,
        ])
        try synchronize()
        guard ownership(field: field) == .owned(uid),
            let written = preferences.read(field.rawValue),
            Self.equalScalar(written, value, field: field)
        else { throw DataError.writeVerificationFailed }
    }

    private func ownership(field: Field) -> Ownership {
        let raw = preferences.read(field.rawValue)
        let receiptRaw = preferences.read(field.receiptKey)
        guard raw != nil || receiptRaw != nil else { return .absent }
        guard let raw, Self.validScalar(raw, field: field),
            let receipt = receiptRaw as? [String: Any],
            Set(receipt.keys) == Set(["version", "uid", "value"]),
            let version = receipt["version"] as? NSNumber,
            CFGetTypeID(version) == CFNumberGetTypeID(),
            version == NSNumber(value: Self.receiptVersion),
            let uid = receipt["uid"] as? String, Self.validIdentity(uid),
            let value = receipt["value"], Self.equalScalar(raw, value, field: field)
        else { return .unknown }
        return .owned(uid)
    }

    private func synchronize() throws {
        guard preferences.synchronize() else { throw DataError.synchronizationFailed }
    }

    private static func validIdentity(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func validScalar(_ raw: Any, field: Field) -> Bool {
        switch field {
        case .currentGoalId:
            guard let value = raw as? String else { return false }
            return validIdentity(value)
        case .checkEnabledSetting:
            guard let value = raw as? NSNumber else { return false }
            return CFGetTypeID(value) == CFBooleanGetTypeID()
        case .lastLockscreenStop:
            guard let data = raw as? Data,
                let stop = try? JSONDecoder().decode(StudySyncLastLockscreenStop.self, from: data)
            else { return false }
            return validIdentity(stop.sessionId) && stop.stopAt.isFinite
        }
    }

    private static func equalScalar(_ lhs: Any, _ rhs: Any, field: Field) -> Bool {
        guard validScalar(lhs, field: field), validScalar(rhs, field: field) else {
            return false
        }
        switch field {
        case .currentGoalId: return (lhs as? String) == (rhs as? String)
        case .checkEnabledSetting: return (lhs as? NSNumber) == (rhs as? NSNumber)
        case .lastLockscreenStop: return (lhs as? Data) == (rhs as? Data)
        }
    }
}
