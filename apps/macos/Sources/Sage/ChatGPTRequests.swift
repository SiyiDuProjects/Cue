import AppKit
import Carbon
import SwiftUI
import SageCore

private typealias EventViewState<Value> = SwiftUI.State<Value>

/// One explicit keystroke creates one request. Reconnect only queries its receipt.
@MainActor final class ChatGPTRequests: ObservableObject {
    @Published var subscriptions: [JSON] = []
    @Published var selectedID = "" {
        didSet { if !preview { UserDefaults.standard.set(selectedID, forKey: "chatgpt.subscription") } }
    }
    @Published private(set) var status = "先在 ChatGPT Work 对话订阅 Cue。"
    @Published private(set) var requestID: String?
    @Published private(set) var requestStatus = ""
    @Published private(set) var refreshing = false
    @Published private(set) var posting = false
    @Published private(set) var supported = false
    @Published var shortcutEnabled: Bool {
        didSet {
            if !preview { UserDefaults.standard.set(shortcutEnabled, forKey: "chatgpt.shortcut") }
            updateShortcut()
        }
    }
    @Published private(set) var shortcutError = ""
    var onShortcut: () -> Void = {}
    private let http: HTTPClient
    private let preview: Bool
    private var address: ServerAddress?
    private var session: Session?
    private var epoch = UUID()
    private var poll: Task<Void, Never>?
    private var hotkey: AnswerHotkey?
    private var lastTrigger = Date.distantPast
    var waiting: Bool { posting || ["queued", "unknown"].contains(requestStatus) }
    var canRequest: Bool { supported && !waiting && subscriptions.contains { $0["id"] as? String == selectedID } }
    static let subscriptionPrompt = "监听 Cue 的 answer.requested，channel 设为 mac（电脑和网页共用这个订阅）。每次收到事件，使用事件的 request_id 调用 read_interview，读取这次请求固定的转录和截图；按需读取个人资料，然后在本对话用中文回答当前问题。代码题给出 Python 实现、解释和复杂度。连续追问可用上次 request_id 作为 after_request_id 读取新增与修正。"

    init(http: HTTPClient, preview: Bool = false) {
        self.http = http; self.preview = preview
        shortcutEnabled = preview ? false : (UserDefaults.standard.object(forKey: "chatgpt.shortcut") as? Bool ?? true)
        selectedID = preview ? "" : UserDefaults.standard.string(forKey: "chatgpt.subscription") ?? ""
    }
    func installShortcut() {
        guard !preview, hotkey == nil else { return }
        hotkey = AnswerHotkey { [weak self] in self?.onShortcut() }
        updateShortcut()
    }
    private func updateShortcut() {
        guard let hotkey else { return }
        shortcutError = hotkey.setEnabled(shortcutEnabled) ? "" : "全局快捷键注册失败或已被占用；仍可从菜单请求回答。"
    }
    func configure(address: ServerAddress, session: Session, supported: Bool) {
        let becameSupported = supported && !self.supported
        self.supported = supported
        guard self.address?.url != address.url || self.session?.captureToken != session.captureToken else {
            self.session = session
            if becameSupported && !preview { Task { await refresh() } }
            return
        }
        disconnect()
        self.address = address; self.session = session; self.supported = supported
        if !preview, let pending = UserDefaults.standard.string(forKey: "chatgpt.request.\(address.url.absoluteString)") {
            requestID = pending; requestStatus = "unknown"
            status = "正在查询上次请求；不会自动重发。"
            Task { await refreshReceipt() }
        }
        if supported && !preview { Task { await refresh() } }
    }
    func setSupported(_ available: Bool) { supported = available }
    func disconnect() {
        let uncertain = waiting
        epoch = UUID(); poll?.cancel(); poll = nil; address = nil; session = nil
        supported = false; subscriptions = []; posting = false; refreshing = false
        if uncertain { requestStatus = "unknown"; status = "连接中断；恢复后查询投递结果。" }
    }
    func refresh() async {
        guard !refreshing, let address, let session else { status = "请先连接 Cue。"; return }
        guard supported else { status = "服务器尚未支持 ChatGPT 订阅，请先更新服务器。"; return }
        let current = epoch
        refreshing = true
        defer { if epoch == current { refreshing = false } }
        do {
            let result = try await http.request(address, "/api/interviews/\(session.interviewID)/chatgpt-events", token: session.captureToken)
            guard epoch == current else { return }
            subscriptions = result["subscriptions"] as? [JSON] ?? []
            if !subscriptions.contains(where: { $0["id"] as? String == selectedID }) {
                selectedID = subscriptions.count == 1 ? subscriptions[0]["id"] as? String ?? "" : ""
            }
            if requestID == nil {
                status = subscriptions.isEmpty ? "尚无有效订阅。请在 ChatGPT Work 对话完成订阅后刷新。" : "订阅已就绪，回答会显示在对应的 ChatGPT 对话。"
            }
            if requestID != nil { await refreshReceipt() }
        } catch { if epoch == current { status = error.localizedDescription } }
    }
    func submit(conversation: String, imageIDs: [String], preparedID: String? = nil) {
        guard canRequest, let address, let session else {
            if !waiting { status = "请先选择有效订阅。" }
            return
        }
        // Suppress physical key repeat and accidental double taps even on fast ACKs.
        guard Date().timeIntervalSince(lastTrigger) >= 1 else { return }
        lastTrigger = Date()
        let current = epoch, id = preparedID ?? UUID().uuidString.lowercased(), subscription = selectedID
        posting = true; requestID = id; requestStatus = "unknown"; status = "正在收齐本次内容，然后通知 ChatGPT 读取…"
        if !preview { UserDefaults.standard.set(id, forKey: "chatgpt.request.\(address.url.absoluteString)") }
        Task {
            defer { if epoch == current { posting = false } }
            do {
                let result = try await http.request(address, "/api/interviews/\(session.interviewID)/chatgpt-events", method: "POST", token: session.captureToken,
                    body: ["request_id": id, "subscription_id": subscription, "conversation_id": conversation, "image_ids": imageIDs])
                guard epoch == current, requestID == id else { return }
                apply(result); startPolling()
            } catch {
                guard epoch == current, requestID == id else { return }
                if let failure = error as? HTTPFailure, [400, 401, 403, 409, 413].contains(failure.status) {
                    requestStatus = "rejected"; clearSavedRequest(); status = failure.localizedDescription
                } else {
                    requestStatus = "unknown"; status = "投递状态未确认，请查询状态并在 ChatGPT 核对；不会自动重发。"
                    startPolling()
                }
            }
        }
    }
    private func apply(_ receipt: JSON) {
        guard receipt["id"] as? String == requestID else { return }
        requestStatus = receipt["status"] as? String ?? "unknown"
        status = receipt["detail"] as? String ?? "投递状态未确认。"
        if !["queued", "unknown"].contains(requestStatus) { clearSavedRequest() }
    }
    private func clearSavedRequest() {
        if !preview, let address { UserDefaults.standard.removeObject(forKey: "chatgpt.request.\(address.url.absoluteString)") }
    }
    func refreshReceipt() async {
        guard let address, let session, let id = requestID else { return }
        let current = epoch
        do {
            let result = try await http.request(address, "/api/interviews/\(session.interviewID)/chatgpt-events/\(id)", token: session.captureToken)
            guard epoch == current, requestID == id else { return }
            apply(result)
        } catch {
            if epoch == current, requestID == id { status = "投递状态未确认。请在 ChatGPT 核对后，再开始新请求。" }
        }
    }
    private func startPolling() {
        poll?.cancel()
        let current = epoch
        poll = Task { [weak self] in
            for _ in 0..<65 {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self, epoch == current, waiting else { return }
                await refreshReceipt()
            }
        }
    }
    func cancelDelivery() async {
        guard let address, let session, let id = requestID else { return }
        let current = epoch
        do {
            let result = try await http.request(address, "/api/interviews/\(session.interviewID)/chatgpt-events/\(id)", method: "DELETE", token: session.captureToken)
            guard epoch == current, requestID == id else { return }
            apply(result)
        } catch { if epoch == current { status = error.localizedDescription } }
    }
    func acknowledgeUncertainRequest() {
        guard requestStatus == "unknown", !posting else { return }
        poll?.cancel(); poll = nil; requestStatus = "acknowledged"; clearSavedRequest()
        status = "已结束本地等待；下一次按键会创建新请求。"
    }
}

/// Carbon's registered hotkey works while Cue is in the background without
/// monitoring keystrokes or requiring Accessibility/Input Monitoring permission.
@MainActor final class AnswerHotkey {
    private var key: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    func setEnabled(_ enabled: Bool) -> Bool {
        if let key { UnregisterEventHotKey(key); self.key = nil }
        guard enabled else { return true }
        if handler == nil {
            var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let result = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let context, let event else { return OSStatus(eventNotHandledErr) }
                var id = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr,
                      id.signature == 0x53616765, id.id == 1 else { return OSStatus(eventNotHandledErr) }
                let hotkey = Unmanaged<AnswerHotkey>.fromOpaque(context).takeUnretainedValue()
                Task { @MainActor in hotkey.action() }
                return noErr
            }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard result == noErr else { return false }
        }
        let id = EventHotKeyID(signature: 0x53616765, id: 1)
        return RegisterEventHotKey(UInt32(kVK_Return), UInt32(controlKey | optionKey | cmdKey), id,
                                   GetApplicationEventTarget(), 0, &key) == noErr
    }
    deinit {
        if let key { UnregisterEventHotKey(key) }
        if let handler { RemoveEventHandler(handler) }
    }
}

struct ChatGPTSubscriptionView: View {
    @ObservedObject var requests: ChatGPTRequests
    let requestAnswer: () -> Void
    @Environment(\.dismiss) private var dismiss
    @EventViewState<Bool> private var confirmingNewRequest = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("ChatGPT 订阅").font(.title2); Spacer(); Button("完成") { dismiss() }.keyboardShortcut(.cancelAction) }
            Text("在 ChatGPT 的 Work 云端对话中连接 Cue，并发送下面的订阅要求。回答会显示在那条对话。")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                CopyButton(text: AppStore.serviceURL + "/mcp", label: "复制插件地址")
                CopyButton(text: ChatGPTRequests.subscriptionPrompt, label: "复制订阅要求")
                Link("打开 ChatGPT", destination: URL(string: "https://chatgpt.com")!)
            }
            Text("更新插件后，在 ChatGPT 插件页面重新扫描服务器，确认出现 answer.requested。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Picker("回答目标", selection: $requests.selectedID) {
                    Text("选择订阅").tag("")
                    ForEach(requests.subscriptions, id: \.eventSubscriptionID) { subscription in
                        Text("\(subscription["channel"] as? String ?? "mac") · \(String(subscription.eventSubscriptionID.suffix(6)))")
                            .tag(subscription.eventSubscriptionID)
                    }
                }
                Button("刷新") { Task { await requests.refresh() } }.disabled(requests.refreshing)
                if requests.refreshing { ProgressView().controlSize(.small) }
            }
            Toggle("全局快捷键 ⌃⌥⌘↩", isOn: $requests.shortcutEnabled)
            Text("按一次通知 ChatGPT 读取本次内容。最后一句确认后才发出通知；不会额外截图或开始录音。")
                .font(.caption).foregroundStyle(.secondary)
            if !requests.shortcutError.isEmpty { Text(requests.shortcutError).foregroundStyle(.orange) }
            Text(requests.status).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("ChatGPT 投递状态：\(requests.status)")
            HStack {
                if requests.requestID != nil {
                    Button("查询状态") { Task { await requests.refreshReceipt() } }
                    if requests.waiting { Button("停止后续投递") { Task { await requests.cancelDelivery() } }.disabled(requests.posting) }
                    if requests.requestStatus == "unknown" {
                        Button("已在 ChatGPT 核对…") { confirmingNewRequest = true }.disabled(requests.posting)
                    }
                }
                Spacer()
                Button("请 ChatGPT 回答", action: requestAnswer).buttonStyle(.borderedProminent).disabled(!requests.canRequest)
            }
        }.padding(24).frame(width: 610)
            .task { await requests.refresh() }
            .alert("结束本地等待？", isPresented: $confirmingNewRequest) {
                Button("继续等待", role: .cancel) {}
                Button("已核对，结束等待") { requests.acknowledgeUncertainRequest() }
            } message: { Text("这不会停止 ChatGPT 中可能已开始的回答。下一次按键会创建新的请求。") }
    }
}

private extension Dictionary where Key == String, Value == Any {
    var eventSubscriptionID: String { self["id"] as? String ?? "" }
}

struct ChatGPTDeliveryStatus: View {
    @ObservedObject var requests: ChatGPTRequests
    let open: () -> Void
    var body: some View {
        if requests.requestID != nil {
            Button(action: open) {
                HStack(spacing: 6) {
                    if requests.waiting { ProgressView().controlSize(.mini) }
                    Text(requests.status).font(.caption).lineLimit(2)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.caption)
                }
            }.buttonStyle(.plain).foregroundStyle(.secondary).padding(.horizontal, 4)
                .accessibilityLabel("ChatGPT：\(requests.status)，查看投递详情")
        }
    }
}
