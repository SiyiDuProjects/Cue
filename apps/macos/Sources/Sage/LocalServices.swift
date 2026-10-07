import AppKit
import Security
import SageCore

enum LocalFiles {
    static let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SageMac", isDirectory: true)
    static func prepare() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }
    static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

}

enum Credentials {
    static func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.siyidu.sage.mac.connection", kSecAttrAccount as String: origin]
    }
    static func load(_ origin: String) async throws -> String {
        try await Task.detached { try read(origin) }.value
    }
    private static func read(_ origin: String) throws -> String {
        var query = query(origin); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else { throw SageError("无法读取钥匙串中的连接凭证。") }
        return text
    }
    static func save(_ token: String, origin: String) async throws {
        try await Task.detached { try write(token, origin: origin) }.value
    }
    private static func write(_ token: String, origin: String) throws {
        let query = query(origin), data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var value = query; value[kSecValueData as String] = data
            value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(value as CFDictionary, nil) == errSecSuccess else { throw SageError("无法保存连接凭证到钥匙串。") }
        } else if status != errSecSuccess { throw SageError("无法更新钥匙串。原连接配置已保留。") }
    }
}

/// Only exposes the existing local materials directory to authenticated server requests.
@MainActor final class MaterialsHost {
    private var process: Process?
    private var input: Pipe?
    var onFailure: (String) -> Void = { _ in }
    func start(address: ServerAddress, session: Session, siteToken: String) throws {
        stop()
        try LocalFiles.prepare()
        guard let resources = Bundle.main.resourceURL else { throw SageError("请通过打包后的 Cue.app 启动。") }
        let binary = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/sage-node")
        let helper = resources.appendingPathComponent("bridge/materials-host.cjs")
        guard FileManager.default.isExecutableFile(atPath: binary.path), FileManager.default.fileExists(atPath: helper.path) else {
            throw SageError("缺少本地资料读取程序，请更新 Cue。")
        }
        let process = Process(), input = Pipe()
        process.executableURL = binary; process.arguments = [helper.path]
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        process.environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !["OPENAI_", "INTERVIEW_", "CODEX_", "HEROUI_", "GH_TOKEN", "GITHUB_TOKEN"].contains(where: { key.hasPrefix($0) })
        }
        process.terminationHandler = { [weak self] child in
            Task { @MainActor in
                guard self?.process === child else { return }
                self?.onFailure("本地资料连接已退出；请重新连接。")
            }
        }
        try process.run()
        self.process = process; self.input = input
        let config: JSON = ["apiBaseUrl": address.url.absoluteString, "siteToken": siteToken, "captureToken": session.captureToken,
                            "dataRoot": LocalFiles.root.path]
        // Secrets travel on the private stdin pipe, never argv, environment, or logs.
        try input.fileHandleForWriting.write(contentsOf: try JSONSerialization.data(withJSONObject: config) + Data([10]))
    }
    func stop() {
        let old = process; process = nil
        try? input?.fileHandleForWriting.close(); input = nil
        guard let old else { return }
        Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if old.isRunning { old.terminate() }
        }
    }
}
