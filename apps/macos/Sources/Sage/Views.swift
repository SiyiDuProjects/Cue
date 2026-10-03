import SwiftUI
import AppKit
import SageCore

// Explicit property-wrapper alias also builds with CLT SDKs that omit SwiftUI macro plugins.
private typealias ViewState<Value> = SwiftUI.State<Value>

struct MainView: View {
    @ObservedObject var store: AppStore
    @ViewState<String> private var rename = ""
    @ViewState<Bool> private var renaming = false
    @ViewState<Bool> private var newTranscription = false
    @ViewState<Bool> private var following = true
    @ViewState<Bool> private var userScrolling = false
    @ViewState<Bool> private var atBottom = true
    var body: some View {
        VStack(spacing: 0) {
            if let error = store.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    Text(error).font(.callout).textSelection(.enabled)
                    Spacer()
                    Button { store.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("关闭提示")
                }.padding(12).background(Color.orange.opacity(0.08))
            }
            if !store.connected && !store.preview && store.state.messages.isEmpty {
                ContentUnavailableView {
                    Label("准备好下一场对话", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("连接服务器后即可聊天。开始转录时才会申请音频权限。")
                } actions: {
                    Button("连接 Sage") { store.showSettings = true }.buttonStyle(.borderedProminent)
                }
            } else {
                conversation
            }
            Divider()
            composer
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { store.listConversations() } label: { Label(store.state.title, systemImage: "sidebar.left") }
                    .disabled(!store.connected).help("查看历史会话")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { store.toggleTranscription() } label: {
                    Label(store.preparing ? "准备音频…" : store.state.stopping ? "正在收尾…" : store.state.active ? "停止转录" : "开始转录",
                          systemImage: store.state.active ? "stop.circle.fill" : "waveform")
                }.disabled(!store.connected || store.preparing || store.state.stopping)
                Button { store.showTranscript = true } label: { Label("查看转录", systemImage: "text.bubble") }
                    .disabled(!store.connected && store.state.transcripts.isEmpty)
            }
        }
        .sheet(isPresented: $store.showSettings) { ConnectionView(store: store) }
        .sheet(isPresented: $store.showHistory) { history }
        .sheet(isPresented: $store.showTranscript) { transcript }
        .sheet(isPresented: $store.showSources) { sourcePicker }
        .sheet(isPresented: Binding(get: { store.previewImage != nil }, set: { if !$0 { store.previewImage = nil } })) {
            VStack {
                HStack { Text("截图原图").font(.headline); Spacer(); Button("完成") { store.previewImage = nil } }
                if let image = store.previewImage { Image(nsImage: image).resizable().scaledToFit() }
                if !store.previewText.isEmpty { ScrollView { Text(store.previewText).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220) }
            }.padding(20).frame(minWidth: 600, minHeight: 400)
        }
        .alert("停止回答并切换对话？", isPresented: $store.pendingSwitch) {
            Button("取消", role: .cancel) {}
            Button("停止并切换") { store.confirmSwitch() }
        } message: { Text("已显示的回答会保留，转录继续运行。") }
        .alert("重命名会话", isPresented: $renaming) {
            TextField("会话名称", text: $rename)
            Button("取消", role: .cancel) {}
            Button("保存") { store.rename(rename) }
        }
        .alert("新一场转录", isPresented: $newTranscription) {
            Button("取消", role: .cancel) {}
            Button("开始新一场") { store.perform { try await store.control(["type": "new_transcription"]) } }
        } message: { Text("建立新的转录边界，旧转录和聊天仍然保留。") }
        .alert("允许连接到 Sage？", isPresented: Binding(get: { store.pairing != nil }, set: { if !$0 { store.decidePairing(false) } })) {
            Button("拒绝", role: .cancel) { store.decidePairing(false) }
            Button("允许") { store.decidePairing(true) }
        } message: { Text(store.pairing?["text"] as? String ?? "新的浏览器请求连接。") }
    }
    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if store.state.messages.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 36)).foregroundStyle(.secondary)
                            Text("从一个问题开始").font(.title2.weight(.semibold))
                            Text("输入问题、附上截图，或开始转录积累上下文。\n点击「回答」时，才会生成答案。")
                                .multilineTextAlignment(.center).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity).padding(.vertical, 90)
                    }
                    ForEach(store.state.messages) { message in
                        VStack(alignment: .leading, spacing: 16) {
                            HStack {
                                Spacer(minLength: 80)
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(message.text).textSelection(.enabled)
                                    if !message.screens.isEmpty { attachments(message.screens, removable: false) }
                                }.padding(14).background(Color.accentColor.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
                            }
                            if let answer = store.state.answers[message.responseID] {
                                HStack(spacing: 6) {
                                    Image(systemName: "sparkle")
                                    Text(message.provider == "responses" ? "Responses API" : "Codex")
                                    Text("· \(["default": "通用", "brief": "临场短答", "ood": "对象设计"][message.profile] ?? "通用")")
                                    Spacer()
                                    Button { copy(answer.text) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).help("复制完整回答")
                                }.font(.caption).foregroundStyle(.secondary)
                                if !answer.activities.isEmpty {
                                    DisclosureGroup("操作记录") {
                                        ForEach(answer.activities.indices, id: \.self) { index in
                                            Text(answer.activities[index]["label"] as? String ?? "读取资料").font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                    }.foregroundStyle(.secondary)
                                }
                                MarkdownAnswer(text: answer.text)
                                if answer.status == "streaming" { ProgressView().controlSize(.small) }
                                else if answer.status != "completed" { Text(answer.detail.isEmpty ? "回答已停止，已显示内容保留。" : answer.detail).font(.caption).foregroundStyle(.secondary) }
                            } else { HStack { ProgressView().controlSize(.small); Text("正在准备回答…").foregroundStyle(.secondary) } }
                        }.id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(28).frame(maxWidth: 850).frame(maxWidth: .infinity)
            }
            .onScrollPhaseChange { _, phase in userScrolling = phase == .interacting || phase == .decelerating }
            .onScrollGeometryChange(for: Bool.self) { geometry in geometry.contentSize.height - geometry.visibleRect.maxY < 36 } action: { _, bottom in
                atBottom = bottom
                if userScrolling { following = bottom }
            }
            .onChange(of: store.state.messages.count) { _, _ in if following { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: store.state.answers.values.reduce(0) { $0 + $1.text.count }) { _, _ in if following { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: store.state.conversationID) { _, _ in following = true; proxy.scrollTo("bottom", anchor: .bottom) }
            .overlay(alignment: .bottomTrailing) {
                if !following && !atBottom {
                    Button { following = true; proxy.scrollTo("bottom", anchor: .bottom) } label: { Label("回到最新", systemImage: "arrow.down") }
                        .buttonStyle(.bordered).padding(16)
                }
            }
        }
    }
    private var composer: some View {
        VStack(spacing: 10) {
            if !store.state.screens.isEmpty { attachments(store.state.screens, removable: true) }
            ZStack(alignment: .topLeading) {
                if store.draft.isEmpty { Text("输入问题，或直接点击回答…").foregroundStyle(.tertiary).padding(.horizontal, 8).padding(.vertical, 9) }
                NativeComposer(text: $store.draft, enabled: store.connected) { following = true; store.send() }
                    .frame(height: 80).accessibilityLabel("消息")
            }
            HStack(spacing: 12) {
                Button { store.screenshot() } label: { Label("App Shot", systemImage: "camera") }
                    .disabled(!store.connected || store.initialSnapshotPending || store.screenshotBusy).keyboardShortcut("s", modifiers: [.command, .shift])
                Menu {
                    Button("新对话") { store.switchTo(nil) }.disabled(!store.connected)
                    Button("重命名当前会话") { rename = store.state.title; renaming = true }.disabled(!store.connected)
                    Button("截图来源…") { store.loadSources() }
                    Button("新一场转录…") { newTranscription = true }.disabled(!store.connected || store.state.active || store.state.stopping)
                    Divider()
                    Button("连接设置…") { store.showSettings = true }
                    Button("打开资料目录") { NSWorkspace.shared.open(LocalFiles.root.appendingPathComponent("assistant-workspace/materials")) }
                } label: { Image(systemName: "ellipsis") }.help("更多")
                Picker("回答方式", selection: $store.provider) { Text("Responses API").tag("responses"); Text("Codex").tag("codex") }.labelsHidden().frame(width: 142)
                Picker("回答偏好", selection: $store.profile) { Text("通用").tag("default"); Text("临场短答").tag("brief"); Text("对象设计").tag("ood") }.labelsHidden().frame(width: 100)
                Spacer(minLength: 0)
                Button { following = true; store.send() } label: {
                    Label(store.busy ? "停止" : store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "回答" : "发送", systemImage: store.busy ? "stop.fill" : "arrow.up")
                }.buttonStyle(.borderedProminent).disabled(!store.connected || (store.pendingSend != nil && store.state.busyID == nil))
            }
            HStack {
                Circle().fill(store.connected ? Color.green : Color.secondary).frame(width: 5, height: 5)
                Text(store.connection).lineLimit(1)
                Spacer()
                if store.state.active || store.preparing {
                    Text("系统音频：\(store.channelStatus["interviewer"] ?? "") · 麦克风：\(store.channelStatus["candidate"] ?? "")").lineLimit(1)
                } else { Text("Enter 发送 · Shift–Enter 换行") }
            }.font(.caption2).foregroundStyle(.secondary)
        }.padding(16)
    }
    private func attachments(_ screens: [JSON], removable: Bool) -> some View {
        ScrollView(.horizontal) {
            HStack {
                ForEach(screens.indices, id: \.self) { index in
                    if let image = decodedImage(screens[index]["image_url"] as? String) {
                        HStack(alignment: .top) {
                            Button {
                                store.previewImage = image
                                let shot = screens[index]["appshot"] as? JSON ?? [:]
                                store.previewText = [shot["app_name"] as? String, shot["window_title"] as? String, shot["detail"] as? String, shot["text"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
                            } label: { Image(nsImage: image).resizable().scaledToFit().frame(width: 112, height: 68) }.buttonStyle(.plain)
                            if removable { Button { store.removeScreen(screens[index]["request_id"] as? String ?? "") } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).help("移除截图") }
                        }.padding(6).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }
    private var history: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("历史会话").font(.title2); Spacer(); Button("新对话") { store.switchTo(nil) }; Button("完成") { store.showHistory = false } }
            List(store.conversations.indices, id: \.self) { index in
                let row = store.conversations[index]
                Button { if let id = row["interview_id"] as? String { store.switchTo(id) } } label: {
                    HStack { Image(systemName: "bubble.left"); Text(row["title"] as? String ?? "新对话"); Spacer() }.padding(.vertical, 6)
                }.buttonStyle(.plain)
            }
        }.padding(20).frame(width: 520, height: 440)
    }
    private var transcript: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("共享转录").font(.title2); Spacer(); Button("完成") { store.showTranscript = false } }
            if store.state.transcripts.isEmpty { ContentUnavailableView("还没有转录", systemImage: "waveform", description: Text("开始转录后，两路语音会按时间积累在这里。")) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(store.state.transcripts.indices, id: \.self) { index in
                        let turn = store.state.transcripts[index]
                        VStack(alignment: .leading, spacing: 5) {
                            Text(turn["speaker"] as? String == "candidate" ? "我 · 麦克风" : "对方 · 系统音频").font(.caption).foregroundStyle(.secondary)
                            Text(turn["text"] as? String ?? "").textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }.padding(24).frame(width: 640, height: 500)
    }
    private var sourcePicker: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("截图来源").font(.title2)
            ScrollView { Picker("屏幕或窗口", selection: $store.sourceID) {
                Text("上一个应用窗口（App Shot）").tag("frontmost")
                Text("主显示器").tag("primary")
                ForEach(store.sources) { Text($0.name).tag($0.id) }
            }.pickerStyle(.radioGroup).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 420)
            HStack { Spacer(); Button("完成") { store.showSources = false } }
        }.padding(24).frame(width: 520)
    }
}

struct ConnectionView: View {
    @ObservedObject var store: AppStore
    @ViewState<String> private var server = ""
    @ViewState<String> private var token = ""
    @ViewState<String> private var codex = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("连接 Sage").font(.title2.weight(.semibold))
            Form {
                TextField("服务器", text: $server)
                SecureField("电脑访问凭证", text: $token)
                Text("留空可使用已保存在本机钥匙串中的凭证。此处不是 OpenAI API key。").font(.caption).foregroundStyle(.secondary)
                TextField("Codex CLI 路径（可选）", text: $codex)
                HStack { Button(store.loggingIn ? "正在登录…" : "登录 Codex") { store.loginCodex(codex) }.disabled(store.loggingIn); Text(store.loginStatus).font(.caption).foregroundStyle(.secondary) }
            }.textFieldStyle(.roundedBorder)
            if let error = store.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("取消") { store.showSettings = false }.keyboardShortcut(.cancelAction)
                Spacer()
                if store.connecting { ProgressView().controlSize(.small) }
                Button("保存并连接") { Task { await store.connect(server: server, token: token, codex: codex, remember: true) } }
                    .buttonStyle(.borderedProminent).disabled(store.connecting).keyboardShortcut(.defaultAction)
            }
        }.padding(28).frame(width: 540)
            .onAppear { server = store.serverText; codex = store.codexPath }
    }
}

struct MarkdownAnswer: View {
    let text: String
    private var blocks: [(String, Bool)] {
        // Keep source text untouched for copies, including unclosed streamed code fences.
        let parts = text.components(separatedBy: "```")
        return parts.enumerated().map { index, content in
            if index % 2 == 1 {
                if let newline = content.firstIndex(of: "\n") { return (String(content[content.index(after: newline)...]), true) }
                return ("", true)
            }
            return (content, false)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks.indices, id: \.self) { index in
                let (value, code) = blocks[index]
                if code {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text("代码").font(.caption).foregroundStyle(.secondary); Spacer(); Button("复制代码") { copy(value) }.buttonStyle(.plain).font(.caption) }
                        ScrollView(.horizontal) { Text(value).font(.system(.body, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: false) }
                    }.padding(14).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(value.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, paragraph in
                            let level = paragraph.prefix(while: { $0 == "#" }).count
                            let heading = (1...6).contains(level) && paragraph.dropFirst(level).hasPrefix(" ")
                            let content = heading ? String(paragraph.dropFirst(level + 1)) : paragraph
                            Text((try? AttributedString(markdown: content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(content))
                                .font(heading ? (level < 3 ? .title3.weight(.semibold) : .headline) : .body)
                                .textSelection(.enabled).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }
}

func copy(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
func decodedImage(_ value: String?) -> NSImage? {
    guard let value, value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","),
          let data = Data(base64Encoded: String(value[value.index(after: comma)...])) else { return nil }
    return NSImage(data: data)
}

struct NativeComposer: NSViewRepresentable {
    @Binding var text: String
    let enabled: Bool
    let onSend: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let editor = ComposerTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 80))
        editor.minSize = NSSize(width: 0, height: 80)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.isRichText = false; editor.drawsBackground = false
        editor.font = .systemFont(ofSize: 14); editor.textContainerInset = NSSize(width: 4, height: 7)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        editor.delegate = context.coordinator; editor.onSend = onSend
        editor.setAccessibilityLabel("消息")
        scroll.documentView = editor; scroll.drawsBackground = false
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? ComposerTextView else { return }
        if editor.string != text && !editor.hasMarkedText() { editor.string = text }
        editor.isEditable = enabled; editor.onSend = onSend
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeComposer
        init(_ parent: NativeComposer) { self.parent = parent }
        func textDidChange(_ notification: Notification) { if let editor = notification.object as? NSTextView { parent.text = editor.string } }
    }
}
final class ComposerTextView: NSTextView {
    var onSend: () -> Void = {}
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 && !event.modifierFlags.contains(.shift) && !hasMarkedText() {
            if !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onSend() }
        } else { super.keyDown(with: event) }
    }
}
