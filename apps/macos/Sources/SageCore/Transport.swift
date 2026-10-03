import Foundation

/// Never forward host credentials through redirects or store HTTP responses on disk.
public final class HTTPClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private lazy var session: URLSession = {
        let config = configuration
        config.urlCache = nil; config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    public override init() { configuration = .ephemeral; super.init() }
    public init(configuration: URLSessionConfiguration) { self.configuration = configuration; super.init() }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    public func request(_ address: ServerAddress, _ path: String, method: String = "GET", token: String = "", body: JSON? = nil) async throws -> JSON {
        var request = URLRequest(url: address.endpoint(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw SageError("无效服务器响应。") }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
        guard (200..<300).contains(response.statusCode) else {
            throw SageError(json["detail"] as? String ?? "请求失败（\(response.statusCode)）。")
        }
        return json
    }
}

/// Small transport boundary enables offline timing tests without opening network ports.
@MainActor public protocol SocketConnection: AnyObject {
    var maximumMessageSize: Int { get set }
    var closeCode: URLSessionWebSocketTask.CloseCode { get }
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
}
extension URLSessionWebSocketTask: SocketConnection {}

@MainActor public final class SocketLink {
    public private(set) var ready = false
    public var onEvent: (JSON) -> Void = { _ in }
    public var onState: (Bool, String) -> Void = { _, _ in }
    public var onExpired: () -> Void = {}
    public var onGap: () -> Void = {}
    private let url: URL
    private let token: String
    private let role: String
    private let network = URLSession(configuration: .ephemeral)
    private var socket: (any SocketConnection)?
    private let connectionFactory: ((URL) -> any SocketConnection)?
    private var runner: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var stopped = false
    private var frames: [(URLSessionWebSocketTask.Message, CheckedContinuation<Void, Error>?)] = []
    private var queuedBytes = 0
    public init(url: URL, token: String, role: String, connectionFactory: ((URL) -> any SocketConnection)? = nil) { self.url = url; self.token = token; self.role = role; self.connectionFactory = connectionFactory }
    public func start() {
        guard runner == nil else { return }
        runner = Task { [weak self] in await self?.run() }
    }
    public func close() {
        stopped = true; ready = false; runner?.cancel(); runner = nil; sender?.cancel(); sender = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        failQueue(); network.invalidateAndCancel()
    }
    private func run() async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            let current: any SocketConnection = connectionFactory?(url) ?? network.webSocketTask(with: url)
            current.maximumMessageSize = 64 * 1024 * 1024
            socket = current; current.resume()
            let timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if !Task.isCancelled && self?.ready != true { current.cancel(with: .goingAway, reason: nil) }
            }
            var heartbeat: Task<Void, Never>?
            do {
                let auth: JSON = ["type": "authenticate", "token": token, "browser_connections": role == "interviewer"]
                try await current.send(.string(String(data: try JSONSerialization.data(withJSONObject: auth), encoding: .utf8)!))
                var lastMessage = Date()
                heartbeat = Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 10_000_000_000)
                        guard !Task.isCancelled else { return }
                        if Date().timeIntervalSince(lastMessage) > 25 { current.cancel(with: .goingAway, reason: nil); return }
                        try? await current.send(.string("{\"type\":\"ping\"}"))
                    }
                }
                while !stopped && !Task.isCancelled {
                    let frame = try await current.receive()
                    lastMessage = Date()
                    guard socket === current else { break }
                    let data: Data
                    switch frame { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: continue }
                    guard let event = try JSONSerialization.jsonObject(with: data) as? JSON else { throw SageError("无效实时消息。") }
                    if event["type"] as? String == "session_ready" {
                        guard event["realtime_protocol"] as? String == protocolVersion,
                              role != "client" || (event["chat"] as? Bool == true && event["pinned_code"] as? Bool == false) else {
                            onState(false, "服务器协议不兼容，请更新至 interview-chat-v12。")
                            stopped = true; throw SageError("服务器协议不兼容，请更新至 interview-chat-v12。")
                        }
                        ready = true; attempt = 0; timeout.cancel(); onState(true, "已连接")
                    }
                    onEvent(event)
                }
            } catch {
                if !stopped { onState(false, error is SageError ? error.localizedDescription : "连接中断，正在恢复；未自动重发消息。") }
            }
            timeout.cancel(); heartbeat?.cancel(); ready = false
            sender?.cancel(); sender = nil; failQueue()
            let expired = current.closeCode == .policyViolation
            current.cancel(with: .goingAway, reason: nil)
            if expired && !stopped { stopped = true; onExpired(); return }
            if stopped || Task.isCancelled { return }
            attempt += 1
            try? await Task.sleep(nanoseconds: UInt64(min(attempt * 2, 15)) * 1_000_000_000)
        }
    }
    public func send(_ json: JSON) async throws {
        guard ready, !stopped else { throw SageError("连接尚未就绪，请稍后重试。") }
        guard frames.count < 100 else { throw SageError("连接积压，请稍后重试。") }
        let text = String(data: try JSONSerialization.data(withJSONObject: json), encoding: .utf8)!
        try await withCheckedThrowingContinuation { continuation in
            frames.append((.string(text), continuation)); drain()
        }
    }
    @discardableResult public func audio(_ data: Data) -> Bool {
        guard ready, !stopped else { onGap(); return false }
        var complete = true
        while queuedBytes + data.count > 24_000 {
            guard let index = frames.firstIndex(where: { if case .data = $0.0 { return true }; return false }) else { break }
            if case .data(let old) = frames.remove(at: index).0 { queuedBytes -= old.count }
            complete = false; onGap()
        }
        guard data.count <= 24_000 else { onGap(); return false }
        frames.append((.data(data), nil)); queuedBytes += data.count; drain()
        return complete
    }
    private func drain() {
        guard sender == nil, let current = socket else { return }
        sender = Task { [weak self] in
            guard let self else { return }
            while !frames.isEmpty && !Task.isCancelled && socket === current {
                let (message, continuation) = frames.removeFirst()
                if case .data(let data) = message { queuedBytes -= data.count }
                do { try await current.send(message); continuation?.resume() }
                catch { continuation?.resume(throwing: SageError("发送未确认，请检查重连后的记录再重试。")); current.cancel(with: .goingAway, reason: nil); break }
            }
            if socket === current { sender = nil }
        }
    }
    private func failQueue() {
        for (_, continuation) in frames { continuation?.resume(throwing: SageError("连接中断，发送未确认。")) }
        frames = []; queuedBytes = 0
    }
}
