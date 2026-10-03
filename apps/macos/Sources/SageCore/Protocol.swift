import Foundation

public typealias JSON = [String: Any]
public let protocolVersion = "interview-chat-v12"

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
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              let url = parts.url else { throw SageError("服务器地址必须使用 HTTPS；仅本机开发允许 HTTP。") }
        self.url = url
    }
    public func endpoint(_ path: String) -> URL { URL(string: path, relativeTo: url)!.absoluteURL }
    public func socket(interview: String, role: String) throws -> URL {
        guard !interview.isEmpty, interview.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }),
              ["client", "interviewer", "candidate", "model"].contains(role) else { throw SageError("无效连接标识。") }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        parts.scheme = url.scheme == "https" ? "wss" : "ws"
        parts.path = "/ws/interviews/\(interview)/\(role)"
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
              let capture = json["capture_token"] as? String, !capture.isEmpty else { throw SageError("服务器未返回有效会话凭证。") }
        interviewID = id; conversationID = cid; self.token = token; captureToken = capture
    }
}

public struct ChatMessage: Identifiable {
    public let id: String
    public let text: String
    public let responseID: String
    public let provider: String
    public let profile: String
    public let screens: [JSON]
    public init(_ json: JSON) {
        id = json["message_id"] as? String ?? ""
        text = json["text"] as? String ?? ""
        responseID = json["response_id"] as? String ?? "chat:\(id)"
        provider = json["provider"] as? String ?? "codex"
        profile = json["profile"] as? String ?? "default"
        screens = json["screens"] as? [JSON] ?? []
    }
}
public struct Answer {
    public var text = ""
    public var status = "streaming"
    public var detail = ""
    public var activities: [JSON] = []
    public init() {}
}

/// The server owns accepted history. Snapshots replace state; deltas never revive terminal answers.
public struct ChatState {
    public var messages: [ChatMessage] = []
    public var answers: [String: Answer] = [:]
    public var operations: [JSON] = []
    public var screens: [JSON] = []
    public var transcripts: [JSON] = []
    public var conversationID = ""
    public var title = "新对话"
    public var active = false
    public var stopping = false
    public var error: String?
    public init() {}
    public var busyID: String? {
        operations.first { $0["kind"] as? String == "chat_send" && ["accepted", "running"].contains($0["status"] as? String ?? "") }?["operation_id"] as? String
    }
    public mutating func apply(_ event: JSON) {
        let type = event["type"] as? String ?? ""
        switch type {
        case "conversation_reset":
            messages = []; answers = [:]; operations = []; screens = []; title = "新对话"
            conversationID = event["conversation_id"] as? String ?? conversationID
        case "conversation_info":
            conversationID = event["conversation_id"] as? String ?? conversationID
            title = event["title"] as? String ?? title
        case "chat_snapshot": messages = (event["messages"] as? [JSON] ?? []).map(ChatMessage.init)
        case "chat_message":
            if let json = event["chat_message"] as? JSON {
                let message = ChatMessage(json)
                if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message }
                else { messages.append(message) }
            }
        case "answer_started", "answer_snapshot", "answer_delta", "answer_completed", "answer_interrupted", "answer_error", "answer_activity":
            guard let id = event["response_id"] as? String else { return }
            var answer = answers[id] ?? Answer()
            if type == "answer_delta" {
                guard answer.status == "streaming" else { return }
                answer.text += event["delta"] as? String ?? ""
            } else if type == "answer_activity" {
                if let items = event["activities"] as? [JSON] { answer.activities = items }
                if let item = event["activity"] as? JSON {
                    if let index = answer.activities.firstIndex(where: { $0["id"] as? String == item["id"] as? String }) { answer.activities[index] = item }
                    else { answer.activities.append(item) }
                }
            } else {
                if type == "answer_started" && answers[id] != nil { return }
                answer.text = event["text"] as? String ?? answer.text
                answer.status = event["status"] as? String ?? ["answer_completed": "completed", "answer_interrupted": "interrupted", "answer_error": "error"][type] ?? "streaming"
                answer.detail = event["detail"] as? String ?? ""
                answer.activities = event["activities"] as? [JSON] ?? answer.activities
            }
            answers[id] = answer
        case "operation_snapshot": operations = event["operations"] as? [JSON] ?? []
        case "operation_status":
            if let id = event["operation_id"] as? String {
                if let index = operations.firstIndex(where: { $0["operation_id"] as? String == id }) { operations[index].merge(event) { _, new in new } }
                else { operations.append(event) }
            }
            if event["status"] as? String == "failed" { error = event["detail"] as? String }
        case "screen_collection": screens = event["screens"] as? [JSON] ?? []
        case "transcript_snapshot": transcripts = event["turns"] as? [JSON] ?? []
        case "transcript_delta", "transcript_final":
            if let id = event["turn_id"] as? String {
                if let index = transcripts.firstIndex(where: { $0["turn_id"] as? String == id }) { transcripts[index].merge(event) { _, new in new } }
                else { transcripts.append(event) }
            }
        case "interview_state": active = event["active"] as? Bool ?? false; stopping = event["stopping"] as? Bool ?? false
        case "error", "tool_error": error = event["detail"] as? String ?? "操作失败，请重试。"
        default: break
        }
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
        while bytes + frame.count > capacity, !frames.isEmpty { bytes -= frames.removeFirst().count; dropped = true }
        frames.append(frame); bytes += frame.count
    }
    public mutating func pop() -> Data? {
        guard !frames.isEmpty else { return nil }
        let frame = frames.removeFirst(); bytes -= frame.count; return frame
    }
    public mutating func takeGap() -> Bool { let value = dropped; dropped = false; return value }
}
