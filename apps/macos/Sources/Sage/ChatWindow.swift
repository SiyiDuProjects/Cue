import AppKit
import SageCore
import SwiftUI
import WebKit

/// Native window with SwiftUI controls. The embedded page renders answers and
/// runs the shared transcription client; it gets PCM and events from here.
@MainActor final class ChatWindow: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let window: NSWindow
  let web: WKWebView
  let store: AppStore
  let model: ChatModel
  private let ui: URL
  private var page: URL { ui.appendingPathComponent("content.html") }
  init(store: AppStore) {
    self.store = store
    model = ChatModel(store: store)
    ui = Bundle.main.resourceURL!.appendingPathComponent("ui", isDirectory: true)
    let controller = WKUserContentController()
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = controller
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    web = WKWebView(frame: .zero, configuration: configuration)
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 640, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    super.init()
    window.title = "Cue"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.toolbarStyle = .unified
    window.level = .floating
    window.isOpaque = false
    window.backgroundColor = .clear
    window.isReleasedWhenClosed = false
    let host = NSHostingController(rootView: ChatRootView(model: model, web: web))
    // SwiftUI's .toolbar items become the window's native unified toolbar.
    host.sceneBridgingOptions = [.toolbars]
    window.contentViewController = host
    window.setContentSize(NSSize(width: 640, height: 780))
    window.minSize = NSSize(width: 440, height: 520)
    window.setFrameAutosaveName("CueChat")
    if window.frame.origin == .zero { window.center() }
    web.setValue(false, forKey: "drawsBackground")
    controller.add(self, name: "cue")
    controller.addUserScript(
      WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web.navigationDelegate = self
    store.onEvent = { [weak self] value in self?.emit(value) }
    model.render = { [weak self] value in self?.send(value) }
    model.pin = { [weak self] on in self?.window.level = on ? .floating : .normal }
    web.loadFileURL(page, allowingReadAccessTo: ui)
  }
  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
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
      window.cue = Object.fromEntries(['command','audio','copy','ready'].map(method=>[method,(...args)=>call(method,...args)]));
    })();
    """
}
