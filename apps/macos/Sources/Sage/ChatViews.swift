import AppKit
import SwiftUI
import WebKit

// The command-line SwiftPM build cannot load SwiftUI's macro plugin, and the
// current SDK spells @State as a macro. The property-wrapper type still works.
private typealias ViewState<Value> = SwiftUI.State<Value>

/// The window's SwiftUI content. Controls are native; the answer column is
/// the shared web renderer, kept alive because it also runs transcription.
struct ChatRootView: View {
  @ObservedObject var model: ChatModel
  let web: WKWebView
  var body: some View {
    VStack(spacing: 0) {
      if !model.connected && model.status != "正在连接…" {
        Banner(text: model.status, tint: .orange) {
          Button("重新连接") { Task { await model.reconnect() } }
        }
      }
      if !model.error.isEmpty {
        Banner(text: model.error, tint: .red) {
          Button {
            model.error = ""
          } label: {
            Image(systemName: "xmark")
          }
          .buttonStyle(.borderless)
          .help("关闭提示")
        }
      }
      ZStack {
        AnswerView(web: web)
          .opacity(model.showTranscript ? 0 : 1)
          .allowsHitTesting(!model.showTranscript)
        if model.showTranscript { TranscriptPanel(model: model) }
      }
      Composer(model: model)
    }
    .frame(minWidth: 440, minHeight: 480)
    .background(Glass().ignoresSafeArea())
    .toolbar { ChatToolbar(model: model) }
    .sheet(
      isPresented: Binding(
        get: { model.imagePreview != nil }, set: { if !$0 { model.imagePreview = nil } })
    ) {
      if let id = model.imagePreview { ImagePreview(model: model, id: id) }
    }
  }
}

private struct Glass: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }
  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

private struct AnswerView: NSViewRepresentable {
  let web: WKWebView
  func makeNSView(context: Context) -> WKWebView { web }
  func updateNSView(_ view: WKWebView, context: Context) {}
}

private struct Banner<Action: View>: View {
  let text: String
  let tint: Color
  @ViewBuilder let action: () -> Action
  var body: some View {
    HStack(spacing: 8) {
      Text(text).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
      action().controlSize(.small)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 10))
    .padding(.horizontal, 12)
    .padding(.top, 6)
  }
}

private struct ChatToolbar: ToolbarContent {
  @ObservedObject var model: ChatModel
  @ViewState private var settings = false
  var body: some ToolbarContent {
    ToolbarItem(placement: .navigation) {
      Menu {
        ForEach(model.chats) { item in
          Button {
            model.choose(item.id)
          } label: {
            if item.id == model.chat {
              Label(item.title, systemImage: "checkmark")
            } else {
              Text(item.title)
            }
          }
        }
        Divider()
        Button("新聊天") { model.newChat() }
      } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(model.connected ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 7, height: 7)
            .help(model.status)
          Text(model.chatTitle).lineLimit(1)
        }
      }
      .disabled(model.sending || model.chats.isEmpty)
    }
    ToolbarItem(placement: .navigation) {
      Button {
        model.newChat()
      } label: {
        Label("新聊天", systemImage: "square.and.pencil")
      }
      .disabled(!model.connected || model.sending)
      .help("新聊天")
    }
    // .primaryAction sits at the leading edge on macOS; .automatic is trailing.
    ToolbarItemGroup(placement: .automatic) {
      Button(action: model.toggleAudio) {
        if model.audioBusy {
          Label(model.audio == "starting" ? "开启中" : "收尾中", systemImage: "hourglass")
        } else if model.audio == "active" {
          Label("停止转录", systemImage: "stop.circle.fill").foregroundStyle(.red)
        } else {
          Label("开始转录", systemImage: "waveform")
        }
      }
      .labelStyle(.titleAndIcon)
      .disabled(!model.connected || model.audioBusy)
      Toggle(isOn: $model.showTranscript) {
        Label(
          model.visibleTurns.isEmpty ? "转录" : "转录 \(model.visibleTurns.count)",
          systemImage: "text.bubble")
      }
      .help("转录与截图")
      Button(action: model.togglePin) {
        Label(model.pinned ? "取消置顶" : "置顶", systemImage: model.pinned ? "pin.fill" : "pin")
      }
      .help(model.pinned ? "取消置顶" : "置顶")
      Button {
        settings.toggle()
        if settings { model.loadSources() }
      } label: {
        Label("设置", systemImage: "gearshape")
      }
      .help("设置")
      .popover(isPresented: $settings, arrowEdge: .bottom) { SettingsPopover(model: model) }
    }
  }
}

private struct SettingsPopover: View {
  @ObservedObject var model: ChatModel
  @ViewState private var title = ""
  var body: some View {
    Form {
      Section {
        Picker("回答深度", selection: $model.effort) {
          Text("跟随网页设置").tag("")
          Text("快速").tag("low")
          Text("均衡").tag("medium")
          Text("深入").tag("high")
          Text("最深入").tag("xhigh")
        }
        Picker(
          "截图来源",
          selection: Binding(get: { model.source }, set: { model.selectSource($0) })
        ) {
          if model.source.isEmpty { Text("请选择").tag("") }
          ForEach(model.sources) { choice in
            Text(choice.name).tag(choice.id).selectionDisabled(choice.disabled)
          }
        }
        .disabled(model.sourceBusy)
        if model.sources.contains(where: \.needsPermission) {
          Button("打开录屏权限设置…", action: model.openPrivacy)
        }
      }
      Section {
        TextField("聊天名称", text: $title)
          .onSubmit { model.rename(title) }
      }
      Section {
        Button("新一场转录", action: model.newRecording)
          .disabled(model.audio != "idle" || model.sending || !model.connected)
        Button("更新个人资料…", action: model.uploadMaterials)
        Button("网页设置…", action: model.openWebSettings)
        Button("连接设置…", action: model.importConnection)
      }
    }
    .formStyle(.grouped)
    .frame(width: 320)
    .fixedSize(horizontal: false, vertical: true)
    .onAppear { title = model.chatTitle }
  }
}

private struct TranscriptPanel: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Header(title: "转录", detail: "最近一小时 · 电脑音频与麦克风分开记录")
        if model.visibleTurns.isEmpty {
          Text("还没有转录。").foregroundStyle(.secondary)
        }
        ForEach(model.visibleTurns) { turn in
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
              Text(turn.speaker == "candidate" ? "我" : "对方")
                .fontWeight(.semibold)
                .foregroundStyle(turn.speaker == "candidate" ? Color.primary : Color.accentColor)
              Text(Self.time(turn.created))
              if turn.status == "partial" { Text("转录中") }
              if turn.status == "interrupted" { Text("未完整确认") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(turn.text.isEmpty ? "…" : turn.text).textSelection(.enabled)
          }
        }
        if !model.images.isEmpty {
          Header(title: "截图", detail: "点选后随下一次提问发送").padding(.top, 8)
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
            ForEach(model.images) { shot in ShotTile(model: model, shot: shot) }
          }
        }
      }
      .frame(maxWidth: 760, alignment: .leading)
      .padding(20)
      .frame(maxWidth: .infinity)
    }
  }
  static func time(_ value: Double) -> String {
    Date(timeIntervalSince1970: value / 1000).formatted(date: .omitted, time: .shortened)
  }
}

private struct Header: View {
  let title: String
  let detail: String
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(title).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary)
    }
  }
}

private struct ShotTile: View {
  @ObservedObject var model: ChatModel
  let shot: SavedShot
  var body: some View {
    let chosen = model.selected.contains(shot.id)
    VStack(alignment: .leading, spacing: 4) {
      Button {
        model.toggleSelected(shot.id)
      } label: {
        ZStack(alignment: .topTrailing) {
          Group {
            if let picture = model.previews[shot.id] {
              Image(nsImage: picture).resizable().scaledToFill()
            } else {
              Text(TranscriptPanel.time(shot.created)).foregroundStyle(.secondary)
            }
          }
          .frame(maxWidth: .infinity, minHeight: 90, maxHeight: 90)
          .background(.quaternary)
          .clipped()
          if chosen {
            Image(systemName: "checkmark.circle.fill")
              .symbolRenderingMode(.palette)
              .foregroundStyle(.white, Color.accentColor)
              .font(.title3)
              .padding(6)
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
          RoundedRectangle(cornerRadius: 10)
            .strokeBorder(chosen ? Color.accentColor : .clear, lineWidth: 2))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(chosen ? "已选截图" : "截图")
      HStack {
        Button("查看") {
          model.loadPreview(shot.id)
          model.imagePreview = shot.id
        }
        Button("移除") { model.removeImage(shot.id) }.disabled(model.sending)
      }
      .buttonStyle(.borderless)
      .controlSize(.small)
    }
    .onAppear { model.loadPreview(shot.id) }
  }
}

private struct Composer: View {
  @ObservedObject var model: ChatModel
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !model.selected.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(model.selected.enumerated()), id: \.element) { index, id in
              Attachment(model: model, id: id, index: index)
            }
          }
          .padding(.horizontal, 4)
        }
      }
      ZStack(alignment: .topLeading) {
        // The hidden text sizes the editor; it grows to a few lines, then scrolls.
        Text(model.text.isEmpty ? " " : model.text + " ")
          .padding(.horizontal, 5)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .hidden()
        if model.text.isEmpty {
          Text("补充问题，或直接回答当前问题…")
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .allowsHitTesting(false)
        }
        TextEditor(text: $model.text)
          .scrollContentBackground(.hidden)
          .scrollIndicators(.never)
          .focused($focused)
          .padding(.vertical, 8)
          .onKeyPress(.return, phases: .down) { press in
            guard press.modifiers.contains(.command) else { return .ignored }
            model.ask()
            return .handled
          }
      }
      .font(.body)
      .frame(minHeight: 36, maxHeight: 160)
      .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        Button(action: model.shot) {
          if model.working {
            ProgressView().controlSize(.small)
          } else {
            Label("截图", systemImage: "camera.viewfinder")
          }
        }
        .buttonStyle(.borderless)
        .disabled(!model.connected || model.working)
        .help("按截图来源截取一张，随下一次提问发送")
        Spacer()
        Text("⌘↩").font(.caption).foregroundStyle(.tertiary)
        if model.sending {
          Button(action: model.cancel) {
            Label("停止", systemImage: "stop.fill")
          }
          .buttonStyle(.bordered)
        } else {
          Button(action: model.ask) {
            Label("回答", systemImage: "arrow.up")
          }
          .buttonStyle(.borderedProminent)
          .disabled(!model.connected || model.working || model.audioBusy)
        }
      }
      .controlSize(.regular)
    }
    .padding(10)
    .background(.background.opacity(0.92), in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.separator.opacity(0.6)))
    .shadow(color: .black.opacity(0.06), radius: 10, y: 2)
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
    .frame(maxWidth: 784)
    .onAppear { focused = true }
  }
}

private struct Attachment: View {
  @ObservedObject var model: ChatModel
  let id: String
  let index: Int
  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if let picture = model.previews[id] {
          Image(nsImage: picture).resizable().scaledToFill()
        } else {
          Text("截图 \(index + 1)").font(.caption2).foregroundStyle(.secondary)
        }
      }
      .frame(width: 60, height: 42)
      .background(.quaternary)
      .clipShape(RoundedRectangle(cornerRadius: 8))
      .onTapGesture {
        model.loadPreview(id)
        model.imagePreview = id
      }
      Button {
        model.selected.removeAll { $0 == id }
      } label: {
        Image(systemName: "xmark.circle.fill")
          .symbolRenderingMode(.palette)
          .foregroundStyle(.white, .black.opacity(0.6))
      }
      .buttonStyle(.plain)
      .padding(2)
      .help("移除附件")
    }
    .onAppear { model.loadPreview(id) }
  }
}

private struct ImagePreview: View {
  @ObservedObject var model: ChatModel
  let id: String
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      .padding(10)
      if let picture = model.previews[id] {
        Image(nsImage: picture).resizable().scaledToFit()
          .padding([.horizontal, .bottom], 12)
      } else {
        ProgressView().padding(40)
      }
    }
    .frame(minWidth: 480, idealWidth: 860, minHeight: 320, idealHeight: 600)
  }
}
