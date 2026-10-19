import AppKit
import Combine
import CueCore

/// One interviewer utterance from the page's local transcription stream.
struct Caption: Identifiable {
  let id: String
  var text: String
  let at: Date
}
/// Native chat state. It consumes the same server events the answer view
/// receives; the answer view only renders messages this model sends it.
@MainActor final class ChatModel: ObservableObject {
  @Published var connected = false
  @Published var status = "正在连接…"
  @Published var error = ""
  /// Answers are one timeline, the last hour, like transcripts. This is the
  /// server row new answers are stored under: the newest chat, never shown.
  private var chat = ""
  @Published private(set) var messages: [JSON] = []
  @Published var selected: [String] = []
  @Published private(set) var previews: [String: NSImage] = [:]
  @Published var text = UserDefaults.standard.string(forKey: "cue.draft") ?? "" {
    didSet { if persist { defaults.set(text, forKey: "cue.draft") } }
  }
  @Published private(set) var audio = "idle"
  @Published private(set) var audioSince: Date?
  @Published private(set) var working = false
  @Published private(set) var pending = ""
  @Published private(set) var uploading = 0
  @Published private(set) var uploadError = ""
  private var uploads: [JSON] = []
  private var captureTail: Task<Void, Never>?
  private var captureIDs: [String] = []
  private var uploadTask: Task<Void, Never>?
  @Published var effort = UserDefaults.standard.string(forKey: "cue.effort") ?? "" {
    didSet { if persist { defaults.set(effort, forKey: "cue.effort") } }
  }
  /// The answer card under the control bar; asking opens it.
  @Published var expanded = false
  @Published var captionsOn = UserDefaults.standard.object(forKey: "cue.captions") as? Bool ?? true
  {
    didSet { if persist { defaults.set(captionsOn, forKey: "cue.captions") } }
  }
  @Published private(set) var captions: [Caption] = []
  /// Height of the answer page's content, reported by the page.
  @Published var answerHeight: CGFloat = 0
  /// The Cue web page: whether it may control this computer, whether
  /// it is open now, and whether the current recording was started from it.
  @Published var allowRemote = UserDefaults.standard.object(forKey: "cue.remote") as? Bool ?? true {
    didSet { if persist { defaults.set(allowRemote, forKey: "cue.remote") } }
  }
  @Published private(set) var remoteOpen = false
  @Published private(set) var audioSource = ""
  private var remoteGeneration = ""
  private var remoteBusy = false
  private var reported = ""
  private var reporter: AnyCancellable?

  let store: AppStore
  /// Sends a value to the answer view only.
  var render: (JSON) -> Void = { _ in }
  /// Overlay content size, so the window hugs it.
  var resize: (CGSize) -> Void = { _ in }
  var hide: () -> Void = {}
  init(store: AppStore, defaults: UserDefaults = .standard) {
    self.store = store
    self.defaults = defaults
    // Any change may alter what the web page shows; send it once things settle.
    reporter =
      objectWillChange
      .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
      .sink { [weak self] _ in self?.reportRemote() }
  }
  /// Preview mode shares the installed app's defaults domain; never write it.
  private var persist: Bool { !store.preview }
  private let defaults: UserDefaults

  var sending: Bool { !pending.isEmpty || messages.contains(where: Self.busy) }
  var audioBusy: Bool { audio == "starting" || audio == "stopping" }
  var captionText: String {
    captions.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .reduce("") { line, next in
        guard let last = line.unicodeScalars.last else { return next }
        // Chinese and Japanese run sentences together; other scripts use a space.
        return line + (last.value >= 0x2E80 ? "" : " ") + next
      }
  }
  private static func busy(_ message: JSON) -> Bool {
    ["preparing", "running"].contains(message["status"] as? String ?? "")
  }

  func attempt(_ work: @escaping () async throws -> Void) {
    Task {
      do {
        error = ""
        try await work()
      } catch { self.error = error.localizedDescription }
    }
  }

  // MARK: Server events

  func handle(_ e: JSON) {
    switch e["type"] as? String {
    case "session_ready", "state":
      connected = true
      status = "已连接"
      if e["type"] as? String == "session_ready" {
        audio = "idle"
        audioSince = nil
        pending = ""
        audioSource = ""
        remoteGeneration = e["generation"] as? String ?? ""
        reported = ""
        // The server lists chats newest first.
        if let id = (e["chats"] as? [JSON])?.first?["id"] as? String {
          use(id)
        } else {
          attempt { try await self.store.command(["type": "new_chat"]) }
        }
      }
    case "chat_created":
      if let id = (e["chat"] as? JSON)?["id"] as? String { use(id) }
    case "history":
      messages = Self.lastHour(e["messages"] as? [JSON] ?? [])
      pending = ""
      sendRender()
    case "answer":
      guard let message = e["message"] as? JSON, let id = message["id"] as? String
      else { return }
      if id == pending {
        if text == message["text"] as? String ?? "" { text = "" }
        let used = Self.images(in: message)
        selected.removeAll { used.contains($0) }
      }
      pending = ""
      if let index = messages.firstIndex(where: { $0["id"] as? String == id }) {
        messages[index] = message
      } else {
        messages = Self.lastHour(messages + [message])
      }
      sendRender()
    case "answer_delta":
      // The answer view applies the same delta; keep this copy in step.
      guard let id = e["id"] as? String, let delta = e["delta"] as? String,
        let index = messages.firstIndex(where: { $0["id"] as? String == id })
      else { return }
      messages[index]["answer"] = (messages[index]["answer"] as? String ?? "") + delta
    case "answer_reasoning":
      guard let id = e["id"] as? String, let delta = e["delta"] as? String,
        let index = messages.firstIndex(where: { $0["id"] as? String == id })
      else { return }
      messages[index]["reasoning"] = (messages[index]["reasoning"] as? String ?? "") + delta
    case "started":
      audio = "active"
      audioSince = Date()
      captions = []
    case "stopped":
      audio = "idle"
      audioSince = nil
      audioSource = ""
      if e["complete"] as? Bool == false { error = "音频尾句未全部确认，请检查转录。" }
    case "remote": remoteOpen = e["connected"] as? Bool == true
    // A web button runs exactly what this window's button runs.
    case "remote_command":
      if let command = e["command"] as? JSON { runRemote(command) }
    case "disconnected", "replaced":
      remoteGeneration = ""
      connected = false
      remoteOpen = false
      audio = "idle"
      audioSince = nil
      status = e["detail"] as? String ?? "连接中断"
      pending = ""
      messages = messages.map { message in
        guard Self.busy(message) else { return message }
        var value = message
        value["status"] = "interrupted"
        value["detail"] = "连接中断，未自动重发。"
        return value
      }
      sendRender()
    case "error":
      error = e["detail"] as? String ?? "操作未完成。"
      if e["id"] == nil || e["id"] as? String == pending { pending = "" }
    default: break
    }
  }
  func sendRender() { render(["type": "render", "chat": chat, "messages": messages]) }
  private func runRemote(_ value: JSON) {
    guard let id = value["id"] as? String,
      let generation = value["generation"] as? String,
      !generation.isEmpty, generation == remoteGeneration
    else { return }
    let receivedAt = Self.now
    let previous = value["type"] as? String == "shot" ? captureTail : nil
    if value["type"] as? String == "shot" { captureIDs.append(id) }
    let task = Task {
      if let previous { await previous.value }
      defer { captureIDs.removeAll { $0 == id } }
      var locked = false
      defer { if locked { remoteBusy = false } }
      var result: JSON = ["type": "remote_result", "id": id, "generation": generation]
      do {
        guard connected, allowRemote, generation == remoteGeneration else {
          throw CueError("电脑上已关闭遥控或连接已断开。")
        }
        guard let expires = value["expires"] as? Double, expires > receivedAt else {
          throw CueError("指令已过期，没有执行。")
        }
        switch value["type"] as? String {
        case "cancel": try await cancelAnswer()
        case "unselect":
          guard let image = value["image"] as? String else { throw CueError("截图标识无效。") }
          selected.removeAll { $0 == image }
        case "ask":
          result["answer"] = try beginAnswer(text: value["text"] as? String ?? "", effort: value["effort"] as? String ?? "")
        case "shot", "start", "stop":
          guard !remoteBusy, !working else { throw CueError("电脑正在完成上一个操作。") }
          remoteBusy = true
          locked = true
          guard !audioBusy else { throw CueError("请等待音频就绪。") }
          if value["type"] as? String == "shot" {
            try await captureShot(receipt: result)
            return // The server completes the shot command when its image is saved.
          }
          if value["type"] as? String == "start", audio == "idle" { try await changeAudio(source: "remote") }
          if value["type"] as? String == "stop", audio == "active" { try await changeAudio(source: "") }
        default: throw CueError("遥控指令无效。")
        }
        result["ok"] = true
      } catch {
        self.error = error.localizedDescription
        result["ok"] = false
        result["detail"] = String(self.error.prefix(300))
      }
      if connected && generation == remoteGeneration { try? await store.command(result) }
    }
    if value["type"] as? String == "shot" { captureTail = task }
  }
  /// What the web page shows about this computer; sent when it changes.
  private func reportRemote() {
    guard connected, !remoteGeneration.isEmpty else { return }
    let value: JSON = [
      "type": "remote_state", "version": 3, "allow": allowRemote, "phase": audio,
      "since": Int((audioSince?.timeIntervalSince1970 ?? 0) * 1000), "selected": selected,
      "pending": pending, "uploading": uploading, "upload_error": String(uploadError.prefix(300)),
      "uploads": Array(Set(uploads.compactMap { $0["request_id"] as? String } + captureIDs)).sorted(),
      "error": String(error.prefix(300)), "source": audio == "active" ? audioSource : "",
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
      let key = String(data: data, encoding: .utf8), key != reported
    else { return }
    reported = key
    Task {
      do { try await store.command(value) } catch { reported = "" }
    }
  }
  /// Live interviewer caption. Display only: it never reaches the server. The
  /// strip keeps the last ten minutes so the reader can scroll back.
  func caption(_ value: JSON) {
    guard audio != "idle", let id = value["item"] as? String,
      let text = value["text"] as? String
    else { return }
    let now = Date()
    if let index = captions.firstIndex(where: { $0.id == id }) {
      captions[index].text = text
    } else {
      captions.append(Caption(id: id, text: text, at: now))
    }
    captions.removeAll { now.timeIntervalSince($0.at) > 600 }
  }

  // MARK: Actions

  func reconnect() async {
    status = "正在连接…"
    error = ""
    do { try await store.connect() } catch {
      status = "连接未就绪"
      self.error = error.localizedDescription
    }
  }
  private func use(_ id: String) {
    chat = id
    messages = []
    sendRender()
    attempt {
      try await self.store.command(["type": "history", "chat": id, "scope": "recent"])
    }
  }
  func ask() {
    do { _ = try beginAnswer(text: text, effort: effort) }
    catch { self.error = error.localizedDescription }
  }
  /// Reserve the answer before waiting, so cancel also works during upload.
  private func beginAnswer(text: String, effort: String) throws -> String {
    guard connected, !sending, !audioBusy, !chat.isEmpty else { throw CueError("请等待连接或上一轮回答完成。") }
    guard uploadError.isEmpty else { throw CueError(uploadError) }
    let id = UUID().uuidString.lowercased(), generation = remoteGeneration
    pending = id
    error = ""
    expanded = true
    Task {
      do {
        while working || uploadTask != nil {
          guard pending == id, connected, generation == remoteGeneration else { throw CueError("回答已取消或连接已变化。") }
          if let task = uploadTask { await task.value }
          else { try await Task.sleep(for: .milliseconds(20)) }
        }
        guard uploadError.isEmpty, uploads.isEmpty else { throw CueError(uploadError.isEmpty ? "截图尚未上传。" : uploadError) }
        guard pending == id, connected, generation == remoteGeneration else { return }
        var value: JSON = ["type": "ask", "id": id, "chat": chat, "text": text, "images": selected]
        if !effort.isEmpty { value["effort"] = effort }
        try await store.command(value)
      } catch {
        if pending == id { pending = ""; self.error = error.localizedDescription }
      }
    }
    return id
  }
  func cancel() { attempt { try await self.cancelAnswer() } }
  private func cancelAnswer() async throws {
    let id = messages.first(where: Self.busy)?["id"] as? String ?? pending
    pending = ""  // Cancels a reserved answer which has not reached the server.
    if !id.isEmpty { try await store.command(["type": "cancel", "id": id]) }
  }
  func shot() {
    let previous = captureTail
    captureTail = Task {
      if let previous { await previous.value }
      do { try await captureShot() } catch { self.error = error.localizedDescription }
    }
  }
  private func captureShot(receipt: JSON? = nil) async throws {
    guard !working else { throw CueError("截图尚未完成。") }
    // Saved references are independent of the next Cue answer's attachments.
    // Every captured image stays queued until the server confirms its save.
    working = true
    defer { working = false }
    var shot = try await store.screenshot()
    if let receipt, let id = receipt["id"] as? String {
      shot["request_id"] = id
    }
    uploads.append(shot)
    uploading = uploads.count
    startUploads()
  }
  func retryUploads() {
    uploadError = ""
    startUploads()
  }
  private func startUploads() {
    guard uploadTask == nil, uploadError.isEmpty, !uploads.isEmpty else { return }
    uploadTask = Task {
      defer { uploadTask = nil }
      while let shot = uploads.first {
        do {
          let image = try await store.uploadShot(shot)
          guard let id = image["id"] as? String else { throw CueError("截图上传结果未确认。") }
          if !selected.contains(id) { selected = Array((selected + [id]).suffix(8)) }
          previews = previews.filter { selected.contains($0.key) }
          if let url = image["image_url"] as? String, let picture = Self.image(dataURL: url) { previews[id] = picture }
          uploads.removeFirst()
          uploading = uploads.count
        } catch {
          uploadError = "截图上传失败，原图已保留：" + error.localizedDescription
          return
        }
      }
    }
  }
  func loadPreview(_ id: String) {
    guard previews[id] == nil else { return }
    attempt {
      let value = try await self.store.request("/capture/images/" + id)
      guard let data = value["data"] as? String,
        let picture = Self.image(dataURL: "data:\(value["mimeType"] ?? "image/png");base64," + data)
      else { return }
      self.previews[id] = picture
    }
  }
  func toggleAudio() { toggleAudio(source: "") }
  func toggleAudio(source: String) {
    attempt { try await self.changeAudio(source: source) }
  }
  private func changeAudio(source: String) async throws {
    guard !audioBusy else { throw CueError("请等待音频就绪。") }
    let start = audio == "idle"
    if start { audioSource = source }
    audio = start ? "starting" : "stopping"
    do { try await store.audio(start) } catch {
      audio = "idle"
      throw error
    }
    guard connected, audio == (start ? "active" : "idle") else { throw CueError("转录操作未完成。") }
  }
  func importConnection() { attempt { try await self.store.importConnection() } }
  func openWebSettings() {
    NSWorkspace.shared.open(URL(string: AppStore.serviceURL + "/settings")!)
  }
  func openPrivacy() { NSWorkspace.shared.open(ScreenAccess.settingsURL) }

  // MARK: Decoding

  private static var now: Double { Date().timeIntervalSince1970 * 1000 }
  /// The answers the next question sees; one still running always stays.
  private static func lastHour(_ messages: [JSON]) -> [JSON] {
    let since = now - 3_600_000
    return messages.filter {
      busy($0) || (($0["created"] as? NSNumber)?.doubleValue ?? now) >= since
    }
  }
  private static func images(in message: JSON) -> [String] {
    guard let context = message["context"] as? String,
      let data = context.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? JSON
    else { return [] }
    return value["images"] as? [String] ?? []
  }
  static func image(dataURL: String) -> NSImage? {
    guard let comma = dataURL.firstIndex(of: ","),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
    else { return nil }
    return NSImage(data: data)
  }
}
