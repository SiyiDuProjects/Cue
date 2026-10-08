import AppKit
import SageCore

/// Native credentials and capture never enter the WebView.
@MainActor final class AppStore {
  static let serviceURL = "https://interview.siyidu.com"
  var onEvent: (JSON) -> Void = { _ in }
  var recording = ""
  var phase = "idle"
  var sourceID = UserDefaults.standard.string(forKey: "capture.source") ?? "frontmost"
  private let http = HTTPClient()
  private let capture = CaptureController()
  private var address: ServerAddress?
  private var keys: SiteCredentials?
  private var link: SocketLink?
  private var timer: Timer?
  private var audioGeneration = UUID()
  private var connectionGeneration = UUID()
  private var connecting = false
  private var closing = false
  private var cached: JSON?
  let preview: Bool
  init(preview: Bool = false) { self.preview = preview }
  func connect() async throws {
    if preview {
      onEvent([
        "type": "session_ready", "recording": "preview",
        "chats": [["id": "preview", "title": "新聊天"]], "turns": [], "images": [],
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
    let credential = try await Credentials.load(address.url.absoluteString)
    guard !closing, connectionGeneration == connectionEpoch else { return }
    guard !credential.isEmpty else { throw SageError("请在连接设置中导入此电脑的登录配置。") }
    let keys = try SiteCredentials(credential)
    http.authorizeSite(address, token: keys.site)
    let health = try await http.request(address, "/health", token: keys.device)
    guard health["capture_protocol"] as? String == protocolVersion else {
      throw SageError("服务器版本不匹配，未开启采集。")
    }
    guard !closing, connectionGeneration == connectionEpoch else { return }
    self.address = address
    self.keys = keys
    link?.close()
    let next = SocketLink(
      url: try address.socket(interview: "current", role: "interviewer"), token: keys.device,
      role: "desktop", siteToken: keys.site)
    next.onEvent = { [weak self] event in self?.event(event) }
    next.onState = { [weak self] ready, detail in
      guard let self else { return }
      if !ready {
        audioGeneration = UUID()
        phase = "idle"
        Task { _ = await self.capture.finish() }
        onEvent(["type": "disconnected", "detail": detail])
      }
    }
    next.onGap = { [weak self] in self?.onEvent(["type": "error", "detail": "连接积压，部分音频出现缺口。"]) }
    next.onExpired = { [weak self] in
      self?.onEvent(["type": "disconnected", "detail": "登录失效，请更新连接设置。"])
    }
    link = next
    next.start()
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.pump() }
    }
  }
  private func event(_ value: JSON) {
    switch value["type"] as? String {
    case "session_ready":
      recording = value["recording"] as? String ?? ""
      cached = value
      phase = "idle"
    case "state": recording = value["recording"] as? String ?? recording
    case "started": phase = "active"
    case "stopped": phase = "idle"
    case "replaced":
      audioGeneration = UUID()
      phase = "idle"
      Task { _ = await self.capture.finish() }
    default: break
    }
    onEvent(value)
  }
  private func pump(force: Bool = false) {
    guard force || phase == "active", let sink = capture.sink else { return }
    for batch in sink.takeBoth() {
      let role = batch.role
      for frame in batch.frames {
        var tagged = Data([role == "interviewer" ? 0 : 1])
        tagged.append(frame)
        link?.audio(tagged)
      }
      if batch.gap { onEvent(["type": "error", "detail": "本地音频出现缺口，请检查转录。"]) }
    }
    if let error = sink.error() {
      onEvent(["type": "error", "detail": error])
      Task { try? await self.audio(false) }
    }
  }
  func command(_ value: JSON) async throws {
    if preview {
      if value["type"] as? String == "history" {
        onEvent(["type": "history", "chat": "preview", "messages": []])
      }
      return
    }
    guard let link, link.ready else { throw SageError("连接尚未就绪。") }
    if value["type"] as? String == "ask" {
      guard !["starting", "stopping"].contains(phase) else { throw SageError("请等待音频就绪。") }
      // Drain both bounded local mailboxes into the same ordered send queue.
      // The marker enters the queue synchronously, before any actor suspension.
      pump()
      try link.enqueue(value)
      return
    }
    try await link.send(value)
  }
  func audio(_ start: Bool) async throws {
    guard !preview else { throw SageError("预览模式不会采集声音。") }
    guard let link, link.ready else { throw SageError("连接尚未就绪。") }
    if start {
      guard phase == "idle" else { return }
      let epoch = UUID()
      audioGeneration = epoch
      phase = "starting"
      do {
        try await capture.prepare()
        guard audioGeneration == epoch else { return }
        try await link.send(["type": "start"])
        for _ in 0..<300 {
          guard audioGeneration == epoch else { return }
          if phase == "active" { return }
          try await Task.sleep(for: .milliseconds(50))
        }
        throw SageError("转录启动超时。")
      } catch {
        try? await audio(false)
        throw error
      }
    } else {
      if phase == "stopping" { return }
      audioGeneration = UUID()
      phase = "stopping"
      let complete = await capture.finish()
      pump(force: true)
      try await link.send(["type": "stop"])
      for _ in 0..<240 {
        if phase == "idle" { break }
        try await Task.sleep(for: .milliseconds(50))
      }
      if phase != "idle" || !complete { onEvent(["type": "error", "detail": "音频尾句未全部确认。"]) }
      phase = "idle"
    }
  }
  func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON {
    guard let address, let keys,
      path.range(
        of: #"^/capture/(state|materials|images(/[a-zA-Z0-9_-]+)?)$"#, options: .regularExpression)
        != nil,
      ["GET", "POST", "DELETE"].contains(method)
    else { throw SageError("连接未就绪或操作无效。") }
    return try await http.request(address, path, method: method, token: keys.device, body: body)
  }
  func screenshot(_ expected: String) async throws -> JSON {
    guard !preview, expected == recording, !recording.isEmpty else { throw SageError("采集场次尚未就绪。") }
    var shot = try await capture.screenshot(source: sourceID)
    guard expected == recording else { throw SageError("采集场次已改变，截图未上传。") }
    shot["request_id"] = UUID().uuidString.lowercased()
    shot["recording"] = recording
    var result = try await request("/capture/images", method: "POST", body: shot)
    result["image_url"] = shot["image_data"]
    return result
  }
  func sources() async throws -> [JSON] {
    var choices: [JSON] = [["id": "frontmost", "name": "App Shot · 最近应用"]]
    do {
      choices += try await capture.sources().map { ["id": $0.id, "name": $0.name] }
    } catch {
      choices.append([
        "id": "unavailable", "name": "屏幕/窗口不可用（检查录屏权限）", "disabled": true,
      ])
    }
    if !choices.contains(where: { $0["id"] as? String == sourceID }) {
      choices.append(["id": sourceID, "name": "原截图来源不可用，请重新选择", "disabled": true])
    }
    return choices.map { choice in
      var value = choice
      value["selected"] = choice["id"] as? String == sourceID
      return value
    }
  }
  func selectSource(_ id: String) {
    sourceID = id
    UserDefaults.standard.set(id, forKey: "capture.source")
  }
  func uploadMaterials() async throws -> JSON {
    let panel = NSOpenPanel()
    panel.title = "选择要更新的个人资料"
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.allowedContentTypes = [.plainText]
    guard await panel.begin() == .OK else { return [:] }
    guard panel.urls.count <= 20 else { throw SageError("最多选择20份资料。") }
    let materials = try panel.urls.map { url -> JSON in
      let data = try Data(contentsOf: url)
      guard data.count <= 250000, let text = String(data: data, encoding: .utf8) else {
        throw SageError("资料必须是小于250 KB的 UTF-8 文本。")
      }
      return ["name": url.lastPathComponent, "text": text]
    }
    return try await request("/capture/materials", method: "POST", body: ["materials": materials])
  }
  func importConnection() async throws {
    guard phase == "idle" else { throw SageError("请先停止转录。") }
    let panel = NSOpenPanel()
    panel.title = "导入 Cue 连接配置"
    panel.canChooseDirectories = false
    guard await panel.begin() == .OK, let url = panel.url else { return }
    let bytes = try Data(contentsOf: url)
    guard bytes.count < 16000, let raw = String(data: bytes, encoding: .utf8) else {
      throw SageError("配置无效。")
    }
    _ = try SiteCredentials(raw)
    try await Credentials.save(raw, origin: Self.serviceURL)
    connectionGeneration = UUID()
    connecting = false
    link?.close()
    link = nil
    try await connect()
  }
  func disconnect() async {
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
