import AppKit
import SageCore
import SwiftUI
import WebKit

/// Borderless overlay. It floats over full-screen apps on every Space and
/// never activates Cue, so the meeting or browser keeps focus; it becomes key
/// only when the user clicks into the text field.
final class OverlayPanel: NSPanel {
  var onCancel: () -> Void = {}
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func cancelOperation(_ sender: Any?) { onCancel() }
}

/// Lets the first click land on a control while another app is active.
private final class OverlayHost<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
/// The same for the answer page's copy and paging buttons.
private final class AnswerWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Native overlay with SwiftUI controls. The embedded page renders answers and
/// runs the shared transcription client; it gets PCM and events from here.
@MainActor final class ChatWindow: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let window: OverlayPanel
  let web: WKWebView
  let store: AppStore
  let model: ChatModel
  private let transcript: TranscriptWindow
  private let ui: URL
  private var page: URL { ui.appendingPathComponent("content.html") }
  /// Top-center point the user dragged the overlay to; content grows down.
  private var anchor = NSPoint.zero
  private var fitting = false
  private static let anchorKey = "cue.overlay.anchor"
  init(store: AppStore) {
    self.store = store
    model = ChatModel(store: store)
    transcript = TranscriptWindow(model: model)
    ui = Bundle.main.resourceURL!.appendingPathComponent("ui", isDirectory: true)
    let controller = WKUserContentController()
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = controller
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // Transcription runs in this page; keep it scheduled while hidden.
    configuration.preferences.inactiveSchedulingPolicy = .none
    web = AnswerWebView(frame: .zero, configuration: configuration)
    window = OverlayPanel(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 40),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    super.init()
    window.title = "Cue"
    window.isFloatingPanel = true
    window.level = .floating
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.becomesKeyOnlyIfNeeded = true
    window.hidesOnDeactivate = false
    window.isMovableByWindowBackground = true
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    window.isReleasedWhenClosed = false
    let host = OverlayHost(rootView: ChatRootView(model: model, web: web))
    // The window follows the content size reported by the root view.
    host.sizingOptions = []
    window.contentView = host
    window.onCancel = { [weak self] in self?.model.expanded = false }
    place()
    NotificationCenter.default.addObserver(
      self, selector: #selector(moved), name: NSWindow.didMoveNotification, object: window)
    web.setValue(false, forKey: "drawsBackground")
    controller.add(self, name: "cue")
    controller.addUserScript(
      WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web.navigationDelegate = self
    store.onEvent = { [weak self] value in self?.emit(value) }
    model.render = { [weak self] value in self?.send(value) }
    model.resize = { [weak self] size in self?.fit(size) }
    model.hide = { [weak self] in self?.window.orderOut(nil) }
    model.openTranscript = { [weak self] in self?.transcript.show() }
    web.loadFileURL(page, allowingReadAccessTo: ui)
  }
  func show() { window.orderFrontRegardless() }
  func toggle() { window.isVisible ? window.orderOut(nil) : show() }
  /// The saved point if it is still on a screen, else just under the menu bar
  /// at the center of the main screen, near the camera.
  private func place() {
    let saved = UserDefaults.standard.string(forKey: Self.anchorKey).map(NSPointFromString)
    if let saved, NSScreen.screens.contains(where: { $0.frame.contains(saved) }) {
      anchor = saved
    } else if let screen = NSScreen.main?.visibleFrame {
      anchor = NSPoint(x: screen.midX, y: screen.maxY - 8)
    }
    fit(window.frame.size)
  }
  private func fit(_ size: CGSize) {
    let width = ceil(size.width), height = ceil(size.height)
    guard width > 0, height > 0 else { return }
    var frame = NSRect(
      x: round(anchor.x - width / 2), y: anchor.y - height, width: width, height: height)
    // Near the bottom edge the card grows upward instead of off screen.
    if let screen = (window.screen ?? NSScreen.main)?.visibleFrame, frame.minY < screen.minY {
      frame.origin.y = screen.minY
    }
    guard frame != window.frame else { return }
    fitting = true
    window.setFrame(frame, display: true)
    fitting = false
    // The shadow follows the drawn shapes; recompute once they are redrawn.
    DispatchQueue.main.async { [weak window] in window?.invalidateShadow() }
  }
  @objc private func moved() {
    guard !fitting else { return }
    anchor = NSPoint(x: window.frame.midX, y: window.frame.maxY)
    // Preview mode shares the installed app's defaults domain; never write it.
    if !store.preview {
      UserDefaults.standard.set(NSStringFromPoint(anchor), forKey: Self.anchorKey)
    }
  }
  /// Every event reaches the page (transcription needs PCM and ASR events)
  /// and the native model (controls and chat state).
  func emit(_ value: JSON) {
    send(value)
    model.handle(value)
  }
  private func send(_ value: JSON) {
    web.callAsyncJavaScript(
      "window.cueReceive(value)", arguments: ["value": value], in: nil, in: .page
    ) { _ in }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Events sent before the page loaded were dropped; show the current chat.
    model.sendRender()
  }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame,
      message.frameInfo.request.url?.standardizedFileURL == page.standardizedFileURL,
      let value = message.body as? JSON, let id = value["id"] as? String,
      let method = value["method"] as? String
    else { return }
    let args = value["args"] as? [Any] ?? []
    // Display updates apply in arrival order, so a caption never goes back
    // to an older partial.
    if method == "caption" || method == "height" {
      if method == "caption", let caption = args.first as? JSON { model.caption(caption) }
      if method == "height", let height = args.first as? NSNumber {
        model.answerHeight = max(0, CGFloat(truncating: height))
      }
      reply(id, [:] as JSON, nil)
      return
    }
    // Preserve receipt order without creating independently scheduled Tasks for
    // commit/ask markers forwarded by the shared transcription module.
    if method == "command", let command = args.first as? JSON,
      command["type"] as? String == "asr_forward", let event = command["message"] as? JSON
    {
      do {
        try store.forwardTranscription(event)
        reply(id, [:] as JSON, nil)
      } catch {
        reply(id, nil, error.localizedDescription)
      }
      return
    }
    Task {
      do {
        reply(id, try await invoke(method, args), nil)
      } catch {
        reply(id, nil, error.localizedDescription)
      }
    }
  }
  private func reply(_ id: String, _ result: Any?, _ error: String?) {
    web.callAsyncJavaScript(
      "window.cueReply(id,result,error)",
      arguments: ["id": id, "result": result ?? NSNull(), "error": error ?? NSNull()], in: nil,
      in: .page
    ) { _ in }
  }
  /// The page asks for the current chat when ready, stops audio when its
  /// transcription client fails, and copies answers.
  private func invoke(_ method: String, _ args: [Any]) async throws -> Any {
    switch method {
    case "ready": model.sendRender()
    case "audio": try await store.audio(args.first as? Bool == true)
    case "copy":
      if let text = args.first as? String, text.count < 250000 {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
      }
    default: throw SageError("不支持的操作。")
    }
    return [:] as JSON
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.standardizedFileURL == page.standardizedFileURL {
      decisionHandler(.allow)
    } else {
      if navigationAction.navigationType == .linkActivated, url.scheme == "https" {
        NSWorkspace.shared.open(url)
      }
      decisionHandler(.cancel)
    }
  }
  static let bridge = """
    (() => {
      const pending = new Map();
      const call = (method,...args) => new Promise((resolve,reject) => {
        const id = crypto.randomUUID();
        pending.set(id,{resolve,reject});
        window.webkit.messageHandlers.cue.postMessage({id,method,args});
      });
      window.cueReply = (id,result,error) => {
        const p=pending.get(id); if(!p)return; pending.delete(id);
        error?p.reject(new Error(error)):p.resolve(result);
      };
      window.cueReceive = value => window.dispatchEvent(new CustomEvent('cue:event',{detail:value}));
      window.cue = Object.fromEntries(['command','audio','copy','ready','caption','height'].map(method=>[method,(...args)=>call(method,...args)]));
    })();
    """
}

/// Ordinary window for the full transcript and screenshot picker.
@MainActor final class TranscriptWindow {
  private let model: ChatModel
  private var window: NSWindow?
  init(model: ChatModel) { self.model = model }
  func show() {
    let window = self.window ?? make()
    self.window = window
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }
  private func make() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered,
      defer: false)
    window.title = "转录与截图"
    window.isReleasedWhenClosed = false
    window.contentViewController = NSHostingController(rootView: TranscriptRoot(model: model))
    if !window.setFrameUsingName("CueTranscript") { window.center() }
    window.setFrameAutosaveName("CueTranscript")
    return window
  }
}
