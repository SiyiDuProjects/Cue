import AppKit
import SageCore
import WebKit

@MainActor final class ChatWindow: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let window: NSWindow
  let web: WKWebView
  let store: AppStore
  private let ui: URL
  init(store: AppStore) {
    self.store = store
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
    window.level = .floating
    window.isOpaque = false
    window.backgroundColor = .clear
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 440, height: 500)
    window.setFrameAutosaveName("CueChat")
    window.center()
    let glass = NSVisualEffectView()
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    window.contentView = glass
    web.setValue(false, forKey: "drawsBackground")
    web.translatesAutoresizingMaskIntoConstraints = false
    glass.addSubview(web)
    NSLayoutConstraint.activate([
      web.leadingAnchor.constraint(equalTo: glass.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
      web.topAnchor.constraint(equalTo: glass.topAnchor, constant: 28),
      web.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
    ])
    controller.add(self, name: "cue")
    controller.addUserScript(
      WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web.navigationDelegate = self
    store.onEvent = { [weak self] value in self?.emit(value) }
    web.loadFileURL(ui.appendingPathComponent("index.html"), allowingReadAccessTo: ui)
  }
  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  func emit(_ value: JSON) {
    web.callAsyncJavaScript(
      "window.cueReceive(value)", arguments: ["value": value], in: nil, in: .page
    ) { _ in }
  }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame,
      message.frameInfo.request.url?.standardizedFileURL
        == ui.appendingPathComponent("index.html").standardizedFileURL,
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
        web.callAsyncJavaScript(
          "window.cueReply(id,{},null)", arguments: ["id": id], in: nil, in: .page
        ) { _ in }
      } catch {
        web.callAsyncJavaScript(
          "window.cueReply(id,null,error)",
          arguments: ["id": id, "error": error.localizedDescription], in: nil, in: .page
        ) { _ in }
      }
      return
    }
    Task {
      do {
        let result = try await invoke(method, args)
        web.callAsyncJavaScript(
          "window.cueReply(id,result,null)", arguments: ["id": id, "result": result], in: nil,
          in: .page
        ) { _ in }
      } catch {
        web.callAsyncJavaScript(
          "window.cueReply(id,null,error)",
          arguments: ["id": id, "error": error.localizedDescription], in: nil, in: .page
        ) { _ in }
      }
    }
  }
  private func invoke(_ method: String, _ args: [Any]) async throws -> Any {
    switch method {
    case "connect": try await store.connect()
    case "command":
      guard let value = args.first as? JSON else { throw SageError("操作无效。") }
      try await store.command(value)
    case "audio": try await store.audio(args.first as? Bool == true)
    case "request":
      guard let path = args.first as? String else { throw SageError("操作无效。") }
      return try await store.request(
        path, method: args.count > 1 ? args[1] as? String ?? "GET" : "GET",
        body: args.count > 2 ? args[2] as? JSON : nil)
    case "screenshot": return try await store.screenshot(args.first as? String ?? "")
    case "sources": return try await store.sources()
    case "selectSource": store.selectSource(args.first as? String ?? "frontmost")
    case "uploadMaterials": return try await store.uploadMaterials()
    case "importConnection": try await store.importConnection()
    case "pin": window.level = args.first as? Bool == true ? .floating : .normal
    case "openSettings": NSWorkspace.shared.open(URL(string: AppStore.serviceURL + "/settings")!)
    case "openPrivacy": NSWorkspace.shared.open(ScreenAccess.settingsURL)
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
    if url.standardizedFileURL == ui.appendingPathComponent("index.html").standardizedFileURL {
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
      window.cue = Object.fromEntries(['connect','command','request','audio','screenshot','sources','selectSource','uploadMaterials','importConnection','pin','copy','openSettings','openPrivacy'].map(method=>[method,(...args)=>call(method,...args)]));
    })();
    """
}
