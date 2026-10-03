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
    static func loadDrafts() throws -> [String: String] {
        let file = root.appendingPathComponent("drafts.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
    }
}

enum Credentials {
    static func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.siyidu.sage.mac.connection", kSecAttrAccount as String: origin]
    }
    static func load(_ origin: String) throws -> String {
        var query = query(origin); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else { throw SageError("无法读取钥匙串中的连接凭证。") }
        return text
    }
    static func save(_ token: String, origin: String) throws {
        let query = query(origin), data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var value = query; value[kSecValueData as String] = data
            value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(value as CFDictionary, nil) == errSecSuccess else { throw SageError("无法保存连接凭证到钥匙串。") }
        } else if status != errSecSuccess { throw SageError("无法更新钥匙串。原连接配置已保留。") }
    }
}

/// Reuses the existing tested Codex/Materials protocol host, without Electron or a browser renderer.
@MainActor final class ModelHost {
    private var process: Process?
    private var input: Pipe?
    private var loginProcess: Process?
    private var loginInput: Pipe?
    var onFailure: (String) -> Void = { _ in }
    func start(address: ServerAddress, session: Session, codex: String) throws {
        stop()
        try LocalFiles.prepare()
        guard let resources = Bundle.main.resourceURL else { throw SageError("请通过打包后的 Sage.app 启动。") }
        let binary = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/sage-node")
        let helper = resources.appendingPathComponent("bridge/host.cjs")
        guard FileManager.default.isExecutableFile(atPath: binary.path), FileManager.default.fileExists(atPath: helper.path) else {
            throw SageError("缺少本地回答桥接程序，请运行 scripts/build-app.sh 后启动 Sage.app。")
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
                self?.onFailure("本地回答连接已退出；请重新连接。")
            }
        }
        try process.run()
        self.process = process; self.input = input
        let config: JSON = ["apiBaseUrl": address.url.absoluteString, "interviewId": session.interviewID, "captureToken": session.captureToken,
                            "dataRoot": LocalFiles.root.path, "codexBin": codex]
        // Secrets travel on the private stdin pipe, never argv, environment, or logs.
        try input.fileHandleForWriting.write(contentsOf: try JSONSerialization.data(withJSONObject: config) + Data([10]))
    }
    func login(codex: String, completion: @escaping (Bool) -> Void) throws {
        guard loginProcess == nil else { throw SageError("Codex 登录已经在进行。") }
        try LocalFiles.prepare()
        guard let resources = Bundle.main.resourceURL else { throw SageError("请从 Sage.app 启动。") }
        let child = Process(), pipe = Pipe()
        child.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/sage-node")
        child.arguments = [resources.appendingPathComponent("bridge/host.cjs").path]
        child.standardInput = pipe; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        child.environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !["OPENAI_", "INTERVIEW_", "CODEX_", "HEROUI_", "GH_TOKEN", "GITHUB_TOKEN"].contains(where: { key.hasPrefix($0) })
        }
        child.terminationHandler = { [weak self] child in
            Task { @MainActor in
                self?.loginProcess = nil; try? self?.loginInput?.fileHandleForWriting.close(); self?.loginInput = nil
                completion(child.terminationStatus == 0)
            }
        }
        try child.run(); loginProcess = child; loginInput = pipe
        let config: JSON = ["action": "login", "dataRoot": LocalFiles.root.path, "codexBin": codex]
        try pipe.fileHandleForWriting.write(contentsOf: try JSONSerialization.data(withJSONObject: config) + Data([10]))
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
