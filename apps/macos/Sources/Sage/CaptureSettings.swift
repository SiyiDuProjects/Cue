import SwiftUI
import AppKit
import SageCore

private typealias CaptureViewState<Value> = SwiftUI.State<Value>

/// The desktop is a capture utility. The subscribed ChatGPT chat owns answers.
struct CaptureSettingsView: View {
    @ObservedObject var store: AppStore
    @ObservedObject var requests: ChatGPTRequests
    @CaptureViewState<Bool> private var newTranscription = false

    init(store: AppStore) { self.store = store; requests = store.chatgpt }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Image(systemName: "waveform").font(.title2).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Cue").font(.title2.weight(.semibold))
                        Text("在电脑上采集，在 ChatGPT 中回答。").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label(store.connection, systemImage: store.connected ? "checkmark.circle" : "network")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = store.error {
                    HStack(alignment: .top) {
                        Label(error, systemImage: "exclamationmark.circle").textSelection(.enabled)
                        Spacer(minLength: 8)
                        Button { store.error = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).accessibilityLabel("关闭提示")
                    }.padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
                }
                GroupBox("采集") {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Label(recordingStatus, systemImage: store.state.active ? "waveform.circle.fill" : "waveform.circle")
                            Spacer()
                            Button(store.state.active ? "停止转录" : "开始转录") { store.toggleTranscription() }
                                .disabled(!store.connected || store.preparing || store.state.stopping)
                        }
                        if store.state.active || store.state.stopping || store.preparing {
                            Text("系统音频：\(store.channelStatus["interviewer"] ?? "未开启")\n麦克风：\(store.channelStatus["candidate"] ?? "未开启")")
                                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        HStack {
                            Button("查看转录") { store.showTranscript = true }
                            Button("新一场…") { newTranscription = true }
                                .disabled(!store.connected || store.state.active || store.state.stopping || store.preparing || requests.waiting)
                            Spacer()
                            Button(store.screenshotBusy ? "正在截图…" : "截图") { store.screenshot() }
                                .disabled(!store.connected || store.initialSnapshotPending || store.screenshotBusy)
                            Button("截图来源…") { store.loadSources() }
                        }
                        Text("开始转录后才使用音频。截图和请求回答都由你手动触发。")
                            .font(.caption).foregroundStyle(.secondary)
                        if !store.state.screens.isEmpty { screenshots }
                    }.padding(10)
                }
                GroupBox("ChatGPT") {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(requests.status).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("投递状态：\(requests.status)")
                        HStack {
                            Button("管理订阅…") { store.showChatGPT = true }
                            Button("API 备用…") { store.openFallback() }
                            Spacer()
                            Button("请 ChatGPT 回答") { store.requestChatGPT() }
                                .buttonStyle(.borderedProminent)
                                .disabled(!store.connected || requests.waiting || store.screenshotBusy || store.initialSnapshotPending)
                        }
                        Toggle("全局快捷键 ⌃⌥⌘↩", isOn: $requests.shortcutEnabled)
                        if !requests.shortcutError.isEmpty { Text(requests.shortcutError).foregroundStyle(.orange) }
                        Text("快捷键通知 ChatGPT 读取本次内容，回答显示在订阅对话。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(10)
                }
                HStack {
                    Button(store.connected ? "登录设置…" : "登录 Cue…") { store.showSettings = true }
                    Spacer()
                    Link("打开 ChatGPT", destination: URL(string: "https://chatgpt.com")!)
                }
            }.padding(24)
        }
        .frame(minWidth: 540, idealWidth: 580, minHeight: 480)
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $store.showSettings) { ConnectionView(store: store) }
        .sheet(isPresented: $store.showChatGPT) { ChatGPTSubscriptionView(requests: requests, requestAnswer: store.requestChatGPT) }
        .sheet(isPresented: $store.showSources) { sources }
        .sheet(isPresented: $store.showTranscript) { transcript }
        .sheet(isPresented: Binding(get: { store.previewImage != nil }, set: { if !$0 { store.previewImage = nil } })) {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("截图原图").font(.headline); Spacer(); Button("完成") { store.previewImage = nil } }
                if let image = store.previewImage { Image(nsImage: image).resizable().scaledToFit() }
                if !store.previewText.isEmpty { ScrollView { Text(store.previewText).textSelection(.enabled) }.frame(maxHeight: 180) }
            }.padding(20).frame(width: 680, height: 520)
        }
        .alert("新一场转录", isPresented: $newTranscription) {
            Button("取消", role: .cancel) {}
            Button("开始新一场") { store.perform { try await store.control(["type": "new_transcription"]) } }
        } message: { Text("建立新的转录边界，已保存的记录保留。") }

    }

    private var recordingStatus: String {
        store.preparing ? "准备音频…" : store.state.stopping ? "正在保存最后一句…" : store.state.active ? "正在转录" : "转录未开启"
    }
    private var screenshots: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("已收集 \(store.state.screens.count) 张截图").font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(store.state.screens.indices, id: \.self) { index in
                        let screen = store.state.screens[index]
                        if let image = decodedImage(screen["image_url"] as? String) {
                            VStack(spacing: 6) {
                                Button {
                                    store.previewImage = image
                                    store.previewText = (screen["appshot"] as? JSON)?["text"] as? String ?? ""
                                } label: {
                                    Image(nsImage: image).resizable().scaledToFit().frame(width: 120, height: 76)
                                }.buttonStyle(.plain).accessibilityLabel("查看截图 \(index + 1)")
                                Button("移除") { store.removeScreen(screen["request_id"] as? String ?? "") }
                                    .font(.caption).disabled(!store.connected || requests.posting)
                            }
                        }
                    }
                }
            }
        }
    }
    private var sources: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("截图来源").font(.title3.weight(.semibold))
            ScrollView {
                Picker("来源", selection: $store.sourceID) {
                    Text("当前应用窗口").tag("frontmost")
                    Text("主显示器").tag("primary")
                    ForEach(store.sources) { Text($0.name).tag($0.id) }
                }.pickerStyle(.radioGroup).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 340)
            Text("所选窗口消失时会提示，不会自动改为截取整个屏幕。")
                .font(.caption).foregroundStyle(.secondary)
            HStack { Spacer(); Button("完成") { store.showSources = false } }
        }.padding(24).frame(width: 500)
    }
    private var transcript: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("转录").font(.title3.weight(.semibold)); Spacer(); Button("完成") { store.showTranscript = false } }
            if store.state.transcripts.isEmpty { Text("还没有转录。开始转录后，两路语音会按时间保存。").foregroundStyle(.secondary) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(store.state.transcripts.indices, id: \.self) { index in
                        let turn = store.state.transcripts[index]
                        VStack(alignment: .leading, spacing: 4) {
                            Text(turn["speaker"] as? String == "candidate" ? "我 · 麦克风" : "对方 · 系统音频").font(.caption).foregroundStyle(.secondary)
                            Text(turn["text"] as? String ?? "").textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }.padding(24).frame(width: 600, height: 460)
    }
}

struct CaptureMenu: View {
    @ObservedObject var store: AppStore
    @ObservedObject var requests: ChatGPTRequests
    @Environment(\.openWindow) private var openWindow
    init(store: AppStore) { self.store = store; requests = store.chatgpt }
    var body: some View {
        Text(store.state.stopping ? "转录正在收尾…" : store.state.active ? "正在转录" : store.connection)
        Button(store.state.active ? "停止转录" : "开始转录") { store.toggleTranscription() }
            .disabled(!store.connected || store.preparing || store.state.stopping)
        Button(store.screenshotBusy ? "正在截图…" : "截图") { store.screenshot() }
            .disabled(!store.connected || store.initialSnapshotPending || store.screenshotBusy)
        Button("请 ChatGPT 回答 · ⌃⌥⌘↩") { store.requestChatGPT() }
            .disabled(!store.connected || requests.waiting || store.initialSnapshotPending || store.screenshotBusy)
        if requests.requestID != nil { Text(requests.status) }
        Divider()
        Button("设置…") { openWindow(id: "sage"); NSApp.activate(ignoringOtherApps: true) }.keyboardShortcut(",")
        Button("API 备用回答…") { store.openFallback() }
        Button("打开 ChatGPT") { NSWorkspace.shared.open(URL(string: "https://chatgpt.com")!) }
        Divider()
        Button("退出 Cue") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

struct CaptureStatusLabel: View {
    @ObservedObject var store: AppStore
    let delegate: AppDelegate
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Label("Cue", systemImage: store.state.active ? "waveform.circle.fill" : "waveform.circle")
            .onAppear {
                delegate.store = store
                store.openCaptureSettings = { openWindow(id: "sage"); NSApp.activate(ignoringOtherApps: true) }
                store.chatgpt.installShortcut()
            }
            .task { await store.restoreConnection() }
            .onChange(of: store.needsSignIn) { _, needed in if needed { store.openCaptureSettings() } }
            .onChange(of: store.error) { _, error in if error != nil { store.openCaptureSettings() } }
    }
}
