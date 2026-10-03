import AppKit
import SwiftUI
import SageCore

@MainActor final class AppStore: ObservableObject {
    @Published var state = ChatState()
    @Published var connection = "未连接"
    @Published var connected = false
    @Published var connecting = false
    @Published var loggingIn = false
    @Published var loginStatus = ""
    @Published var draft = "" { didSet { persistDraft() } }
    @Published var provider = "responses"
    @Published var profile = "default"
    @Published var error: String?
    @Published var conversations: [JSON] = []
    @Published var showSettings = false
    @Published var showHistory = false
    @Published var showTranscript = false
    @Published var showSources = false
    @Published var sourceID = "frontmost"
    @Published var sources: [CaptureSource] = []
    @Published var preparing = false
    @Published var channelStatus = ["interviewer": "未开启", "candidate": "未开启"]
    @Published var pairing: JSON?
    @Published var pendingSwitch = false
    @Published var previewImage: NSImage?
    @Published var previewText = ""
    @Published var screenshotBusy = false
    @Published private(set) var initialSnapshotPending = true
    @Published var pendingSend: String?
    var serverText = UserDefaults.standard.string(forKey: "server") ?? "https://interview.siyidu.com"
    var codexPath = UserDefaults.standard.string(forKey: "codex") ?? ""
    let preview: Bool
    private let http: HTTPClient
    private let capture: CaptureController
    private let host = ModelHost()
    private var address: ServerAddress?
    private var session: Session?
    private var accessToken = ""
    private var links: [String: SocketLink] = [:]
    private var sending: Set<String> = []
    private var timer: Timer?
    private var drafts: [String: String] = [:]
    private var draftKey = ""
    private var draftSaveFailed = false
    private var draftStorageUnavailable = false
    private var lastGap = Date.distantPast
    private var targetConversation: String?
    private var sentDraft = ""
    private var refreshing = false
    private var modeReady = false
    private var supportsAppShot = false
    private var capabilityEpoch = UUID()
    private var shouldStartAfterPrepare = false
    private var generation = UUID()
    private var conversationEpoch = UUID()
    private var screenshotOperation: String?
    var busy: Bool { state.busyID != nil || pendingSend != nil }
    init(preview: Bool = false, http: HTTPClient = HTTPClient(), capture: CaptureController? = nil) {
        self.capture = capture ?? CaptureController()
        self.http = http
        self.preview = preview
        if preview { seedPreview() }
        else {
            do { drafts = try LocalFiles.loadDrafts() }
            catch { draftStorageUnavailable = true; draftSaveFailed = true; self.error = "无法读取已保存草稿，已停止覆盖文件。请先备份并修复本机 drafts.json。" }
        }
        host.onFailure = { [weak self] message in self?.error = message }
    }
    private func persistDraft() {
        guard !preview, !draftKey.isEmpty else { return }
        guard !draftStorageUnavailable else { return }
        drafts[draftKey] = draft
        do { try LocalFiles.write(try JSONEncoder().encode(drafts), to: LocalFiles.root.appendingPathComponent("drafts.json")); draftSaveFailed = false }
        catch { draftSaveFailed = true; self.error = "草稿保存失败，请先复制文字；当前草稿仍在内存中。" }
    }
    private func selectDraft(_ conversation: String) {
        draftKey = "\(address?.url.absoluteString ?? "preview")|\(conversation)"
        draft = drafts[draftKey] ?? ""
    }
    func loginCodex(_ path: String) {
        guard !loggingIn else { return }
        do {
            loggingIn = true; loginStatus = "请在浏览器中完成 Codex 登录。"
            try host.login(codex: path) { [weak self] success in
                self?.loggingIn = false
                self?.loginStatus = success ? "Codex 已登录。" : "登录未完成，请检查 CLI 路径后重试。"
            }
        } catch { loggingIn = false; loginStatus = error.localizedDescription }
    }
    func connect(server: String, token: String, codex: String, remember: Bool) async {
        guard !connecting else { return }
        connecting = true; defer { connecting = false }
        do {
            guard !state.active && !state.stopping && !busy else { throw SageError("请先停止转录和当前回答，再修改服务器连接。") }
            let address = try ServerAddress(server)
            let health = try await http.request(address, "/health")
            try validateHealth(health)
            let token = token.isEmpty ? try Credentials.load(address.url.absoluteString) : token.trimmingCharacters(in: .whitespacesAndNewlines)
            let result = try await http.request(address, "/api/interviews", method: "POST", token: token, body: ["device_name": "Sage · \(Host.current().localizedName ?? "Mac")"])
            let session = try Session(result)
            if remember { try Credentials.save(token, origin: address.url.absoluteString) }
            let epoch = await disconnect()
            guard generation == epoch else { return }
            self.address = address; self.session = session; accessToken = token
            supportsAppShot = health["appshot"] as? Bool == true
            serverText = address.url.absoluteString; codexPath = codex
            if !preview { UserDefaults.standard.set(serverText, forKey: "server"); UserDefaults.standard.set(codex, forKey: "codex") }
            state = ChatState(); state.conversationID = session.conversationID
            selectDraft(session.conversationID)
            try establishLinks(address: address, session: session)
            showSettings = false; error = nil
        } catch { self.error = error.localizedDescription }
    }
    #if DEBUG
    var testEstablish: ((ServerAddress, Session) -> Void)?
    var testControl: ((JSON) -> Void)?
    func testSession(_ origin: String, _ value: Session) throws { address = try ServerAddress(origin); session = value; connected = true; initialSnapshotPending = false; state.conversationID = value.conversationID }
    func testReceive(_ event: JSON) { receive(event) }
    func testRefresh() async { await refreshSession() }
    var testSupportsAppShot: Bool { supportsAppShot }
    func testConnectionState(_ ready: Bool, role: String = "client") -> Task<Void, Never>? {
        guard let address else { return nil }
        return connectionStateChanged(ready, message: "fixture", role: role, address: address)
    }
    func testCaptureLinks(_ value: [String: SocketLink]) { links = value }
    func testCaptureEvent(_ value: JSON, role: String = "interviewer") { captureEvent(value, role: role) }
    #endif
    private func establishLinks(address: ServerAddress, session: Session) throws {
        #if DEBUG
        if let testEstablish { testEstablish(address, session); connected = true; return }
        #endif
        let epoch = generation
        try host.start(address: address, session: session, codex: codexPath)
        for role in ["client", "interviewer", "candidate"] {
            let link = SocketLink(url: try address.socket(interview: session.interviewID, role: role), token: role == "client" ? session.token : session.captureToken, role: role)
            link.onState = { [weak self] ready, message in
                guard let self, generation == epoch else { return }
                connectionStateChanged(ready, message: message, role: role, address: address)
            }
            link.onEvent = { [weak self] event in
                guard let self, generation == epoch else { return }
                if role == "client" { receive(event) }
                else { captureEvent(event, role: role) }
            }
            link.onExpired = { [weak self] in
                guard let self, generation == epoch else { return }
                Task { await self.refreshSession() }
            }
            link.onGap = { [weak self] in if self?.generation == epoch { self?.reportGap(role) } }
            links[role] = link; link.start()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pumpAudio() }
        }
    }
    private func validateHealth(_ health: JSON) throws {
        guard health["realtime_protocol"] as? String == protocolVersion,
              health["chat"] as? Bool == true, health["pinned_code"] as? Bool == false else {
            throw SageError("服务器协议不兼容，请先更新服务器。")
        }
    }
    private func invalidateCapabilities() {
        supportsAppShot = false; capabilityEpoch = UUID()
    }
    @discardableResult private func connectionStateChanged(_ ready: Bool, message: String, role: String, address: ServerAddress) -> Task<Void, Never>? {
        if role == "client" { initialSnapshotPending = true; connected = ready; connection = message }
        else { channelStatus[role] = ready ? (capture.isPrepared ? "已就绪" : "未开启") : "正在重连" }
        // Even a reconnect with a still-valid token may reach a rolled-back server.
        invalidateCapabilities()
        guard ready else { return nil }
        let epoch = generation, capability = capabilityEpoch
        return Task { [weak self] in
            guard let self, generation == epoch, capabilityEpoch == capability else { return }
            do {
                let health = try await http.request(address, "/health")
                guard generation == epoch, capabilityEpoch == capability else { return }
                try validateHealth(health)
                supportsAppShot = health["appshot"] as? Bool == true
            } catch {
                if generation == epoch, capabilityEpoch == capability {
                    self.error = "无法确认服务器 App Shot 能力，请重新连接或选择屏幕截图。"
                }
            }
        }
    }
    private func refreshSession() async {
        guard !refreshing, let address else { return }
        refreshing = true; defer { refreshing = false }
        let token = accessToken
        let epoch = await disconnect()
        guard generation == epoch else { return }
        do {
            let health = try await http.request(address, "/health")
            guard generation == epoch else { return }
            try validateHealth(health)
            let result = try await http.request(address, "/api/interviews", method: "POST", token: token, body: ["device_name": "Sage · Mac"])
            guard generation == epoch else { return }
            let session = try Session(result); self.session = session
            supportsAppShot = health["appshot"] as? Bool == true
            state.active = false; state.stopping = false
            try establishLinks(address: address, session: session)
            error = "会话已恢复。转录和未确认的回答没有自动重启。"
        } catch { if generation == epoch { self.error = error.localizedDescription } }
    }
    @discardableResult func disconnect() async -> UUID {
        let epoch = UUID(); generation = epoch; invalidateCapabilities(); timer?.invalidate(); timer = nil
        shouldStartAfterPrepare = false; preparing = false; screenshotBusy = false; screenshotOperation = nil; sending = []
        links.values.forEach { $0.close() }; links = [:]; host.stop()
        connected = false; initialSnapshotPending = true; connection = "未连接"; pendingSend = nil
        _ = await capture.finish()
        return epoch
    }
    private func receive(_ event: JSON) {
        let old = state.conversationID
        state.apply(event)
        if state.conversationID != old {
            conversationEpoch = UUID(); screenshotOperation = nil; screenshotBusy = false
            session?.conversationID = state.conversationID; selectDraft(state.conversationID)
            provider = "responses"; profile = "default"; pendingSend = nil
        }
        let type = event["type"] as? String ?? ""
        if type == "session_ready" || type == "conversation_reset" { initialSnapshotPending = true }
        if type == "chat_snapshot", let last = state.messages.last {
            provider = last.provider; profile = last.profile == "lc" ? "default" : last.profile
        }
        if type == "chat_message", let message = event["chat_message"] as? JSON, message["message_id"] as? String == pendingSend {
            if draft == sentDraft { draft = "" }
            pendingSend = nil
        }
        if type == "operation_snapshot" {
            if let id = screenshotOperation, !state.operations.contains(where: { $0["operation_id"] as? String == id && ["accepted", "running"].contains($0["status"] as? String ?? "") }) {
                screenshotOperation = nil; screenshotBusy = false
            }
            if let id = pendingSend {
                if state.messages.contains(where: { $0.id == id }) { if draft == sentDraft { draft = "" } }
                else { error = "发送未确认，草稿已保留；请核对记录后重试。" }
            }
            pendingSend = nil
            initialSnapshotPending = false
        }
        if type == "operation_status", ["failed", "cancelled", "completed"].contains(event["status"] as? String ?? "") {
            if event["operation_id"] as? String == pendingSend { pendingSend = nil }
            if event["kind"] as? String == "request_screen_capture", event["operation_id"] as? String == screenshotOperation {
                screenshotOperation = nil; screenshotBusy = false
            }
        }
        if type == "device_status", let details = event["channel_details"] as? [String: JSON] {
            for (role, value) in details {
                if let detail = value["detail"] as? String, !detail.isEmpty { channelStatus[role] = detail }
            }
        }
        if let message = state.error { error = message; state.error = nil }
    }
    func control(_ payload: JSON) async throws {
        var body = payload
        if let target = body["conversation_id"] as? String, target != state.conversationID { throw SageError("聊天已经切换，原草稿未发送。") }
        body["conversation_id"] = body["conversation_id"] ?? state.conversationID
        if body["operation_id"] == nil { body["operation_id"] = UUID().uuidString }
        #if DEBUG
        if let testControl { testControl(body); return }
        #endif
        guard let link = links["client"], connected else { throw SageError("请先连接服务器。") }
        try await link.send(body)
    }
    func perform(_ action: @escaping () async throws -> Void) {
        Task { do { try await action() } catch { self.error = error.localizedDescription } }
    }
    func send() {
        guard !busy else { stopAnswer(); return }
        let id = UUID().uuidString, text = draft
        let requestIDs = state.screens.compactMap { $0["request_id"] as? String }
        let chosenProvider = provider, chosenProfile = profile
        let conversation = state.conversationID, epoch = generation, chatEpoch = conversationEpoch
        pendingSend = id; sentDraft = text
        perform { [self] in
            do {
                guard epoch == generation, chatEpoch == conversationEpoch else { throw SageError("连接或聊天已经变更，原草稿未发送。") }
                try await control(["type": "chat_send", "conversation_id": conversation, "operation_id": id, "action": text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "answer" : "send",
                    "text": text, "request_ids": requestIDs, "provider": chosenProvider, "profile": chosenProfile])
            } catch { if pendingSend == id { pendingSend = nil }; throw error }
        }
    }
    func stopAnswer() {
        guard let id = state.busyID else { return }
        perform { [self] in try await control(["type": "chat_stop", "target_operation_id": id]) }
    }
    func screenshot() {
        // session_ready precedes the initial operation snapshot. Do not admit a
        // new request into that old snapshot's reconciliation window.
        guard connected, !initialSnapshotPending, !screenshotBusy else { return }
        screenshotBusy = true
        let conversation = state.conversationID, epoch = generation, chatEpoch = conversationEpoch, operation = UUID().uuidString
        screenshotOperation = operation
        perform { [self] in
            do {
                guard generation == epoch, conversationEpoch == chatEpoch, connected, !initialSnapshotPending, screenshotOperation == operation else { throw SageError("连接或聊天正在恢复，截图请求未发送。") }
                try await control(["type": "request_screen_capture", "conversation_id": conversation, "operation_id": operation, "collect_only": true])
            } catch {
                if screenshotOperation == operation { screenshotBusy = false; screenshotOperation = nil }
                throw error
            }
        }
    }
    func removeScreen(_ id: String) { perform { [self] in try await control(["type": "clear_screens", "request_ids": [id]]) } }
    func listConversations() {
        perform { [self] in
            guard let address, let session else { return }
            conversations = try await http.request(address, "/api/conversations", token: session.token)["conversations"] as? [JSON] ?? []
            showHistory = true
        }
    }
    func switchTo(_ id: String?, confirmed: Bool = false) {
        persistDraft()
        guard !draftSaveFailed else { return }
        targetConversation = id
        if busy && !confirmed { pendingSwitch = true; return }
        perform { [self] in
            guard let address, let session else { return }
            _ = try await http.request(address, "/api/conversations/switch", method: "POST", token: session.token,
                body: ["current_id": state.conversationID, "target_id": id as Any? ?? NSNull(), "stop_active": confirmed])
            showHistory = false; pendingSwitch = false
        }
    }
    func confirmSwitch() { switchTo(targetConversation, confirmed: true) }
    func rename(_ title: String) {
        perform { [self] in
            guard let address, let session else { return }
            _ = try await http.request(address, "/api/conversations/\(state.conversationID)", method: "PATCH", token: session.token, body: ["title": title])
            state.title = title
        }
    }
    func loadSources() {
        perform { [self] in sources = try await capture.sources(); showSources = true }
    }
    func toggleTranscription() {
        if state.active || state.stopping {
            perform { [self] in try await control(["type": "stop_transcription"]) }
        } else { perform { [self] in try await control(["type": "start_transcription", "mode": "assist"]) } }
    }
    private func captureEvent(_ event: JSON, role: String) {
        guard let link = links[role] else { return }
        switch event["type"] as? String {
        case "session_ready":
            perform { [self] in try await link.send(["type": "capture_status", "phase": capture.isPrepared ? "ready" : "interrupted", "mode": "assist", "detail": capture.isPrepared ? "" : "转录未开启。"]) }
        case "prepare_capture":
            guard !preparing else { return }
            guard event["mode"] as? String != "mock" else { error = "此 Mac 客户端当前仅支持普通面试转录。"; return }
            preparing = true; modeReady = false; shouldStartAfterPrepare = true
            let epoch = generation
            Task {
                defer { if generation == epoch { preparing = false } }
                do {
                    try await capture.prepare()
                    guard generation == epoch else { return }
                    guard shouldStartAfterPrepare else { _ = await capture.finish(); return }
                    for channel in ["candidate", "interviewer"] {
                        guard let captureLink = links[channel], captureLink.ready else { throw SageError("双路采集连接尚未就绪，请稍后重试。") }
                        try await captureLink.send(["type": "capture_status", "phase": "ready", "mode": "assist"])
                    }
                    for _ in 0..<100 {
                        if modeReady || generation != epoch || !shouldStartAfterPrepare { break }; try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    guard generation == epoch, shouldStartAfterPrepare else { return }
                    guard modeReady else { throw SageError("音频准备确认超时。") }
                    if shouldStartAfterPrepare { try await control(["type": "start_transcription", "mode": "assist"]) }
                } catch {
                    if generation == epoch {
                        if !(error is CancellationError) { self.error = error.localizedDescription }
                        _ = await capture.finish()
                    }
                }
            }
        case "capture_mode_ready": modeReady = true
        case "capture_start": sending.insert(role); channelStatus[role] = "转录中"
        case "capture_stop":
            shouldStartAfterPrepare = false
            let epoch = generation
            Task {
                var complete = await capture.finish()
                if let sink = capture.sink {
                    let tail = sink.take(role)
                    if tail.gap { complete = false }
                    for frame in tail.frames { if !link.audio(frame) { complete = false } }
                }
                sending.remove(role); channelStatus[role] = "未开启"
                if let id = event["request_id"] as? String {
                    do { try await link.send(["type": "capture_stopped", "request_id": id, "complete": complete]) }
                    catch {
                        if generation == epoch, links[role] === link {
                            self.error = "音频收尾确认失败，尾句可能不完整。"
                        }
                    }
                }
                try? await link.send(["type": "capture_status", "phase": "interrupted", "mode": "assist", "detail": "转录未开启。"])
            }
        case "screen_capture_request":
            guard let requestID = event["request_id"] as? String, let address, let session else { return }
            let epoch = generation, chatEpoch = conversationEpoch, conversation = event["conversation_id"] as? String ?? state.conversationID
            let selectedSource = sourceID, capability = capabilityEpoch
            let windowShot = selectedSource == "frontmost" || selectedSource.hasPrefix("window:")
            Task {
                do {
                    guard generation == epoch, conversationEpoch == chatEpoch, state.conversationID == conversation else { throw SageError("截图所属聊天已切换，请重新截图。") }
                    if windowShot && (!supportsAppShot || capabilityEpoch != capability) { throw SageError("服务器尚未支持 App Shot 文字，请更新服务器或选择屏幕截图。") }
                    var payload = try await capture.screenshot(source: selectedSource)
                    guard generation == epoch else { return }
                    guard state.conversationID == conversation, conversationEpoch == chatEpoch else { throw SageError("截图所属聊天已切换，原截图未上传。") }
                    if windowShot && (!supportsAppShot || capabilityEpoch != capability) { throw SageError("截图期间服务器连接已改变，请重新截图。") }
                    payload["request_id"] = requestID
                    _ = try await http.request(address, "/api/interviews/\(session.interviewID)/screenshots", method: "POST", token: session.captureToken, body: payload)
                } catch {
                    try? await link.send(["type": "screen_snapshot", "request_id": requestID, "error": error.localizedDescription])
                    if generation == epoch { self.error = error.localizedDescription }
                }
            }
        case "browser_connection_request": pairing = event
        case "browser_connection_result": pairing = nil
        case "error": error = event["detail"] as? String
        default: break
        }
    }
    func decidePairing(_ approved: Bool) {
        guard let id = pairing?["request_id"] as? String else { return }
        perform { [self] in try await links["interviewer"]?.send(["type": "browser_connection_decision", "request_id": id, "approved": approved]); pairing = nil }
    }
    private func pumpAudio() {
        guard let sink = capture.sink else { return }
        for role in ["interviewer", "candidate"] {
            let batch = sink.take(role)
            if sending.contains(role) {
                for frame in batch.frames { links[role]?.audio(frame) }
                if batch.gap { reportGap(role) }
            }
        }
        if let message = sink.error() {
            error = message
            perform { [self] in try await control(["type": "stop_transcription"]) }
        }
    }
    private func reportGap(_ role: String) {
        guard Date().timeIntervalSince(lastGap) > 3 else { return }; lastGap = Date()
        channelStatus[role] = "音频出现缺口"; error = "连接积压或中断，部分音频未上传；已记录文字保留。"
        Task { try? await links[role]?.send(["type": "capture_status", "phase": "interrupted", "mode": "assist", "audio_gap": true, "detail": "音频出现缺口。"])
            if capture.isPrepared { try? await links[role]?.send(["type": "capture_status", "phase": "ready", "mode": "assist"]) }
        }
    }
    private func seedPreview() {
        state.conversationID = "preview"; state.title = "算法与系统设计"
        state.apply(["type": "chat_message", "chat_message": ["message_id": "sample", "text": "解释一下滑动窗口的思路，并给出 Python 实现。", "provider": "responses", "profile": "default"]])
        state.apply(["type": "answer_completed", "response_id": "chat:sample", "text": "## 用窗口维护当前状态\n\n左右指针维护一个连续区间。右指针扩展窗口；条件不满足时，移动左指针，直到窗口重新有效。\n\n```python\ndef longest_unique(text):\n    seen = {}\n    left = best = 0\n    for right, char in enumerate(text):\n        left = max(left, seen.get(char, -1) + 1)\n        seen[char] = right\n        best = max(best, right - left + 1)\n    return best\n```\n\n每个位置只处理一次，时间复杂度 **O(n)**。"])
        connection = "界面预览 · 无网络与采集"
    }
}
