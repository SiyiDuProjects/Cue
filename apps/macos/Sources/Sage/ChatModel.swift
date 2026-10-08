import AppKit
import SageCore

struct ChatItem: Identifiable, Hashable {
  let id: String
  var title: String
}
struct TranscriptTurn: Identifiable {
  let id: String
  var speaker: String
  var text: String
  var status: String
  var created: Double
}
struct SavedShot: Identifiable {
  let id: String
  var created: Double
}
struct SourceChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let disabled: Bool
  let needsPermission: Bool
}

/// Native chat state. It consumes the same server events the answer view
/// receives; the answer view only renders messages this model sends it.
@MainActor final class ChatModel: ObservableObject {
  @Published var connected = false
  @Published var status = "正在连接…"
  @Published var error = ""
  @Published private(set) var recording = ""
  @Published private(set) var chats: [ChatItem] = []
  @Published private(set) var chat = UserDefaults.standard.string(forKey: "cue.chat") ?? ""
  @Published private(set) var messages: [JSON] = []
  @Published private(set) var turns: [TranscriptTurn] = []
  @Published private(set) var images: [SavedShot] = []
  @Published var selected: [String] = []
  @Published private(set) var previews: [String: NSImage] = [:]
  @Published var text = "" {
    didSet { if persist, !chat.isEmpty { defaults.set(text, forKey: "cue.draft." + chat) } }
  }
  @Published private(set) var audio = "idle"
  @Published private(set) var working = false
  @Published private(set) var pending = ""
  @Published var showTranscript = false
  @Published private(set) var sources: [SourceChoice] = []
  @Published private(set) var source = ""
  @Published private(set) var sourceBusy = false
  @Published var effort = UserDefaults.standard.string(forKey: "cue.effort") ?? "" {
    didSet { if persist { defaults.set(effort, forKey: "cue.effort") } }
  }
  @Published private(set) var pinned = true
  @Published var imagePreview: String?

  let store: AppStore
  /// Sends a value to the answer view only.
  var render: (JSON) -> Void = { _ in }
  var pin: (Bool) -> Void = { _ in }
  init(store: AppStore) { self.store = store }
  /// Preview mode shares the installed app's defaults domain; never write it.
  private var persist: Bool { !store.preview }
  private let defaults = UserDefaults.standard

  var sending: Bool { !pending.isEmpty || messages.contains(where: Self.busy) }
  var audioBusy: Bool { audio == "starting" || audio == "stopping" }
  var chatTitle: String { chats.first { $0.id == chat }?.title ?? "聊天" }
  var visibleTurns: [TranscriptTurn] {
    turns.filter {
      !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || $0.status == "interrupted"
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
      recording = e["recording"] as? String ?? recording
      turns = (e["turns"] as? [JSON] ?? []).compactMap(Self.turn).sorted(by: Self.order)
      images = (e["images"] as? [JSON] ?? []).compactMap(Self.shot)
      chats = (e["chats"] as? [JSON] ?? []).compactMap(Self.chatItem)
      if e["type"] as? String == "session_ready" {
        audio = "idle"
        pending = ""
        if let id = chats.first(where: { $0.id == chat })?.id ?? chats.first?.id {
          choose(id)
        } else {
          attempt { try await self.store.command(["type": "new_chat"]) }
        }
      }
    case "chat_created":
      if let item = (e["chat"] as? JSON).flatMap(Self.chatItem) {
        chats.insert(item, at: 0)
        choose(item.id)
      }
    case "history":
      guard e["chat"] as? String == chat else { return }
      messages = e["messages"] as? [JSON] ?? []
      pending = ""
      sendRender()
    case "answer":
      guard let message = e["message"] as? JSON, message["chat"] as? String == chat,
        let id = message["id"] as? String
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
        messages.append(message)
      }
      sendRender()
    case "answer_delta":
      // The answer view applies the same delta; keep this copy in step.
      guard let id = e["id"] as? String, let delta = e["delta"] as? String,
        let index = messages.firstIndex(where: { $0["id"] as? String == id })
      else { return }
      messages[index]["answer"] = (messages[index]["answer"] as? String ?? "") + delta
    case "transcript":
      guard let turn = (e["turn"] as? JSON).flatMap(Self.turn) else { return }
      turns.removeAll { $0.id == turn.id }
      turns.append(turn)
      turns.sort(by: Self.order)
    case "started": audio = "active"
    case "stopped":
      audio = "idle"
      if e["complete"] as? Bool == false { error = "音频尾句未全部确认，请检查转录。" }
    case "disconnected", "replaced":
      connected = false
      audio = "idle"
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

  // MARK: Actions

  func reconnect() async {
    status = "正在连接…"
    error = ""
    do { try await store.connect() } catch {
      status = "连接未就绪"
      self.error = error.localizedDescription
    }
  }
  func choose(_ id: String) {
    chat = id
    if persist { defaults.set(id, forKey: "cue.chat") }
    text = defaults.string(forKey: "cue.draft." + id) ?? ""
    messages = []
    sendRender()
    attempt { try await self.store.command(["type": "history", "chat": id]) }
  }
  func ask() {
    guard connected, pending.isEmpty, !sending, !audioBusy, !chat.isEmpty else { return }
    let id = UUID().uuidString.lowercased()
    pending = id
    error = ""
    var value: JSON = ["type": "ask", "id": id, "chat": chat, "text": text, "images": selected]
    if !effort.isEmpty { value["effort"] = effort }
    Task {
      do { try await store.command(value) } catch {
        pending = ""
        self.error = error.localizedDescription
      }
    }
  }
  func cancel() {
    let id = messages.first(where: Self.busy)?["id"] as? String ?? pending
    attempt { try await self.store.command(["type": "cancel", "id": id]) }
  }
  func shot() {
    guard !working else { return }
    working = true
    attempt {
      defer { self.working = false }
      let image = try await self.store.screenshot(self.recording)
      guard let id = image["id"] as? String else { return }
      self.images.removeAll { $0.id == id }
      self.images.append(SavedShot(id: id, created: image["created"] as? Double ?? Self.now))
      self.selected = Array((self.selected + [id]).suffix(8))
      if let url = image["image_url"] as? String, let picture = Self.image(dataURL: url) {
        self.previews[id] = picture
      }
    }
  }
  func toggleSelected(_ id: String) {
    if selected.contains(id) {
      selected.removeAll { $0 == id }
    } else {
      selected = Array((selected + [id]).suffix(8))
    }
    loadPreview(id)
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
  func removeImage(_ id: String) {
    attempt {
      _ = try await self.store.request("/capture/images/" + id, method: "DELETE")
      self.images.removeAll { $0.id == id }
      self.selected.removeAll { $0 == id }
    }
  }
  func toggleAudio() {
    guard !audioBusy else { return }
    let start = audio == "idle"
    audio = start ? "starting" : "stopping"
    Task {
      do { try await store.audio(start) } catch {
        audio = "idle"
        self.error = error.localizedDescription
      }
    }
  }
  func loadSources() {
    sourceBusy = true
    attempt {
      defer { self.sourceBusy = false }
      let choices = try await self.store.sources()
      self.sources = choices.compactMap { value in
        guard let id = value["id"] as? String else { return nil }
        return SourceChoice(
          id: id, name: value["name"] as? String ?? id,
          disabled: value["disabled"] as? Bool == true,
          needsPermission: value["permission"] as? String == "screen")
      }
      self.source = choices.first { $0["selected"] as? Bool == true }?["id"] as? String ?? ""
    }
  }
  func selectSource(_ id: String) {
    store.selectSource(id)
    source = id
  }
  func newChat() { attempt { try await self.store.command(["type": "new_chat"]) } }
  func rename(_ title: String) {
    let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !chat.isEmpty else { return }
    attempt {
      try await self.store.command(["type": "rename_chat", "chat": self.chat, "title": value])
    }
  }
  func newRecording() { attempt { try await self.store.command(["type": "new_recording"]) } }
  func uploadMaterials() { attempt { _ = try await self.store.uploadMaterials() } }
  func importConnection() { attempt { try await self.store.importConnection() } }
  func openWebSettings() {
    NSWorkspace.shared.open(URL(string: AppStore.serviceURL + "/settings")!)
  }
  func openPrivacy() { NSWorkspace.shared.open(ScreenAccess.settingsURL) }
  func togglePin() {
    pinned.toggle()
    pin(pinned)
  }

  // MARK: Decoding

  private static var now: Double { Date().timeIntervalSince1970 * 1000 }
  private static func order(_ a: TranscriptTurn, _ b: TranscriptTurn) -> Bool {
    a.created == b.created ? a.id < b.id : a.created < b.created
  }
  private static func chatItem(_ value: JSON) -> ChatItem? {
    guard let id = value["id"] as? String else { return nil }
    return ChatItem(id: id, title: value["title"] as? String ?? "新聊天")
  }
  private static func turn(_ value: JSON) -> TranscriptTurn? {
    guard let id = value["id"] as? String else { return nil }
    return TranscriptTurn(
      id: id, speaker: value["speaker"] as? String ?? "interviewer",
      text: value["text"] as? String ?? "", status: value["status"] as? String ?? "final",
      created: (value["created"] as? NSNumber)?.doubleValue ?? now)
  }
  private static func shot(_ value: JSON) -> SavedShot? {
    guard let id = value["id"] as? String else { return nil }
    return SavedShot(id: id, created: (value["created"] as? NSNumber)?.doubleValue ?? now)
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
