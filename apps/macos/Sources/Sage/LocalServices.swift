import AppKit
import SageCore
import Security

enum LocalFiles {
  static let root = FileManager.default.urls(
    for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(
      "SageMac", isDirectory: true)
  static func prepare() throws {
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
  }
  static func write(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

}

enum Credentials {
  static func query(_ origin: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.siyidu.sage.mac.connection",
      kSecAttrAccount as String: origin,
    ]
  }
  static func load(_ origin: String) async throws -> String {
    try await Task.detached { try read(origin) }.value
  }
  private static func read(_ origin: String) throws -> String {
    var query = query(origin)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return "" }
    guard status == errSecSuccess, let data = result as? Data,
      let text = String(data: data, encoding: .utf8)
    else { throw SageError("无法读取钥匙串中的连接凭证。") }
    return text
  }
  static func save(_ token: String, origin: String) async throws {
    try await Task.detached { try write(token, origin: origin) }.value
  }
  private static func write(_ token: String, origin: String) throws {
    let query = query(origin)
    let data = Data(token.utf8)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var value = query
      value[kSecValueData as String] = data
      value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(value as CFDictionary, nil) == errSecSuccess else {
        throw SageError("无法保存连接凭证到钥匙串。")
      }
    } else if status != errSecSuccess {
      throw SageError("无法更新钥匙串。原连接配置已保留。")
    }
  }
}
