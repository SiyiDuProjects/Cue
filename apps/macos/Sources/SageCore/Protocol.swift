import Foundation

public typealias JSON = [String: Any]
public let protocolVersion = "cue-chat-v2"

public struct SageError: LocalizedError {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }
}

public struct ServerAddress: Equatable {
  public let url: URL
  public init(_ text: String) throws {
    guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = parts.host?.lowercased(), !host.isEmpty,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.path.isEmpty || parts.path == "/",
      parts.scheme == "https"
        || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
      let url = parts.url
    else { throw SageError("服务器地址必须使用 HTTPS；仅本机开发允许 HTTP。") }
    self.url = url
  }
  public func endpoint(_ path: String) -> URL { URL(string: path, relativeTo: url)!.absoluteURL }
  public func socket(interview: String, role: String) throws -> URL {
    guard !interview.isEmpty,
      interview.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
      ),
      ["interviewer", "candidate"].contains(role)
    else { throw SageError("无效连接标识。") }
    var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    parts.scheme = url.scheme == "https" ? "wss" : "ws"
    parts.path = "/capture/socket"
    return parts.url!
  }
}

public struct Session {
  public let interviewID: String
  public var conversationID: String
  public let token: String
  public let captureToken: String
  public init(_ json: JSON) throws {
    guard let id = json["interview_id"] as? String, !id.isEmpty,
      let cid = json["conversation_id"] as? String, !cid.isEmpty,
      let token = json["session_token"] as? String, !token.isEmpty,
      let capture = json["capture_token"] as? String, !capture.isEmpty
    else { throw SageError("服务器未返回有效会话凭证。") }
    interviewID = id
    conversationID = cid
    self.token = token
    captureToken = capture
  }
}

/// Both connection credentials remain in Keychain, never in the app bundle or URL.
public struct SiteCredentials {
  public let site: String
  public let device: String
  public init(_ text: String) throws {
    let bytes = text.hasPrefix("{") ? Data(text.utf8) : Data(base64Encoded: text)
    guard let bytes, let value = try? JSONSerialization.jsonObject(with: bytes) as? JSON,
      let site = value["site"] as? String, !site.isEmpty,
      let device = value["device"] as? String, !device.isEmpty,
      !site.contains(where: { $0.isNewline }), !device.contains(where: { $0.isNewline })
    else { throw SageError("登录凭证格式无效，请重新配置 Cue。") }
    self.site = site
    self.device = device
  }
}

public struct CaptureState {
  public var screens: [JSON] = []
  public var transcripts: [JSON] = []
  public var conversationID = ""
  public var active = false
  public var stopping = false
  public init() {}
  public mutating func merge(_ turn: JSON) {
    guard let id = turn["id"] as? String ?? turn["turn_id"] as? String else { return }
    var value = turn
    value["turn_id"] = id
    if let index = transcripts.firstIndex(where: { $0["turn_id"] as? String == id }) {
      guard (value["revision"] as? Int ?? 0) >= (transcripts[index]["revision"] as? Int ?? 0) else {
        return
      }
      transcripts[index] = value
    } else {
      transcripts.append(value)
    }
    transcripts.sort { ($0["created"] as? Double ?? 0) < ($1["created"] as? Double ?? 0) }
  }
}

/// Exactly half a second of mono 24 kHz, 16-bit PCM. Overflow drops oldest frames.
public struct PCMQueue {
  public let capacity: Int
  public private(set) var bytes = 0
  public private(set) var dropped = false
  private var frames: [Data] = []
  public init(capacity: Int = 24_000) { self.capacity = capacity }
  public mutating func append(_ data: Data) {
    guard !data.isEmpty else { return }
    let frame = Data(data.suffix(capacity - capacity % 2))
    if frame.count < data.count { dropped = true }
    while bytes + frame.count > capacity, !frames.isEmpty {
      bytes -= frames.removeFirst().count
      dropped = true
    }
    frames.append(frame)
    bytes += frame.count
  }
  public mutating func pop() -> Data? {
    guard !frames.isEmpty else { return nil }
    let frame = frames.removeFirst()
    bytes -= frame.count
    return frame
  }
  public mutating func takeGap() -> Bool {
    let value = dropped
    dropped = false
    return value
  }
}
