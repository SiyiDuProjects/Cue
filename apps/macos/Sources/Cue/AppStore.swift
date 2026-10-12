import AppKit
import OSLog
import CueCore

/// Device credentials stay native; PCM and ephemeral ASR tokens enter the local WebView.
@MainActor final class AppStore {
  static let serviceURL = "https://cue.siyidu.com"
  var onEvent: (JSON) -> Void = { _ in }
  var phase = "idle"
  private var stopComplete = false
  private let http = HTTPClient()
  private let capture: CaptureController
  private let screenshotProvider: (() async throws -> JSON)?
  private let uploadProvider: ((JSON) async throws -> JSON)?
  private var address: ServerAddress?
  private var keys: SiteCredentials?
  private var link: SocketLink?
  private var timer: Timer?
  private var remotePoll: Task<Void, Never>?
  private var remoteEpoch = UUID()
  private var lastPump = ContinuousClock.now
  private let audioLog = Logger(subsystem: "com.siyidu.cue.mac", category: "AudioDelivery")
  private var audioGeneration = UUID()
  private var connectionGeneration = UUID()
  private var connecting = false
  private var closing = false
  private var cached: JSON?
  let preview: Bool
  init(
    preview: Bool = false, capture: CaptureController? = nil,
    connection: SocketLink? = nil, screenshot: (() async throws -> JSON)? = nil,
    upload: ((JSON) async throws -> JSON)? = nil
  ) {
    self.preview = preview
    self.capture = capture ?? CaptureController()
    self.screenshotProvider = screenshot
    self.uploadProvider = upload
    if let connection { attach(connection) }
  }
  func connect() async throws {
    if preview {
      onEvent([
        "type": "session_ready",
        "chats": [["id": "preview", "title": "新聊天"]],
      ])
      return
    }
    if link?.ready == true, let cached {
      onEvent(cached)
      return
    }
    guard !connecting else { return }
    connecting = true
    let connectionEpoch = connectionGeneration
    defer { if connectionGeneration == connectionEpoch { connecting = false } }
    let address = try ServerAddress(Self.serviceURL)
    let keys: SiteCredentials
    if let loaded = self.keys {
      keys = loaded  // A manual reconnect does not need another Keychain read.
    } else {
      let credential = try await Credentials.load()
      guard !closing, connectionGeneration == connectionEpoch else { return }
      guard !credential.isEmpty else { throw CueError("请在连接设置中导入此电脑的登录配置。") }
      keys = try SiteCredentials(credential)
      self.keys = keys
    }
    http.authorizeSite(address, token: keys.site)
    let health = try await http.request(address, "/health", token: keys.device)
    guard health["capture_protocol"] as? String == protocolVersion else {
      throw CueError("服务器版本不匹配，未开启采集。")
    }
    guard !closing, connectionGeneration == connectionEpoch else { return }
    self.address = address
    self.keys = keys
    link?.close()
    let next = SocketLink(
      url: address.socket(), token: keys.device,
      role: "desktop", siteToken: keys.site)
    attach(next)
  }
  private func attach(_ next: SocketLink) {
    next.onEvent = { [weak self] event in self?.event(event) }
    next.onState = { [weak self] ready, detail in
      guard let self else { return }
      if !ready {
        stopRemotePoll()
        audioGeneration = UUID()
        phase = "idle"
        Task { _ = await self.capture.finish() }
        onEvent(["type": "disconnected", "detail": detail])
      }
    }
    next.onExpired = { [weak self] in
      self?.onEvent(["type": "disconnected", "detail": "登录失效，请更新连接设置。"])
    }
    link = next
    next.start()
    timer?.invalidate()
    let timer = Timer(timeInterval: 0.02, repeats: true) { [weak self] _ in
      // AppKit keeps common-mode timers running while tracking menus/drags.
      // Run inline on the main run loop; an extra Task can wait behind tracking.
      MainActor.assumeIsolated { self?.pump() }
    }
    self.timer = timer
    RunLoop.main.add(timer, forMode: .common)
  }
  private func event(_ value: JSON) {
    switch value["type"] as? String {
    case "session_ready":
      cached = value
      stopRemotePoll()
      // Web commands are claimed over HTTPS while the page is open.
      if let generation = value["generation"] as? String {
        startRemotePoll(generation)
      }
      phase = "idle"
    case "started":
      phase = "prepared"
      return  // Publish only after the native devices have actually started.
    case "stopped":
      stopComplete = value["complete"] as? Bool == true
      audioGeneration = UUID()
      phase = "idle"
      Task { _ = await self.capture.finish() }
    case "replaced":
      stopRemotePoll()
      audioGeneration = UUID()
      phase = "idle"
      Task { _ = await self.capture.finish() }
    default: break
    }
    onEvent(value)
  }
  private func stopRemotePoll() {
    remoteEpoch = UUID()
    remotePoll?.cancel()
    remotePoll = nil
  }
  private func startRemotePoll(_ generation: String) {
    let epoch = remoteEpoch
    remotePoll = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled, remoteEpoch == epoch, link?.ready == true {
        var delay = 3000
        do {
          let reply = try await request("/capture/remote", method: "POST", body: ["generation": generation])
          guard !Task.isCancelled, remoteEpoch == epoch, link?.ready == true else { return }
          let present = reply["connected"] as? Bool == true
          delay = present ? 500 : 3000
          onEvent(["type": "remote", "connected": present])
          for command in reply["commands"] as? [JSON] ?? [] { onEvent(["type": "remote_command", "command": command]) }
        } catch { /* Only unclaimed commands may be returned on a later request. */ }
        try? await Task.sleep(for: .milliseconds(delay))
      }
    }
  }
  private func pump(force: Bool = false) {
    // Upstreams are ready in prepared; native capture may already be producing
    // while startCapture/stopCapture is suspended. Drain until the final barrier.
    guard force || ["prepared", "active", "stopping"].contains(phase), let sink = capture.sink
    else { return }
    let now = ContinuousClock.now
    let elapsed = lastPump.duration(to: now).components
    let delayMS = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
    lastPump = now
    for batch in sink.takeBoth() {
      let role = batch.role
      for frame in batch.frames {
        onEvent(["type": "pcm", "role": role, "data": frame.base64EncodedString()])
      }
      if batch.droppedBytes > 0 {
        let missingMS = Double(batch.droppedBytes) / 48
        audioLog.error(
          "PCM overflow role=\(role, privacy: .public) phase=\(self.phase, privacy: .public) dropped_ms=\(missingMS) drain_interval_ms=\(delayMS)"
        )
        let name = role == "candidate" ? "麦克风" : "系统"
        onEvent(["type": "error", "detail": "\(name)音频出现缺口，请检查转录。"])
      }
    }
    if let error = sink.error() {
      onEvent(["type": "error", "detail": error])
      Task { try? await self.audio(false) }
    }
  }
  func forwardTranscription(_ value: JSON) throws {
    guard let link, link.ready else { throw CueError("连接尚未就绪。") }
    try link.enqueue(value)
  }
  func command(_ value: JSON) async throws {
    if preview {
      if value["type"] as? String == "history" {
        // A synthetic exchange so --preview shows real answer layout offline.
        let answer =
          "## 思路\n\n用 **哈希表** 记录出现过的数，一次遍历。\n\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:\n            return [seen[target - x], i]\n        seen[x] = i\n```\n\n时间 $O(n)$，空间 $O(n)$。"
        onEvent([
          "type": "history", "chat": "preview",
          "messages": [
            [
              "id": "preview-intro", "chat": "preview", "text": "", "status": "completed",
              "answer": "先用一句话概括背景，再讲一个最能体现能力的项目。", "detail": "", "context": "{}",
            ],
            [
              "id": "preview", "chat": "preview", "text": "两数之和怎么做？", "answer": answer,
              "status": "completed", "detail": "", "context": "{}",
            ],
          ],
        ])
      }
      return
    }
    guard let link, link.ready else { throw CueError("连接尚未就绪。") }
    if value["type"] as? String == "asr_forward", let message = value["message"] as? JSON {
      try link.enqueue(message)
      return
    }
    if value["type"] as? String == "ask" {
      guard !["starting", "prepared", "stopping"].contains(phase) else {
        throw CueError("请等待音频就绪。")
      }
      // PCM and its marker enter WebKit in native order; the shared client
      // commits both OpenAI streams before sending the ordered ask to Sites.
      pump()
      onEvent(["type": "audio_control", "value": value])
      return
    }
    try await link.send(value)
  }
  func audio(_ start: Bool) async throws {
    guard !preview else { throw CueError("预览模式不会采集声音。") }
    guard let link, link.ready else { throw CueError("连接尚未就绪。") }
    if start {
      guard phase == "idle" else { throw CueError("转录已开启或正在收尾。") }
      capture.discardFinishedSink()
      let epoch = UUID()
      audioGeneration = epoch
      lastPump = .now
      phase = "starting"
      do {
        guard audioGeneration == epoch else { throw CueError("转录启动已取消。") }
        try await link.send(["type": "start"])
        for _ in 0..<300 {
          guard audioGeneration == epoch else { throw CueError("转录启动已取消。") }
          if phase == "prepared" {
            try await capture.prepare()
            guard audioGeneration == epoch else {
              _ = await capture.finish()
              throw CueError("转录启动已取消。")
            }
            phase = "active"
            onEvent(["type": "started"])
            return
          }
          try await Task.sleep(for: .milliseconds(50))
        }
        throw CueError("转录启动超时。")
      } catch {
        if audioGeneration == epoch { try? await audio(false) }
        throw error
      }
    } else {
      if phase == "stopping" { throw CueError("转录正在收尾。") }
      audioGeneration = UUID()
      phase = "stopping"
      stopComplete = false
      let complete = await capture.finish()
      pump(force: true)
      onEvent(["type": "audio_control", "value": ["type": "stop"]])
      for _ in 0..<240 {
        if phase == "idle" { break }
        try await Task.sleep(for: .milliseconds(50))
      }
      let confirmed = phase == "idle" && complete && stopComplete && link.ready
      phase = "idle"
      if !confirmed { throw CueError("音频尾句未全部确认。") }
    }
  }
  func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON {
    guard let address, let keys,
      path.range(
        of: #"^/capture/(state|remote|images(/[a-zA-Z0-9_-]+)?)$"#, options: .regularExpression)
        != nil,
      ["GET", "POST"].contains(method)
    else { throw CueError("连接未就绪或操作无效。") }
    return try await http.request(address, path, method: method, token: keys.device, body: body)
  }
  func screenshot() async throws -> JSON {
    if let screenshotProvider { return try await screenshotProvider() }
    guard !preview else { throw CueError("预览模式不会截图。") }
    var shot = try await capture.screenshot()
    try Task.checkCancellation()
    shot["request_id"] = UUID().uuidString.lowercased()
    return shot
  }
  func uploadShot(_ shot: JSON) async throws -> JSON {
    if let uploadProvider { return try await uploadProvider(shot) }
    var result = try await request("/capture/images", method: "POST", body: shot)
    result["image_url"] = shot["image_data"]
    return result
  }
  func importConnection() async throws {
    guard phase == "idle" else { throw CueError("请先停止转录。") }
    let panel = NSOpenPanel()
    panel.title = "导入 Cue 连接配置"
    panel.canChooseDirectories = false
    guard await panel.begin() == .OK, let url = panel.url else { return }
    let bytes = try Data(contentsOf: url)
    guard bytes.count < 16000, let raw = String(data: bytes, encoding: .utf8) else {
      throw CueError("配置无效。")
    }
    let imported = try SiteCredentials(raw)
    try await Credentials.save(raw)
    keys = imported
    connectionGeneration = UUID()
    connecting = false
    link?.close()
    link = nil
    try await connect()
  }
  func disconnect() async {
    stopRemotePoll()
    if closing { return }
    closing = true
    connectionGeneration = UUID()
    connecting = false
    if phase != "idle" { try? await audio(false) }
    timer?.invalidate()
    timer = nil
    link?.close()
    link = nil
    _ = await capture.finish()
  }
}
