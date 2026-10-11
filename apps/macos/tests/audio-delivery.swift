// Offline integration test of the real AppStore/CaptureController/AudioSink.
// Synthetic PCM and an in-memory control socket only: no devices, keys or network.
import AppKit
import AVFoundation
import SageCore

@MainActor final class ControlSocket: SocketConnection {
  var maximumMessageSize = 0
  var closeCode = URLSessionWebSocketTask.CloseCode.invalid
  /// Network latency before `started`; nil replies synchronously.
  var startedDelay: Duration?
  var sent: [JSON] = []
  private var pending: [JSON] = []
  private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
  func resume() {}
  func cancel(with code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closeCode = code
    receiver?.resume(throwing: SageError("closed")); receiver = nil
  }
  func push(_ event: JSON) {
    if let receiver {
      self.receiver = nil
      let data = try! JSONSerialization.data(withJSONObject: event)
      receiver.resume(returning: .string(String(decoding: data, as: UTF8.self)))
    } else { pending.append(event) }
  }
  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    guard case .string(let raw) = message,
      let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? JSON else { return }
    sent.append(value)
    switch value["type"] as? String {
    case "authenticate": push(["type": "session_ready", "protocol": "cue-chat-v2"])
    case "start":
      if let startedDelay {
        Task { @MainActor in
          try await Task.sleep(for: startedDelay)
          self.push(["type": "started"])
        }
      } else { push(["type": "started"]) }
    default: break
    }
  }
  func receive() async throws -> URLSessionWebSocketTask.Message {
    if !pending.isEmpty {
      return .string(String(decoding: try JSONSerialization.data(withJSONObject: pending.removeFirst()), as: UTF8.self))
    }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }
}

final class SyntheticPCM: @unchecked Sendable {
  let sink: AudioSink
  private let timer: DispatchSourceTimer
  private var expected = ["candidate": Data(), "interviewer": Data()]
  private var sequence: Int16 = 0
  init(sink: AudioSink) {
    self.sink = sink
    timer = DispatchSource.makeTimerSource(queue: sink.queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(20))
    timer.setEventHandler { [weak self] in self?.produce() }
    timer.resume()
  }
  private func produce() {
    sequence += 1
    for (role, sign) in [("candidate", Int16(1)), ("interviewer", Int16(-1))] {
      let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
      buffer.frameLength = 480
      buffer.int16ChannelData![0].initialize(repeating: sequence * sign, count: 480)
      expected[role]!.append(Data(bytes: buffer.int16ChannelData![0], count: 960))
      sink.consume(buffer, role: role)
    }
  }
  func stop() async {
    timer.cancel()
    await withCheckedContinuation { continuation in
      sink.queue.async { continuation.resume() }
    }
  }
  // Called only after stop has joined the producer queue.
  var produced: [String: Data] { expected }
}

@MainActor final class SyntheticSession: AudioCaptureSession {
  let sink: AudioSink
  let pcm: SyntheticPCM
  let stopDelay: Duration
  init(sink: AudioSink, stopDelay: Duration) {
    self.sink = sink; self.stopDelay = stopDelay
    pcm = SyntheticPCM(sink: sink)
  }
  func stop() async throws {
    try await Task.sleep(for: stopDelay)
    await pcm.stop()
  }
}

@main struct AudioDeliveryChecks {
  @MainActor static var checked = 0
  @MainActor static func require(_ ok: @autoclosure () -> Bool, _ label: String) {
    guard ok() else { fputs("FAIL \(label)\n", stderr); exit(1) }
    checked += 1
    print("PASS \(label)")
  }
  @MainActor static func scenario(_ name: String, startDelay: Duration = .zero,
      stopDelay: Duration = .zero, mode: RunLoop.Mode? = nil, overflow: Bool = false) async throws {
    guard CommandLine.arguments.count == 1 || CommandLine.arguments.dropFirst().contains(name) else { return }
    let socket = ControlSocket()
    let link = SocketLink(url: URL(string: "wss://example.invalid/capture/socket")!, token: "synthetic", role: "desktop", connectionFactory: { _ in socket })
    var session: SyntheticSession?
    let capture = CaptureController { sink, _ in
      let created = SyntheticSession(sink: sink, stopDelay: stopDelay)
      session = created
      try await Task.sleep(for: startDelay)
      return created
    }
    let store = AppStore(capture: capture, connection: link)
    var received = ["candidate": Data(), "interviewer": Data()]
    var errors: [String] = []
    var stoppedBytes = 0
    var askBytes = 0
    var prepareBytes = 0
    store.onEvent = { event in
      switch event["type"] as? String {
      case "pcm":
        let role = event["role"] as! String
        received[role]!.append(Data(base64Encoded: event["data"] as! String)!)
      case "error": errors.append(event["detail"] as? String ?? "unknown")
      case "audio_control":
        let value = event["value"] as! JSON
        if value["type"] as? String == "stop" {
          stoppedBytes = received.values.reduce(0) { $0 + $1.count }
          socket.push(["type": "stopped", "complete": true])
        } else if value["type"] as? String == "remote_prepare" {
          prepareBytes = received.values.reduce(0) { $0 + $1.count }
        } else if value["type"] as? String == "ask" {
          askBytes = received.values.reduce(0) { $0 + $1.count }
        }
      default: break
      }
    }
    for _ in 0..<100 where !link.ready { try await Task.sleep(for: .milliseconds(10)) }
    require(link.ready, "\(name): fake control socket ready")
    try await store.audio(true)
    if overflow {
      // A genuinely blocked UI thread still exceeds the bounded mailbox. Do
      // not turn real loss into a silent success while fixing run-loop pauses.
      Thread.sleep(forTimeInterval: 0.8)
    } else if let mode {
      // Use AppKit's actual tracking/modal run-loop modes with a background PCM producer.
      let keepAlive = Timer(timeInterval: 0.02, repeats: true) { _ in }
      RunLoop.main.add(keepAlive, forMode: mode)
      let end = Date().addingTimeInterval(1.2)
      while Date() < end { _ = RunLoop.main.run(mode: mode, before: end) }
      keepAlive.invalidate()
    } else { try await Task.sleep(for: .milliseconds(200)) }
    try await store.command(["type": "remote_prepare", "id": "panel", "generation": "synthetic", "images": []])
    require(prepareBytes > 0, "\(name): PCM precedes panel preparation marker")
    try await store.command(["type": "ask", "id": "synthetic"])
    require(askBytes > 0, "\(name): PCM precedes ask marker")
    try await store.audio(false)
    require(store.phase == "idle", "\(name): stop completes")
    for role in ["candidate", "interviewer"] {
      require(!received[role]!.isEmpty &&
        (overflow ? received[role]!.count < session!.pcm.produced[role]!.count : received[role] == session!.pcm.produced[role]),
        "\(name): \(role) \(overflow ? "loss detected" : "bytes complete and ordered")")
    }
    require(stoppedBytes == received.values.reduce(0) { $0 + $1.count }, "\(name): all tail PCM precedes stop marker")
    require(overflow ? errors.count == 2 && errors.contains(where: { $0.hasPrefix("麦克风") }) && errors.contains(where: { $0.hasPrefix("系统") }) : errors.isEmpty,
      "\(name): \(overflow ? "each affected stream reports a gap" : "no gap or tail error")")
    let before = received
    try await Task.sleep(for: .milliseconds(80))
    require(before == received, "\(name): no PCM after stop")
    await store.disconnect()
  }
  @MainActor static func main() {
    _ = NSApplication.shared
    Task { @MainActor in
      do {
        try await scenario("normal")
        try await scenario("slow start", startDelay: .milliseconds(900))
        try await scenario("slow stop", stopDelay: .milliseconds(900))
        try await scenario("menu and drag tracking", mode: .eventTracking)
        try await scenario("modal panel", mode: .modalPanel)
        try await scenario("real overflow", overflow: true)
        if CommandLine.arguments.count == 1 {
          try await cancelledStart()
          try await serverStopThenRestart()
          try await remoteReceipts()
        }
        print("\(checked) native audio delivery checks passed (synthetic, offline)")
        exit(0)
      } catch { fputs("FAIL \(error)\n", stderr); exit(1) }
    }
    RunLoop.main.run()
  }

  @MainActor static func remoteReceipts() async throws {
    let socket = ControlSocket()
    let link = SocketLink(url: URL(string: "wss://example.invalid/capture/socket")!, token: "synthetic", role: "desktop", connectionFactory: { _ in socket })
    var shotCalls = 0, failShot = false
    var finishShot: CheckedContinuation<JSON, Error>?
    let store = AppStore(capture: CaptureController { sink, _ in
      SyntheticSession(sink: sink, stopDelay: .zero)
    }, connection: link, screenshot: {
      shotCalls += 1
      if failShot { throw SageError("录屏权限未开启") }
      return try await withCheckedThrowingContinuation { finishShot = $0 }
    })
    let domain = "cue-test-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: domain)!
    defer { defaults.removePersistentDomain(forName: domain) }
    let model = ChatModel(store: store, defaults: defaults)
    model.allowRemote = true
    var prepared: JSON?
    var stopComplete = true
    store.onEvent = { event in
      if event["type"] as? String == "audio_control", let value = event["value"] as? JSON {
        if value["type"] as? String == "remote_prepare" { prepared = value }
        if value["type"] as? String == "stop" { socket.push(["type": "stopped", "complete": stopComplete]) }
      } else { model.handle(event) }
    }
    func wait(_ condition: () -> Bool) async throws {
      for _ in 0..<200 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
      }
      throw SageError("Native remote test timed out")
    }
    try await wait { link.ready }
    model.handle(["type": "session_ready", "remote": true, "generation": "native-test", "chats": [["id": "chat"]]])
    func command(_ id: String, _ type: String, generation: String = "native-test", expires: Double = Date().timeIntervalSince1970 * 1000 + 15000) {
      model.handle(["type": "remote_command", "command": ["id": id, "type": type, "generation": generation, "expires": expires]])
    }
    func receipt(_ id: String) -> JSON? { socket.sent.first { $0["type"] as? String == "remote_result" && $0["id"] as? String == id } }
    command("old", "shot", generation: "old")
    command("expired", "shot", expires: 0)
    try await wait { receipt("expired") != nil }
    require(shotCalls == 0 && receipt("expired")?["ok"] as? Bool == false, "native remote: stale and expired commands do not capture")
    command("shot", "shot")
    try await wait { finishShot != nil }
    require(receipt("shot") == nil, "native remote: no screenshot success before upload completes")
    command("busy", "prepare")
    try await wait { receipt("busy") != nil }
    require(receipt("busy")?["ok"] as? Bool == false, "native remote: pending screenshot blocks preparation")
    finishShot!.resume(returning: ["id": "synthetic-shot", "created": Date().timeIntervalSince1970 * 1000])
    try await wait { receipt("shot") != nil }
    require(receipt("shot")?["ok"] as? Bool == true && receipt("shot")?["image"] as? String == "synthetic-shot", "native remote: success identifies the saved screenshot")
    failShot = true
    command("failure", "shot")
    try await wait { receipt("failure") != nil }
    require(receipt("failure")?["ok"] as? Bool == false && (receipt("failure")?["detail"] as? String ?? "").contains("录屏权限"), "native remote: screenshot failure is acknowledged")
    command("prepare", "prepare")
    try await wait { prepared != nil }
    require(prepared?["images"] as? [String] == ["synthetic-shot"] && receipt("prepare") == nil, "native remote: preparation goes through ordered audio and awaits server completion")
    command("start", "start")
    try await wait { receipt("start") != nil }
    require(receipt("start")?["ok"] as? Bool == true && model.audio == "active", "native remote: start confirmed after synthetic devices start")
    command("stop", "stop")
    try await wait { receipt("stop") != nil }
    require(receipt("stop")?["ok"] as? Bool == true && model.audio == "idle", "native remote: stop confirmed after drain")
    command("start-again", "start")
    try await wait { receipt("start-again") != nil }
    stopComplete = false
    command("stop-failed", "stop")
    try await wait { receipt("stop-failed") != nil }
    require(receipt("stop-failed")?["ok"] as? Bool == false, "native remote: incomplete stop reports failure")
    model.allowRemote = false
    command("disabled", "shot")
    try await wait { receipt("disabled") != nil }
    require(receipt("disabled")?["ok"] as? Bool == false && shotCalls == 2, "native remote: disabled control reports failure without capture")
    await store.disconnect()
  }

  /// A server-ended recording (upstream failure, replacement) is never drained
  /// by the client, so its mailbox keeps a tail. The next start's prepared-phase
  /// drain must not forward that old audio into the new upstreams.
  @MainActor static func serverStopThenRestart() async throws {
    let socket = ControlSocket()
    // With real latency the start loop is asleep when `started` arrives, so the
    // drain timer runs in prepared before the new mailbox is published.
    socket.startedDelay = .milliseconds(10)
    let link = SocketLink(url: URL(string: "wss://example.invalid/capture/socket")!, token: "synthetic", role: "desktop", connectionFactory: { _ in socket })
    var sessions: [SyntheticSession] = []
    let capture = CaptureController { sink, _ in
      let created = SyntheticSession(sink: sink, stopDelay: .milliseconds(60))
      sessions.append(created)
      return created
    }
    let store = AppStore(capture: capture, connection: link)
    var received = ["candidate": Data(), "interviewer": Data()]
    store.onEvent = { event in
      switch event["type"] as? String {
      case "pcm":
        let role = event["role"] as! String
        received[role]!.append(Data(base64Encoded: event["data"] as! String)!)
      case "audio_control":
        if (event["value"] as? JSON)?["type"] as? String == "stop" {
          socket.push(["type": "stopped", "complete": true])
        }
      default: break
      }
    }
    for _ in 0..<100 where !link.ready { try await Task.sleep(for: .milliseconds(10)) }
    try await store.audio(true)
    try await Task.sleep(for: .milliseconds(200))
    socket.push(["type": "stopped", "complete": false])
    for _ in 0..<100 where store.phase != "idle" { try await Task.sleep(for: .milliseconds(10)) }
    // Native stop (60 ms) finishes while the old producer keeps writing its tail.
    try await Task.sleep(for: .milliseconds(200))
    require(store.phase == "idle" && !capture.isPrepared, "server stop: capture idle without a client drain")
    received = ["candidate": Data(), "interviewer": Data()]
    try await store.audio(true)
    try await Task.sleep(for: .milliseconds(200))
    try await store.audio(false)
    require(sessions.count == 2, "server stop then restart: second native session started")
    for role in ["candidate", "interviewer"] {
      require(!received[role]!.isEmpty && received[role] == sessions[1].pcm.produced[role],
        "server stop then restart: \(role) carries only the new recording")
    }
    await store.disconnect()
  }

  @MainActor static func cancelledStart() async throws {
    let socket = ControlSocket()
    let link = SocketLink(url: URL(string: "wss://example.invalid/capture/socket")!, token: "synthetic", role: "desktop", connectionFactory: { _ in socket })
    var session: SyntheticSession?
    let capture = CaptureController { sink, _ in
      let created = SyntheticSession(sink: sink, stopDelay: .zero)
      session = created
      try await Task.sleep(for: .milliseconds(350))
      return created
    }
    let store = AppStore(capture: capture, connection: link)
    var started = 0
    var delivered = 0
    store.onEvent = { event in
      if event["type"] as? String == "started" { started += 1 }
      if event["type"] as? String == "pcm" { delivered += 1 }
      if event["type"] as? String == "audio_control",
        (event["value"] as? JSON)?["type"] as? String == "stop" {
        socket.push(["type": "stopped", "complete": true])
      }
    }
    for _ in 0..<100 where !link.ready { try await Task.sleep(for: .milliseconds(10)) }
    let pending = Task { try await store.audio(true) }
    for _ in 0..<100 where session == nil { try await Task.sleep(for: .milliseconds(10)) }
    try await store.audio(false)
    _ = try? await pending.value
    require(started == 0 && store.phase == "idle", "cancel during start: late completion cannot restart audio")
    require(!capture.isPrepared, "cancel during start: native session stopped")
    let before = delivered
    try await Task.sleep(for: .milliseconds(100))
    require(before == delivered, "cancel during start: no late PCM is forwarded")
    await store.disconnect()
  }
}
