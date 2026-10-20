import Foundation
import Darwin

/// P-060: App / Pod / Widget 間で操作全体を排他する。
/// lockfile は固定し、削除・置換しない。呼出しごとに独立FDを開く。
struct StudySyncAccountGate: Sendable {
    enum Action: String, Codable, Sendable {
        case logout
        case delete
    }

    struct Block: Codable, Equatable, Sendable {
        let version: Int
        let uid: String
        let action: Action
        let operationId: UUID
    }

    enum GateError: Error {
        case unavailable
        case busy
        case blocked
        case invalidIdentity
        case invalidBlock
        case operationMismatch
        case writeVerificationFailed
        case io(Int32)
    }

    private enum Storage {
        static let lockName = "studySync.accountGate.v1.lock"
        static let blockName = "studySync.accountGate.v1.json"
        static let version = 1
    }

    private let containerURL: URL

    /// containerURL の注入は隔離テスト用。本番は既存のApp Group定数を使う。
    init(containerURL: URL? = nil) throws {
        guard let resolved = containerURL
            ?? FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier:
                    StudySyncConstants.appGroupIdentifier
            )
        else {
            throw GateError.unavailable
        }
        self.containerURL = resolved
    }

    func withNormalOperation<T>(
        _ body: () throws -> T
    ) throws -> T {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard try readBlock() == nil else {
            throw GateError.blocked
        }
        return try body()
    }

    /// HTTP・Intentの後処理を含むbody全体を渡す。
    /// await中もFDを保持し、キャンセル・throw時もdeferで解放する。
    func withNormalOperation<T>(
        _ body: () async throws -> T
    ) async throws -> T {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard try readBlock() == nil else {
            throw GateError.blocked
        }
        return try await body()
    }

    /// validateはlease内で所属・計測状態等を確認し、不成立ならthrowする。
    func beginAccount(
        uid: String,
        action: Action,
        validate: () throws -> Void
    ) throws -> Block {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard try readBlock() == nil else {
            throw GateError.blocked
        }
        guard !uid.isEmpty else {
            throw GateError.invalidIdentity
        }
        try validate()
        let block = Block(
            version: Storage.version,
            uid: uid,
            action: action,
            operationId: UUID()
        )
        try writeBlock(block)
        guard try readBlock() == block else {
            throw GateError.writeVerificationFailed
        }
        return block
    }

    /// 永続blockを毎回読み直す。operationIdを再発行しない。
    /// JS checkpointの形を変更せず、検証済みboundUidから復旧する。
    func resumeAccount(
        boundUid: String,
        action: Action,
        validateBoundIdentity: () throws -> Void
    ) throws -> Block {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard !boundUid.isEmpty else {
            throw GateError.invalidIdentity
        }
        guard let block = try readBlock(),
            block.uid == boundUid,
            block.action == action
        else {
            throw GateError.operationMismatch
        }
        try validateBoundIdentity()
        return block
    }

    /// 対象操作のdrain / cleanup専用。通常のproducerには使わない。
    /// lease解放やbody失敗で永続blockを消さない。
    func withAccountOperation<T>(
        uid: String,
        action: Action,
        operationId: UUID,
        body: () throws -> T
    ) throws -> T {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        try requireOperation(uid: uid, action: action, operationId: operationId)
        return try body()
    }

    func withAccountOperation<T>(
        uid: String,
        action: Action,
        operationId: UUID,
        body: () async throws -> T
    ) async throws -> T {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        try requireOperation(uid: uid, action: action, operationId: operationId)
        return try await body()
    }

    /// lease内で永続blockを読み直す。不存在だけnil、破損・IO失敗はthrow。
    /// 通常操作・専用操作のlease内から呼ばない（再取得はbusy）。
    func readFreshBlock() throws -> Block? {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        return try readBlock()
    }

    /// 呼出し側は、cloud開始前でcheckpointがないこと、またはcloud完了後で
    /// 対象データの消去・同期・停止確認が済んだことをvalidateで証明する。
    /// このメソッド自身がleaseを取るためwithAccountOperation内から呼ばない。
    /// block不存在の再実行でもvalidateを省略しない。
    func finishAccount(
        uid: String,
        action: Action,
        operationId: UUID,
        validate: () throws -> Void
    ) throws {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard !uid.isEmpty else {
            throw GateError.invalidIdentity
        }
        let existing = try readBlock()
        if existing != nil {
            try requireOperation(uid: uid, action: action, operationId: operationId)
        }
        try validate()
        if existing != nil {
            try FileManager.default.removeItem(at: blockURL)
        }
        guard try readBlock() == nil else {
            throw GateError.writeVerificationFailed
        }
    }

    /// 非同期OS検査からsnapshot再照合・解除まで同じ独立FDを保持する。
    /// validate失敗・キャンセル時は永続blockを保持する。
    func finishAccount(
        uid: String,
        action: Action,
        operationId: UUID,
        validate: () async throws -> Void
    ) async throws {
        let fd = try acquireLease()
        defer { _ = Darwin.close(fd) }
        guard !uid.isEmpty else {
            throw GateError.invalidIdentity
        }
        let existing = try readBlock()
        if existing != nil {
            try requireOperation(uid: uid, action: action, operationId: operationId)
        }
        try Task.checkCancellation()
        try await validate()
        try Task.checkCancellation()
        guard try readBlock() == existing else {
            throw GateError.operationMismatch
        }
        if existing != nil {
            try requireOperation(uid: uid, action: action, operationId: operationId)
            try FileManager.default.removeItem(at: blockURL)
        }
        guard try readBlock() == nil else {
            throw GateError.writeVerificationFailed
        }
    }

    /// finishと同じ所属照合・caller検証契約を使う。leasefileは消去しない。
    func cancelAccount(
        uid: String,
        action: Action,
        operationId: UUID,
        validate: () throws -> Void
    ) throws {
        try finishAccount(
            uid: uid,
            action: action,
            operationId: operationId,
            validate: validate
        )
    }

    /// 通常status専用のsnapshot。leaseのbusyを永続blockと混同しない。
    /// 操作の許可・所有確認・消去の認可には使わない。
    /// begin / drain / finishは従来どおりlease内で検証する。
    func isPersistentlyBlocked() throws -> Bool {
        try readBlock() != nil
    }

    private func requireOperation(
        uid: String,
        action: Action,
        operationId: UUID
    ) throws {
        guard let block = try readBlock(),
            block.uid == uid,
            block.action == action,
            block.operationId == operationId
        else {
            throw GateError.operationMismatch
        }
    }

    private func acquireLease() throws -> Int32 {
        let url = containerURL.appendingPathComponent(Storage.lockName)
        let fd = url.withUnsafeFileSystemRepresentation { path -> Int32 in
            guard let path else { return -1 }
            return Darwin.open(
                path,
                O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
                mode_t(S_IRUSR | S_IWUSR)
            )
        }
        guard fd >= 0 else {
            throw GateError.io(errno)
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            _ = Darwin.close(fd)
            if code == EWOULDBLOCK || code == EAGAIN {
                throw GateError.busy
            }
            throw GateError.io(code)
        }

        do {
            #if os(iOS)
            try FileManager.default.setAttributes(
                [.protectionKey:
                    FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
            #endif
            return fd
        } catch {
            _ = Darwin.close(fd)
            throw error
        }
    }

    private var blockURL: URL {
        containerURL.appendingPathComponent(Storage.blockName)
    }

    /// キャッシュやfileExists判定を使わず、実際のread結果で判断する。
    /// ファイル不存在だけをunblockedとし、破損・権限・IOエラーはthrowする。
    private func readBlock() throws -> Block? {
        let data: Data
        do {
            data = try Data(contentsOf: blockURL)
        } catch {
            let failure = error as NSError
            if failure.domain == NSCocoaErrorDomain,
                failure.code == NSFileReadNoSuchFileError {
                return nil
            }
            throw error
        }

        guard let object = try JSONSerialization.jsonObject(with: data)
            as? [String: Any],
            Set(object.keys) == Set([
                "version", "uid", "action", "operationId",
            ])
        else {
            throw GateError.invalidBlock
        }
        let block = try JSONDecoder().decode(Block.self, from: data)
        guard block.version == Storage.version, !block.uid.isEmpty else {
            throw GateError.invalidBlock
        }
        return block
    }

    private func writeBlock(_ block: Block) throws {
        let data = try JSONEncoder().encode(block)
        #if os(iOS)
        try data.write(
            to: blockURL,
            options: [
                .atomic,
                .completeFileProtectionUntilFirstUserAuthentication,
            ]
        )
        #else
        try data.write(to: blockURL, options: .atomic)
        #endif
    }
}
