import AppKit
import SwiftUI
import WebKit

// The command-line SwiftPM build cannot load SwiftUI's macro plugin, and the
// current SDK spells @State as a macro. The property-wrapper type still works.
private typealias ViewState<Value> = SwiftUI.State<Value>

/// Width shared by notices, captions and the answer card.
private let cardWidth: CGFloat = 560

/// The overlay: a control bar, then notices, interviewer captions and the
/// answer card, each only while it has something to show. The answer page
/// stays in the hierarchy when the card is closed because it also runs
/// transcription.
struct ChatRootView: View {
  @ObservedObject var model: ChatModel
  let web: WKWebView
  var body: some View {
    VStack(spacing: 0) {
      ControlBar(model: model)
      if !model.connected && model.status != "正在连接…" {
        Notice(text: model.status, tint: .orange) {
          Button("重新连接") { Task { await model.reconnect() } }
        }
      }
      if !model.uploadError.isEmpty {
        Notice(text: model.uploadError, tint: .red) {
          Button("重试上传", action: model.retryUploads)
        }
      } else if model.uploading > 0 {
        Notice(text: "\(model.uploading) 张截图上传中", tint: .secondary) { EmptyView() }
      }
      if !model.error.isEmpty {
        Notice(text: model.error, tint: .red) {
          Button {
            model.error = ""
          } label: {
            Image(systemName: "xmark")
          }
          .help("关闭提示")
        }
      }
      if model.captionsOn && model.audio == "active" { CaptionStrip(model: model) }
      AnswerCard(model: model, web: web)
    }
    .fixedSize()
    .onGeometryChange(for: CGSize.self) { $0.size } action: { model.resize($0) }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    // The overlay never activates Cue, so every click arrives as one.
    .allowsWindowActivationEvents(true)
  }
}

/// Behind-window blur clipped to a rounded shape. The window computes its
/// shadow from this shape's alpha.
private struct Glass: NSViewRepresentable {
  let radius: CGFloat
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    let side = radius * 2 + 1
    let mask = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    mask.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    mask.resizingMode = .stretch
    view.maskImage = mask
    return view
  }
  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

private struct Surface: ViewModifier {
  let radius: CGFloat
  func body(content: Content) -> some View {
    content
      .background(Glass(radius: radius))
      .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(.primary.opacity(0.12)))
  }
}

/// The empty part of the control bar moves the window.
private struct DragHandle: NSViewRepresentable {
  let tip: String
  final class Handle: NSView {
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  }
  func makeNSView(context: Context) -> Handle { Handle() }
  func updateNSView(_ view: Handle, context: Context) { view.toolTip = tip }
}

/// Drawn by SwiftUI rather than AppKit controls, so the first click works
/// while another app keeps focus.
private struct PillButtonStyle: ButtonStyle {
  var prominent = false
  func makeBody(configuration: Configuration) -> some View {
    PillLabel(configuration: configuration, prominent: prominent)
  }
}

private struct PillLabel: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  @Environment(\.isEnabled) private var enabled
  @ViewState private var hovering = false
  var body: some View {
    configuration.label
      .font(.system(size: 13, weight: prominent ? .semibold : .regular))
      .padding(.horizontal, 9)
      .frame(minWidth: 30, minHeight: 30)
      .foregroundStyle(prominent ? Color.white : Color.primary)
      .background(Capsule().fill(fill))
      .contentShape(Capsule())
      .opacity(enabled ? 1 : 0.4)
      .onHover { hovering = $0 }
  }
  private var fill: Color {
    if prominent { return Color.accentColor.opacity(configuration.isPressed ? 0.75 : 1) }
    return Color.primary.opacity(configuration.isPressed ? 0.16 : hovering && enabled ? 0.08 : 0)
  }
}

private struct ControlBar: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    HStack(spacing: 2) {
      Circle()
        .fill(model.connected ? Color.green : Color.secondary.opacity(0.5))
        .frame(width: 8, height: 8)
        .frame(width: 26, height: 30)
        .overlay(DragHandle(tip: model.status))
      if model.remoteOpen && model.allowRemote {
        Image(systemName: "iphone.radiowaves.left.and.right")
          .foregroundStyle(Color.accentColor)
          .frame(width: 24, height: 30)
          .help("网页已打开，可遥控此电脑")
      }
      AudioButton(model: model)
      Button {
        model.captionsOn.toggle()
      } label: {
        Image(systemName: model.captionsOn ? "captions.bubble.fill" : "captions.bubble")
      }
      .help(model.captionsOn ? "关闭面试官字幕" : "显示面试官字幕")
      Button(action: model.shot) {
        if model.working {
          ProgressView().controlSize(.mini)
        } else {
          HStack(spacing: 3) {
            Image(systemName: "camera.viewfinder")
            if !model.selected.isEmpty {
              Text("\(model.selected.count)").font(.caption.weight(.semibold)).monospacedDigit()
            }
          }
        }
      }
      .disabled(!model.connected || model.working)
      .help("截图（⌃⌥⌘S），随下一次提问发送")
      if model.sending {
        Button(action: model.cancel) {
          Label("停止", systemImage: "stop.fill")
        }
        .help("停止生成")
      } else {
        Button(action: model.ask) {
          Label("回答", systemImage: "arrow.up")
        }
        .buttonStyle(PillButtonStyle(prominent: true))
        .disabled(!model.connected || model.working || model.audioBusy)
        .help("回答当前问题（⌃⌥⌘↩）")
      }
      Divider().frame(height: 16).padding(.horizontal, 3)
      MoreMenu(model: model)
      Button {
        model.expanded.toggle()
      } label: {
        Image(systemName: model.expanded ? "chevron.up" : "chevron.down")
      }
      .help(model.expanded ? "收起" : "展开")
    }
    .buttonStyle(PillButtonStyle())
    .padding(4)
    .modifier(Surface(radius: 19))
  }
}

private struct AudioButton: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    Button(action: model.toggleAudio) {
      if model.audioBusy {
        HStack(spacing: 5) {
          ProgressView().controlSize(.mini)
          Text(model.audio == "starting" ? "开启中" : "收尾中")
        }
      } else if model.audio == "active", let since = model.audioSince {
        HStack(spacing: 6) {
          Circle().fill(Color.red).frame(width: 7, height: 7)
          TimelineView(.periodic(from: since, by: 1)) { context in
            Text(Self.clock(context.date.timeIntervalSince(since))).monospacedDigit()
          }
          if model.audioSource == "remote" {
            Text("网页").font(.caption2).foregroundStyle(.secondary)
          }
        }
      } else {
        Label("转录", systemImage: "waveform")
      }
    }
    .disabled(!model.connected || model.audioBusy)
    .help(model.audio == "active" ? "停止转录" : "开始转录")
  }
  static func clock(_ elapsed: TimeInterval) -> String {
    let s = max(0, Int(elapsed))
    return s >= 3600
      ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
      : String(format: "%02d:%02d", s / 60, s % 60)
  }
}

private struct MoreMenu: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    Menu {
      Picker("回答深度", selection: $model.effort) {
        Text("跟随网页设置").tag("")
        Text("快速").tag("low")
        Text("均衡").tag("medium")
        Text("深入").tag("high")
        Text("最深入").tag("xhigh")
      }
      .pickerStyle(.menu)
      Toggle("允许网页遥控", isOn: $model.allowRemote)
      Divider()
      Button("网页设置…", action: model.openWebSettings)
      Button("连接设置…", action: model.importConnection)
      if !ScreenAccess.granted {
        Button("打开录屏权限设置…", action: model.openPrivacy)
      }
      Divider()
      Button("隐藏（⌃⌥⌘\\）", action: model.hide)
      Button("退出 Cue") { NSApp.terminate(nil) }
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .fixedSize()
    .help("更多")
  }
}

private struct Notice<Action: View>: View {
  let text: String
  let tint: Color
  @ViewBuilder let action: () -> Action
  var body: some View {
    HStack(spacing: 8) {
      Text(text).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
      action().buttonStyle(PillButtonStyle())
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .padding(.vertical, 3)
    .frame(width: cardWidth)
    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
    .modifier(Surface(radius: 12))
    .padding(.top, 8)
  }
}

/// Two reserved lines so the card below does not jump as speech arrives.
/// The strip follows the newest words and scrolls back over the last ten
/// minutes; scrolling up keeps that position until the reader returns.
private struct CaptionStrip: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    let text = model.captionText
    ScrollView {
      Text(text.isEmpty ? "等待面试官说话…" : text)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(text.isEmpty ? .tertiary : .primary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.never)
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .frame(width: cardWidth - 28, height: 45)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .modifier(Surface(radius: 12))
    .padding(.top, 8)
    .accessibilityLabel("面试官字幕")
  }
}

private struct AnswerCard: View {
  @ObservedObject var model: ChatModel
  let web: WKWebView
  var body: some View {
    let open = model.expanded
    // Beyond half the screen the page scrolls inside the card.
    let limit = (NSScreen.main?.visibleFrame.height ?? 900) * 0.5
    let height = min(model.answerHeight, limit)
    VStack(spacing: 0) {
      AnswerView(web: web)
        .frame(height: open ? height : 0)
        .padding(.bottom, open && height > 0 ? 8 : 0)
      if open { Composer(model: model) }
    }
    .padding(open ? 10 : 0)
    .frame(width: cardWidth)
    .modifier(Surface(radius: 16))
    .opacity(open ? 1 : 0)
    .padding(.top, open ? 8 : 0)
  }
}

private struct AnswerView: NSViewRepresentable {
  let web: WKWebView
  func makeNSView(context: Context) -> WKWebView { web }
  func updateNSView(_ view: WKWebView, context: Context) {}
}

private struct Composer: View {
  @ObservedObject var model: ChatModel
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !model.selected.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(model.selected.enumerated()), id: \.element) { index, id in
              Attachment(model: model, id: id, index: index)
            }
          }
          .padding(.top, 4)
        }
      }
      HStack(alignment: .bottom, spacing: 6) {
        ZStack(alignment: .topLeading) {
          // The hidden text sizes the editor; it grows to a few lines, then scrolls.
          Text(model.text.isEmpty ? " " : model.text + " ")
            .padding(.horizontal, 5)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .hidden()
          if model.text.isEmpty {
            Text("追问或补充…")
              .foregroundStyle(.tertiary)
              .padding(.horizontal, 6)
              .padding(.vertical, 6)
              .allowsHitTesting(false)
          }
          TextEditor(text: $model.text)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.never)
            .padding(.vertical, 6)
            .onKeyPress(.return, phases: .down) { press in
              guard press.modifiers.contains(.command) else { return .ignored }
              model.ask()
              return .handled
            }
            .onKeyPress(.escape) {
              model.expanded = false
              return .handled
            }
        }
        .font(.body)
        .frame(minHeight: 30, maxHeight: 120)
        .fixedSize(horizontal: false, vertical: true)
        Text("⌘↩").font(.caption).foregroundStyle(.tertiary).padding(.bottom, 8)
        if model.sending {
          Button(action: model.cancel) {
            Image(systemName: "stop.fill")
          }
          .buttonStyle(PillButtonStyle())
          .help("停止生成")
        } else {
          Button(action: model.ask) {
            Image(systemName: "arrow.up")
          }
          .buttonStyle(PillButtonStyle(prominent: true))
          .disabled(!model.connected || model.working || model.audioBusy)
          .help("回答（⌘↩）")
        }
      }
    }
    .padding(.leading, 6)
    .padding(.trailing, 3)
    .padding(.vertical, 3)
    .background(.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator.opacity(0.6)))
  }
}

private struct Attachment: View {
  @ObservedObject var model: ChatModel
  let id: String
  let index: Int
  @ViewState private var previewing = false
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
        previewing = true
      }
      .popover(isPresented: $previewing) {
        if let picture = model.previews[id] {
          Image(nsImage: picture).resizable().scaledToFit()
            .frame(maxWidth: 720, maxHeight: 460)
            .padding(8)
        } else {
          ProgressView().padding(40)
        }
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
