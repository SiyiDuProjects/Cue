import AppKit
import SwiftUI
import SageCore

/// Mac owns capture; Sites owns the recording and ChatGPT owns answers.
@MainActor final class AppStore: ObservableObject {
    @Published var state = CaptureState()
    @Published var connection = "未连接"
    @Published var connected = false
    @Published var connecting = false
    @Published var error: String?
    @Published var showSettings = false
    @Published var showTranscript = false
    @Published var showSources = false
    @Published var showChatGPT = false
    @Published var sourceID = "frontmost" {
        didSet { if !preview { UserDefaults.standard.set(sourceID, forKey: "capture.source") } }
    }
    @Published var sources: [CaptureSource] = []
    @Published var preparing = false
    @Published var channelStatus = ["interviewer": "未开启", "candidate": "未开启"]
    @Published var previewImage: NSImage?
    @Published var previewText = ""
    @Published var screenshotBusy = false
    @Published private(set) var initialSnapshotPending = true
    @Published private(set) var needsSignIn = false
    static let serviceURL = "https://interview.siyidu.com"
    let chatgpt: ChatGPTRequests
    let preview: Bool
    var openCaptureSettings: () -> Void = {}
    private let http: HTTPClient
    private let capture: CaptureController
    private let host = MaterialsHost()
    private let loadCredential: (String) async throws -> String
    private var address: ServerAddress?
    private var credentials: SiteCredentials?
    private var session: Session?
    private var links: [String: SocketLink] = [:]
    private var sending: Set<String> = []
    private var stoppingChannels: Set<String> = []
    private var poll: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var timer: Timer?
    private var generation = UUID()
    private var audioGeneration = UUID()
    private var linksGeneration = UUID()
    private var restored = false
    private var failures = 0
    private var lastGap = Date.distantPast
    private var imageCache: [String: JSON] = [:]
    private var supportsAppShot = false
    private var snapshotSerial = 0
    private var changingRecording = false
    private var flushingRequest = false
    private let roles = ["interviewer", "candidate"]
    init(preview: Bool = false, http: HTTPClient = HTTPClient(), capture: CaptureController? = nil,
         loadCredential: @escaping (String) async throws -> String = Credentials.load) {
        self.preview = preview; self.http = http; self.capture = capture ?? CaptureController(); self.loadCredential = loadCredential
        chatgpt = ChatGPTRequests(http: http, preview: preview)
        if preview {
            state.conversationID = "preview"
            state.merge(["id": "sample", "speaker": "interviewer", "text": "解释滑动窗口，并给出 Python 实现。", "revision": 1])
            connection = "界面预览 · 无网络与采集"
        } else { sourceID = UserDefaults.standard.string(forKey: "capture.source") ?? "frontmost" }
        host.onFailure = { [weak self] in self?.error = $0 }
        chatgpt.onShortcut = { [weak self] in self?.requestChatGPT() }
    }
    func restoreConnection() async { guard !preview else { return }; await restoreOnce() }
    private func restoreOnce() async {
        guard !restored else { return }; restored = true
        await connect(server: Self.serviceURL, token: "", remember: false)
    }
    func connect(server: String, token: String, remember: Bool) async {
        guard !connecting, !state.active, !state.stopping, !preparing else { return }
        let epoch = await disconnect(); connecting = true
        defer { if generation == epoch { connecting = false } }
        do {
            let address = try ServerAddress(server)
            connection = "正在读取保存的登录…"
            let saved = token.isEmpty ? try await loadCredential(address.url.absoluteString) : token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == epoch else { return }
            guard !saved.isEmpty else { needsSignIn = true; connection = "请配置 Cue 登录"; return }
            let keys: SiteCredentials
            do { keys = try SiteCredentials(saved) }
            catch { needsSignIn = true; connection = "请重新配置 Cue 登录"; self.error = error.localizedDescription; return }
            http.authorizeSite(address, token: keys.site)
            connection = "正在连接…"
            let health = try await http.request(address, "/health", token: keys.device)
            guard generation == epoch else { return }
            guard health["capture_protocol"] as? String == protocolVersion else { throw SageError("服务器协议不兼容，请更新 Cue。") }
            let result = try await http.request(address, "/capture/session", method: "POST", token: keys.device, body: [:])
            guard generation == epoch else { return }
            let session = try Session(result)
            if remember { try await Credentials.save(saved, origin: address.url.absoluteString) }
            guard generation == epoch else { return }
            self.address = address; self.credentials = keys; self.session = session
            supportsAppShot = health["appshot"] as? Bool == true
            state = CaptureState(); state.conversationID = session.conversationID
            try await refreshState(epoch: epoch)
            guard generation == epoch else { return }
            connected = true; needsSignIn = false; connection = "已连接"; failures = 0; error = nil
            chatgpt.configure(address: address, session: session, supported: health["chatgpt_events"] as? Bool == true)
            try establishLinks(address, keys, epoch: epoch)
            showSettings = false
            if !preview {
                try host.start(address: address, session: session, siteToken: keys.site)
                poll = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(2))
                        guard !Task.isCancelled, let self, generation == epoch else { return }
                        do { try await refreshState(epoch: epoch); connected = true; connection = "已连接" }
                        catch { await connectionFailed(error, epoch: epoch); return }
                    }
                }
            }
        } catch {
            guard generation == epoch else { return }
            await connectionFailed(error, epoch: epoch)
        }
    }
    private func connectionFailed(_ failure: Error, epoch: UUID) async {
        guard generation == epoch else { return }
        if state.active || preparing { await stopAudio() }
        guard generation == epoch else { return }
        connected = false; initialSnapshotPending = true; error = failure.localizedDescription
        if let response = failure as? HTTPFailure, [401,403].contains(response.status) {
            links.values.forEach { $0.close() }; links = [:]; host.stop(); chatgpt.disconnect(); http.clearAuthorization()
            needsSignIn = true; connection = "请重新配置登录"; return
        }
        connection = "正在恢复连接…"; failures += 1
        guard !preview else { return }
        retry?.cancel()
        let delay = min(failures * 2, 30)
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, generation == epoch else { return }
            await connect(server: Self.serviceURL, token: "", remember: false)
        }
    }
    private func establishLinks(_ address: ServerAddress, _ keys: SiteCredentials, epoch: UUID) throws {
        #if DEBUG
        if let testEstablish { testEstablish(address, session!); return }
        #endif
        let linkEpoch = UUID(); linksGeneration = linkEpoch
        links.values.forEach { $0.close() }; links = [:]
        for role in roles {
            let link = SocketLink(url: try address.socket(interview: "current", role: role), token: keys.device, role: role, siteToken: keys.site)
            link.onEvent = { [weak self] in guard let self, generation == epoch, linksGeneration == linkEpoch else { return }; audioEvent($0, role: role) }
            link.onState = { [weak self] ready, _ in
                guard let self, generation == epoch, linksGeneration == linkEpoch else { return }
                if !ready && (state.active || preparing) && !state.stopping {
                    error = "音频连接中断；已保存文字保留，请手动重新开始。"
                    Task { await self.stopAudio() }
                }
            }
            link.onGap = { [weak self] in if self?.generation == epoch && self?.linksGeneration == linkEpoch { self?.reportGap(role) } }
            link.onExpired = { [weak self] in
                guard let self, generation == epoch, linksGeneration == linkEpoch else { return }
                Task { await self.connectionFailed(HTTPFailure(status: 401, detail: "登录已失效。"), epoch: epoch) }
            }
            links[role] = link; link.start()
        }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in Task { @MainActor in self?.pumpAudio() } }
    }
    private func refreshState(epoch: UUID) async throws {
        guard !changingRecording, let address, let session else { return }
        snapshotSerial += 1; let serial = snapshotSerial
        let result = try await http.request(address, "/capture/state", token: session.captureToken)
        guard generation == epoch, snapshotSerial == serial, !changingRecording, let recording = result["recording"] as? String else { return }
        if state.conversationID != recording {
            guard !state.active && !preparing && !state.stopping else { throw SageError("采集场次已变更，请停止后重连。") }
            state = CaptureState(); state.conversationID = recording; imageCache = [:]
            self.session?.conversationID = recording
            if let keys = credentials { try establishLinks(address, keys, epoch: epoch) }
        }
        for turn in result["turns"] as? [JSON] ?? [] { state.merge(turn) }
        var images: [JSON] = []
        for row in result["images"] as? [JSON] ?? [] {
            guard let id = row["id"] as? String else { continue }
            if let cached = imageCache[id] { images.append(cached); continue }
            let original = try await http.request(address, "/capture/images/\(id)", token: session.captureToken)
            guard generation == epoch, snapshotSerial == serial, state.conversationID == recording else { return }
            let meta = (row["meta"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? JSON } ?? [:]
            let image: JSON = ["request_id": id, "image_url": "data:\(original["mimeType"] as? String ?? "image/png");base64,\(original["data"] as? String ?? "")", "appshot": meta["appshot"] ?? [:]]
            imageCache[id] = image; images.append(image)
        }
        guard generation == epoch, snapshotSerial == serial, state.conversationID == recording else { return }
        state.screens = images; imageCache = imageCache.filter { key, _ in images.contains { $0["request_id"] as? String == key } }
        initialSnapshotPending = false
    }
    @discardableResult func disconnect() async -> UUID {
        let epoch = UUID(); generation = epoch; audioGeneration = UUID()
        retry?.cancel(); retry = nil; poll?.cancel(); poll = nil; timer?.invalidate(); timer = nil
        links.values.forEach { $0.close() }; links = [:]; host.stop(); chatgpt.disconnect(); http.clearAuthorization()
        connected = false; connecting = false; preparing = false; initialSnapshotPending = true; screenshotBusy = false
        sending = []; stoppingChannels = []; state.active = false; state.stopping = false; supportsAppShot = false
        snapshotSerial += 1; changingRecording = false; flushingRequest = false
        address = nil; credentials = nil; session = nil; imageCache = [:]; connection = "未连接"
        _ = await capture.finish(); return epoch
    }
    func perform(_ action: @escaping () async throws -> Void) { let epoch = generation; Task { do { try await action() } catch { if generation == epoch { self.error = error.localizedDescription } } } }
    func control(_ value: JSON) async throws {
        switch value["type"] as? String {
        case "stop_transcription": await stopAudio()
        case "new_transcription":
            guard connected, !preparing, !state.active, !state.stopping, !chatgpt.waiting, !flushingRequest, !screenshotBusy, let address, let session else { throw SageError("请先停止转录和投递。") }
            initialSnapshotPending = true; changingRecording = true; snapshotSerial += 1
            let epoch = generation
            defer { if generation == epoch { changingRecording = false } }
            _ = try await http.request(address, "/capture/new", method: "POST", token: session.captureToken, body: [:])
            guard generation == epoch else { return }; changingRecording = false
            try await refreshState(epoch: epoch)
        default: throw SageError("不支持的采集操作。")
        }
    }
    func requestChatGPT() {
        guard connected, !initialSnapshotPending, !screenshotBusy, !state.stopping, !preparing, !flushingRequest else { error = "请等待连接、截图或转录收尾完成。"; return }
        guard !chatgpt.waiting else { return }
        let epoch = generation, recording = state.conversationID
        let images = state.screens.compactMap { $0["request_id"] as? String }
        flushingRequest = true
        perform { [self] in
            defer { if generation == epoch { flushingRequest = false } }
            await chatgpt.refresh()
            guard generation == epoch, state.conversationID == recording else { return }
            guard chatgpt.canRequest else { showChatGPT = true; openCaptureSettings(); return }
            guard let address, let session else { return }
            let id = UUID().uuidString.lowercased()
            _ = try await http.request(address, "/api/prepare", method: "POST", token: session.captureToken,
                body: ["request_id": id, "conversation_id": recording, "image_ids": images, "local_boundary": !sending.isEmpty])
            for role in sending { try await links[role]?.send(["type": "prepare_request", "request_id": id]) }
            guard generation == epoch, state.conversationID == recording else { return }
            chatgpt.submit(conversation: recording, imageIDs: images, preparedID: id)
        }
    }
    func openFallback() {
        // The shared, authenticated page owns the manual API action and its saved result.
        guard let url = URL(string: Self.serviceURL + "/?view=fallback" + (chatgpt.requestID.map { "&request=" + $0 } ?? "")) else { return }
        NSWorkspace.shared.open(url)
    }

    func screenshot() {
        guard connected, !initialSnapshotPending, !screenshotBusy, let address, let session else { return }
        screenshotBusy = true
        let epoch = generation, recording = state.conversationID, source = sourceID
        perform { [self] in
            defer { if generation == epoch { screenshotBusy = false } }
            if source == "frontmost" || source.hasPrefix("window:") { guard supportsAppShot else { throw SageError("服务器尚未支持 App Shot。") } }
            var value = try await capture.screenshot(source: source)
            guard generation == epoch, state.conversationID == recording else { throw SageError("采集场次已变更，截图未上传。") }
            let id = UUID().uuidString.lowercased(); value["request_id"] = id; value["recording"] = recording
            _ = try await http.request(address, "/capture/images", method: "POST", token: session.captureToken, body: value)
            guard generation == epoch, state.conversationID == recording else { return }
            imageCache[id] = ["request_id": id, "image_url": value["image_data"] ?? "", "appshot": value["appshot"] ?? [:]]
            try await refreshState(epoch: epoch)
        }
    }
    func removeScreen(_ id: String) {
        guard let address, let session else { return }; let epoch = generation
        perform { [self] in
            _ = try await http.request(address, "/capture/images/\(id)", method: "DELETE", token: session.captureToken)
            guard generation == epoch else { return }; imageCache[id] = nil; try await refreshState(epoch: epoch)
        }
    }
    func loadSources() { perform { [self] in sources = try await capture.sources(); showSources = true } }
    func toggleTranscription() { perform { [self] in if state.active || state.stopping || preparing { await stopAudio() } else { try await startAudio() } } }
    private func startAudio() async throws {
        guard connected, !initialSnapshotPending, roles.allSatisfy({ links[$0]?.ready == true }) else { throw SageError("双路连接尚未就绪，请稍后重试。") }
        let epoch = generation, audio = UUID(); audioGeneration = audio; preparing = true
        do {
            try await capture.prepare()
            guard generation == epoch, audioGeneration == audio, preparing else { return }
            for role in roles { try await links[role]?.send(["type": "start"]) }
            for _ in 0..<240 {
                guard generation == epoch, audioGeneration == audio else { return }
                if roles.allSatisfy({ sending.contains($0) }) { preparing = false; state.active = true; return }
                try await Task.sleep(for: .milliseconds(50))
            }
            throw SageError("转录启动超时，请停止后重试。")
        } catch { if generation == epoch, audioGeneration == audio { await stopAudio() }; throw error }
    }
    private func stopAudio() async {
        guard !state.stopping else { return }
        let epoch = generation; audioGeneration = UUID(); state.stopping = true; preparing = false
        stoppingChannels = sending
        var complete = await capture.finish()
        guard generation == epoch else { return }
        if let sink = capture.sink {
            for role in roles {
                let tail = sink.take(role); if tail.gap { complete = false }
                if sending.contains(role) { for frame in tail.frames { if links[role]?.audio(frame) != true { complete = false } } }
            }
        }
        for role in roles { do { try await links[role]?.send(["type": "stop"]) } catch { complete = false; stoppingChannels.remove(role) } }
        sending = []; state.active = false
        for _ in 0..<240 {
            guard generation == epoch else { return }
            if stoppingChannels.isEmpty { break }; try? await Task.sleep(for: .milliseconds(50))
        }
        guard generation == epoch else { return }
        if !complete || !stoppingChannels.isEmpty { error = "音频尾句未全部确认；已保存的文字保留。" }
        stoppingChannels = []; state.stopping = false
        if let address, let keys = credentials { try? establishLinks(address, keys, epoch: epoch) }
        try? await refreshState(epoch: epoch)
    }
    private func audioEvent(_ event: JSON, role: String) {
        switch event["type"] as? String {
        case "started":
            guard preparing && !state.stopping else { Task { try? await links[role]?.send(["type": "stop"]) }; return }
            sending.insert(role); channelStatus[role] = "转录中"
        case "transcript": if let turn = event["turn"] as? JSON { state.merge(turn) }
        case "stopped":
            sending.remove(role); stoppingChannels.remove(role); channelStatus[role] = "未开启"
            if event["complete"] as? Bool != true { error = "转录中断，尾句可能不完整。" }
        case "error": error = event["detail"] as? String ?? "转录失败。"; Task { await stopAudio() }
        default: break
        }
    }
    private func pumpAudio() {
        guard !preparing, !state.stopping, let sink = capture.sink else { return }
        for role in roles {
            let batch = sink.take(role)
            if sending.contains(role) { for frame in batch.frames { links[role]?.audio(frame) }; if batch.gap { reportGap(role) } }
        }
        if let message = sink.error() { error = message; Task { await stopAudio() } }
    }
    private func reportGap(_ role: String) {
        guard Date().timeIntervalSince(lastGap) > 3 else { return }; lastGap = Date()
        channelStatus[role] = "音频出现缺口"; error = "连接积压或中断，部分音频未上传；已保存文字保留。"
    }
    #if DEBUG
    var testEstablish: ((ServerAddress, Session) -> Void)?
    var testServer: String? { address?.url.absoluteString }
    var testReadyChannels: Int { links.values.filter { $0.ready }.count }
    func testRestoreConnection() async { await restoreOnce() }
    func testSession(_ origin: String, _ value: Session) throws { address = try ServerAddress(origin); session = value; connected = true; initialSnapshotPending = false; state.conversationID = value.conversationID }
    func testCaptureLinks(_ value: [String: SocketLink]) { links = value }
    func testCaptureEvent(_ value: JSON, role: String = "interviewer") { audioEvent(value, role: role) }
    func testStartAudio() async throws { try await startAudio() }
    func testSnapshot() async throws { try await refreshState(epoch: generation) }
    #endif
}
