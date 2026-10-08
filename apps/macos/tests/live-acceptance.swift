import Foundation
import Security

// Explicit production acceptance driver. It sends only the supplied synthetic
// PCM fixtures, never opens a microphone or screen, and never exports credentials.
// Compile with SageCore/Protocol.swift and SageCore/Transport.swift.
@MainActor final class LiveClient {
  let name: String
  var link: SocketLink!
  var raw: URLSessionWebSocketTask?
  let network = URLSession(configuration: .ephemeral)
  var events: [JSON] = []
  var answers: [String: JSON] = [:]
  var failure: String?
  var gaps = 0
  var strictConnection = false
  var disconnected = 0
  let report: (JSON) -> Void
  init(
    _ name: String, address: ServerAddress, keys: SiteCredentials, report: @escaping (JSON) -> Void
  ) throws {
    self.name = name
    self.report = report
    link = SocketLink(
      url: try address.socket(interview: "current", role: "interviewer"), token: keys.device,
      role: "desktop", siteToken: keys.site,
      connectionFactory: { [weak self] url in
        var request = URLRequest(url: url)
        request.setValue("Bearer \(keys.site)", forHTTPHeaderField: "OAI-Sites-Authorization")
        request.setValue("Bearer \(keys.device)", forHTTPHeaderField: "Authorization")
        let socket = self!.network.webSocketTask(with: request)
        self!.raw = socket
        return socket
      })
    link.onEvent = { [weak self] event in self?.receive(event) }
    link.onGap = { [weak self] in
      self?.gaps += 1
      self?.failure = "PCM queue gap"
    }
    link.onState = { [weak self] ready, _ in
      guard let self else { return }
      if !ready {
        disconnected += 1
        if strictConnection { failure = "Unexpected disconnect during soak" }
      }
      report(["client": name, "event": "connection", "ready": ready])
    }
  }
  func receive(_ event: JSON) {
    let type = event["type"] as? String ?? "unknown"
    if type == "error" { failure = event["detail"] as? String ?? "Server error" }
    if [
      "session_ready", "started", "stopped", "state", "replaced", "rotated", "chat_created",
      "history", "error",
    ].contains(type) {
      events.append(event)
      var safe: JSON = ["client": name, "event": type]
      for key in ["recording", "role", "complete", "detail"] { safe[key] = event[key] }
      report(safe)
    }
    if type == "answer", let message = event["message"] as? JSON, let id = message["id"] as? String
    {
      let old = answers[id]?["status"] as? String
      answers[id] = message
      if old != message["status"] as? String {
        report([
          "event": "answer_status", "id": id, "status": message["status"] ?? "",
          "detail": message["detail"] ?? "",
        ])
      }
    }
    if type == "transcript", let turn = event["turn"] as? JSON, turn["status"] as? String == "final"
    {
      events.append(event)
      report([
        "client": name, "event": "transcript_final", "speaker": turn["speaker"] ?? "",
        "text": turn["text"] ?? "", "id": turn["id"] ?? "",
      ])
    }
  }
  func wait(_ type: String, after: Int = 0, timeout: Double = 25) async throws -> JSON {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if let failure { throw SageError(failure) }
      if let result = events.dropFirst(after).first(where: { $0["type"] as? String == type }) {
        return result
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw SageError("Timed out waiting for \(name):\(type)")
  }
  func command(_ value: JSON, expecting type: String) async throws -> JSON {
    let index = events.count
    try await link.send(value)
    return try await wait(type, after: index)
  }
  func finals(after index: Int) -> [JSON] {
    events.dropFirst(index).compactMap { e in
      e["type"] as? String == "transcript" ? e["turn"] as? JSON : nil
    }
  }
  func close() {
    link.close()
    network.invalidateAndCancel()
  }
  func ask(chat: String, text: String, effort: String, cancel: Bool = false) async throws -> JSON {
    let id = UUID().uuidString.lowercased()
    let start = Date()
    try await link.send([
      "type": "ask", "id": id, "chat": chat, "text": text, "effort": effort, "images": [],
    ])
    var didCancel = false
    while Date().timeIntervalSince(start) < 135 {
      if let failure { throw SageError(failure) }
      if cancel && !didCancel && Date().timeIntervalSince(start) > 2 {
        didCancel = true
        try await link.send(["type": "cancel", "id": id])
      }
      if let result = answers[id], let status = result["status"] as? String,
        ["completed", "cancelled", "failed"].contains(status)
      {
        report([
          "event": "answer_result", "id": id, "chat": chat, "effort": effort,
          "seconds": Date().timeIntervalSince(start), "status": status,
          "answer": result["answer"] ?? "", "detail": result["detail"] ?? "",
        ])
        guard status == (cancel ? "cancelled" : "completed") else {
          throw SageError("Unexpected answer status: \(status)")
        }
        // Terminal publication precedes the server task's finally cleanup.
        try await Task.sleep(for: .milliseconds(250))
        return result
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw SageError("Answer timed out without a terminal state")
  }
  func chat(_ title: String) async throws -> String {
    let event = try await command(["type": "new_chat"], expecting: "chat_created")
    guard let chat = event["chat"] as? JSON, let id = chat["id"] as? String else {
      throw SageError("No chat ID")
    }
    _ = try await command(["type": "rename_chat", "chat": id, "title": title], expecting: "state")
    return id
  }
}

@main struct LiveAcceptance {
  @MainActor static func chatChecks(_ client: LiveClient, report: (JSON) -> Void) async throws {
    let longChat = try await client.chat("验收：长对话与取消")
    for round in 1...18 {
      let prompt: String
      if round == 17 {
        prompt = "这是测试。请记住最新标记：玉兰十七。只回复已记住。"
      } else if round == 18 {
        prompt = "只回复上一轮让你记住的最新标记。"
      } else {
        prompt = "这是长对话验收第\(round)轮。只回复数字\(round)。"
      }
      let answer = try await client.ask(chat: longChat, text: prompt, effort: "low")
      if round == 18 {
        guard (answer["answer"] as? String ?? "").contains("玉兰十七"),
          (answer["detail"] as? String ?? "").contains("近期上下文")
        else {
          throw SageError("Long conversation did not retain recent context or disclose truncation")
        }
      }
    }
    let history = try await client.command(
      ["type": "history", "chat": longChat], expecting: "history")
    guard (history["messages"] as? [JSON])?.count == 18 else {
      throw SageError("Long conversation history was lost")
    }
    report([
      "event": "pass_long_chat", "rounds": 18, "recent_context": true, "truncation_disclosed": true,
      "saved_history": 18,
    ])
    _ = try await client.ask(
      chat: longChat, text: "这是取消功能测试。请从1到10000逐行输出整数，每行一个。", effort: "xhigh", cancel: true)
    report(["event": "pass_cancel_while_streaming"])
    let prompt =
      "实现 Python 函数 min_window(s, t)，返回 s 中涵盖 t 全部字符的最短连续子串；重复字符按次数计算，区分大小写，t 为空或无解返回空串；同长度返回最先出现的一个。给出完整函数、简短思路和复杂度。不要读取输入、打印或使用测试框架。"
    for effort in ["low", "medium", "xhigh"] {
      let id = try await client.chat("验收：最小覆盖子串 · " + effort)
      _ = try await client.ask(chat: id, text: prompt, effort: effort)
    }
    report(["event": "pass_reasoning_samples", "efforts": ["low", "medium", "xhigh"]])
  }
  static func keys() async throws -> SiteCredentials {
    try await Task.detached {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.siyidu.sage.mac.connection",
        kSecAttrAccount as String: "https://interview.siyidu.com", kSecReturnData as String: true,
      ]
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      guard status == errSecSuccess, let data = result as? Data,
        let value = String(data: data, encoding: .utf8)
      else {
        throw SageError("Keychain access failed (\(status)); no credentials were exported")
      }
      return try SiteCredentials(value)
    }.value
  }
  @MainActor static func stream(
    _ client: LiveClient, fixtures: [Data], seconds: Double, speechAt: [Double],
    report: @escaping (JSON) -> Void
  ) async throws {
    let start = Date()
    let chunk = 9600  // 200 ms, 24 kHz PCM16.
    var nextTick = start
    var pending = speechAt.sorted()
    var offsets: [Int]? = nil
    var minute = -1
    while Date().timeIntervalSince(start) < seconds {
      if let failure = client.failure { throw SageError(failure) }
      let elapsed = Date().timeIntervalSince(start)
      if let due = pending.first, elapsed >= due {
        pending.removeFirst()
        offsets = [0, 0]
        report(["event": "fixture_begin", "elapsed": elapsed])
      }
      for role in 0...1 {
        var frame = Data([UInt8(role)])
        if let position = offsets?[role], position < fixtures[role].count {
          let end = min(position + chunk, fixtures[role].count)
          frame.append(fixtures[role][position..<end])
          frame.append(Data(count: chunk - (end - position)))
          offsets?[role] = end
        } else {
          frame.append(Data(count: chunk))
        }
        guard client.link.audio(frame) else { throw SageError("Synthetic audio was not queued") }
      }
      if Int(elapsed / 60) != minute {
        minute = Int(elapsed / 60)
        report([
          "event": "soak_progress", "elapsed": elapsed, "gaps": client.gaps,
          "rotations": client.events.filter { $0["type"] as? String == "rotated" }.count,
        ])
      }
      nextTick = nextTick.addingTimeInterval(0.2)
      let pause = nextTick.timeIntervalSinceNow
      if pause > 0 {
        try await Task.sleep(for: .seconds(pause))
      } else if pause < -2 {
        throw SageError("Local sender fell more than two seconds behind realtime")
      }
    }
  }
  @MainActor static func main() async {
    guard CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--run-live",
      let minutes = Double(CommandLine.arguments[3]), (2...70).contains(minutes)
    else {
      fputs("Usage: CueAcceptance --run-live FIXTURE_DIR MINUTES REPORT.jsonl\n", stderr)
      exit(2)
    }
    let fixtureDir = URL(fileURLWithPath: CommandLine.arguments[2])
    let path = CommandLine.arguments[4]
    guard !FileManager.default.fileExists(atPath: path) else {
      fputs("Report already exists; choose a fresh path\n", stderr)
      exit(2)
    }
    FileManager.default.createFile(
      atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    let handle = try! FileHandle(forWritingTo: URL(fileURLWithPath: path))
    let beginning = Date()
    let report: (JSON) -> Void = { value in
      var entry = value
      entry["at"] = ISO8601DateFormatter().string(from: Date())
      let line =
        try! JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) + Data([10])
      try? handle.write(contentsOf: line)
      print(String(decoding: line, as: UTF8.self), terminator: "")
      fflush(stdout)
    }
    var clients: [LiveClient] = []
    do {
      let fixtures = try ["interviewer.pcm", "candidate.pcm"].map { name in
        let data = try Data(contentsOf: fixtureDir.appendingPathComponent(name))
        guard data.count > 48000, data.count < 480000, data.count % 2 == 0 else {
          throw SageError("Invalid PCM fixture")
        }
        return data
      }
      report(["event": "keychain_wait", "microphone": false, "screen": false, "minutes": minutes])
      let credentials = try await keys()
      let address = try ServerAddress("https://interview.siyidu.com")
      let first = try LiveClient("first", address: address, keys: credentials, report: report)
      clients.append(first)
      first.link.start()
      _ = try await first.wait("session_ready")
      let state = try await first.command(["type": "new_recording"], expecting: "state")
      report(["event": "test_recording", "recording": state["recording"] ?? ""])
      _ = try await first.command(["type": "start"], expecting: "started")
      let firstSpeech = first.events.count
      try await stream(first, fixtures: fixtures, seconds: 8, speechAt: [0], report: report)
      let stopped = try await first.command(["type": "stop"], expecting: "stopped")
      guard stopped["complete"] as? Bool == true else { throw SageError("Tail commit incomplete") }
      let turns = first.finals(after: firstSpeech)
      for (role, word) in [("interviewer", "cobalt"), ("candidate", "maple")] {
        guard
          turns.contains(where: {
            $0["speaker"] as? String == role
              && ($0["text"] as? String ?? "").lowercased().contains(word)
          })
        else { throw SageError("Missing or mixed transcript for \(role)") }
      }
      report(["event": "pass_dual_channel"])
      _ = try await first.command(["type": "start"], expecting: "started")
      try await stream(first, fixtures: fixtures, seconds: 3, speechAt: [0], report: report)
      let reconnect = first.events.count
      first.raw?.cancel(with: .goingAway, reason: nil)
      _ = try await first.wait("session_ready", after: reconnect)
      try await Task.sleep(for: .seconds(4))
      guard
        !first.events.dropFirst(reconnect).contains(where: { $0["type"] as? String == "started" })
      else { throw SageError("Reconnection restarted transcription") }
      report(["event": "pass_reconnect_no_restart", "disconnected_while_recording": true])
      _ = try await first.command(["type": "start"], expecting: "started")
      let takeover = first.events.count
      let second = try LiveClient("soak", address: address, keys: credentials, report: report)
      clients.append(second)
      second.link.start()
      _ = try await second.wait("session_ready")
      _ = try await first.wait("replaced", after: takeover, timeout: 10)
      try await Task.sleep(for: .seconds(4))
      guard !first.link.ready,
        !first.events.dropFirst(takeover).contains(where: {
          $0["type"] as? String == "session_ready"
        })
      else { throw SageError("Replaced client reclaimed ownership") }
      first.close()
      report(["event": "pass_takeover_no_revival"])
      second.strictConnection = true
      _ = try await second.command(["type": "start"], expecting: "started")
      let soakStart = second.events.count
      let chatTask = Task {
        do { if minutes >= 62 { try await chatChecks(second, report: report) } } catch {
          second.failure = error.localizedDescription
          throw error
        }
      }
      defer { chatTask.cancel() }
      let speechTimes: [Double] = minutes >= 62 ? [0, 3270, 3330, 3660] : [0, minutes * 60 - 15]
      try await stream(
        second, fixtures: fixtures, seconds: minutes * 60, speechAt: speechTimes, report: report)
      try await chatTask.value
      let final = try await second.command(["type": "stop"], expecting: "stopped")
      guard final["complete"] as? Bool == true, second.gaps == 0 else {
        throw SageError("Soak ended with missing audio")
      }
      if minutes >= 62 {
        for role in ["interviewer", "candidate"] {
          guard
            second.events.dropFirst(soakStart).contains(where: {
              $0["type"] as? String == "rotated" && $0["role"] as? String == role
            })
          else { throw SageError("No real upstream rotation for \(role)") }
        }
        let lastRotation = second.events.lastIndex(where: { $0["type"] as? String == "rotated" })!
        for (role, word) in [("interviewer", "cobalt"), ("candidate", "maple")] {
          guard
            second.finals(after: lastRotation).contains(where: {
              $0["speaker"] as? String == role
                && ($0["text"] as? String ?? "").lowercased().contains(word)
            })
          else { throw SageError("Missing post-rotation speech for \(role)") }
        }
      }
      let stoppedIndex = second.events.count
      try await Task.sleep(for: .seconds(10))
      guard
        !second.events.dropFirst(stoppedIndex).contains(where: {
          $0["type"] as? String == "started" || $0["type"] as? String == "rotated"
        })
      else { throw SageError("Stopped recording revived") }
      report([
        "event": "passed", "wall_seconds": Date().timeIntervalSince(beginning),
        "soak_minutes": minutes, "gaps": second.gaps,
      ])
      clients.forEach { $0.close() }
      try? handle.close()
    } catch {
      clients.forEach { $0.close() }
      report([
        "event": "failed", "detail": error.localizedDescription,
        "wall_seconds": Date().timeIntervalSince(beginning),
      ])
      try? handle.close()
      exit(1)
    }
  }
}
