import AppKit
import Carbon
import CueCore
import ScreenCaptureKit

@main struct CueEntry {
  @MainActor static func main() async {
    if CommandLine.arguments.contains("--check-connection") {
      do {
        try await ConnectionCheck.run()
      } catch {
        fputs("Connection check failed: \(error.localizedDescription)\n", stderr)
        exit(1)
      }
      return
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  private let store = AppStore(preview: CommandLine.arguments.contains("--preview"))
  private var chat: ChatWindow?
  private var status: NSStatusItem?
  private let hotkeys = GlobalHotkeys()
  func applicationDidFinishLaunching(_ notification: Notification) {
    chat = ChatWindow(store: store)
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status?.button?.title = "Cue"
    chat?.model.setMenuBarVisible = { [weak self] visible in
      self?.status?.isVisible = visible
    }
    let menu = NSMenu()
    for (title, action) in [
      ("显示或隐藏 Cue", #selector(toggle)), ("回答", #selector(answer)), ("截图", #selector(shot)),
      ("退出 Cue", #selector(quit)),
    ] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    status?.menu = menu
    // Accessory apps do not receive a default application menu. Without this,
    // Command-Q is silently ignored while the chat window is active.
    let applicationMenu = NSMenu()
    let applicationItem = NSMenuItem()
    let applicationActions = NSMenu()
    let quitItem = NSMenuItem(title: "退出 Cue", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    applicationActions.addItem(quitItem)
    applicationItem.submenu = applicationActions
    applicationMenu.addItem(applicationItem)
    let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
    let editActions = NSMenu(title: "编辑")
    for (title, selector, key) in [
      ("撤销", "undo:", "z"), ("重做", "redo:", "Z"),
      ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
      ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a"),
    ] {
      // Nil target routes standard editing actions to the focused WebView.
      editActions.addItem(NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key))
    }
    editItem.submenu = editActions
    applicationMenu.addItem(editItem)
    NSApp.mainMenu = applicationMenu
    // A preview must not take the installed app's shortcuts.
    let taken = store.preview ? [] : hotkeys.register([
      .init(code: kVK_Return, name: "⌃⌥⌘↩ 回答") { [weak self] in self?.answer() },
      .init(code: kVK_ANSI_S, name: "⌃⌥⌘S 截图") { [weak self] in self?.shot() },
      .init(code: kVK_ANSI_Backslash, name: "⌃⌥⌘\\ 显示或隐藏") { [weak self] in self?.toggle() },
    ])
    if !taken.isEmpty {
      store.onEvent([
        "type": "error", "detail": "快捷键被占用：\(taken.joined(separator: "、"))，仍可使用浮窗按钮。",
      ])
    }
    if store.preview { chat?.model.expanded = true }
    chat?.show()
    if let chat { Task { await chat.model.reconnect() } }
    if let i = CommandLine.arguments.firstIndex(of: "--render-preview"),
      CommandLine.arguments.count > i + 1, CommandLine.arguments.contains("--preview")
    {
      let path = CommandLine.arguments[i + 1]
      Task {
        for _ in 0..<100 {
          if chat?.model.connected == true { break }
          try? await Task.sleep(for: .milliseconds(100))
        }
        // Synthetic captions travel the real page-to-native bridge once the
        // page has loaded. Preview never captures audio; only the displayed
        // state is set.
        for _ in 0..<100 where chat?.web.isLoading != false {
          try? await Task.sleep(for: .milliseconds(100))
        }
        chat?.model.handle(["type": "started"])
        chat?.model.handle(["type": "remote", "connected": true])
        for (item, text) in [
          ("preview-1", "好的，我们先从项目开始。"),
          ("preview-2", "你能讲讲上一个项目里，缓存和数据库的一致性是怎么保证的吗？"),
        ] {
          do {
            _ = try await chat?.web.callAsyncJavaScript(
              "await window.cue.caption({item, text})", arguments: ["item": item, "text": text],
              contentWorld: .page)
          } catch {
            fputs("Preview caption failed: \(error)\n", stderr)
          }
        }
        try? await Task.sleep(for: .milliseconds(1200))
        guard let window = chat?.window,
          let png = await Self.snapshot(window),
          (try? png.write(to: URL(fileURLWithPath: path))) != nil
        else { exit(1) }
        exit(0)
      }
    }
  }
  /// The whole window, toolbar and glass included, when screen access exists.
  private static func snapshot(_ window: NSWindow) async -> Data? {
    for _ in 0..<3 where ScreenAccess.granted {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(
          false, onScreenWindowsOnly: false)
        guard
          let target = content.windows.first(where: {
            $0.windowID == CGWindowID(window.windowNumber)
          })
        else { throw CueError("preview window not listed") }
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(
          contentFilter: filter, configuration: config)
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
      } catch {
        fputs("Window capture failed: \(error.localizedDescription)\n", stderr)
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
    guard let view = window.contentView,
      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
    else { return nil }
    view.cacheDisplay(in: view.bounds, to: rep)
    return rep.representation(using: .png, properties: [:])
  }
  private func show() { chat?.show() }
  @objc private func toggle() { chat?.toggle() }
  /// Answering shows the overlay; capturing leaves it as it is.
  @objc private func answer() {
    chat?.show()
    chat?.model.ask()
  }
  @objc private func shot() { chat?.model.shot() }
  @objc private func quit() { NSApp.terminate(nil) }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    chat?.model.menuBarHidden = false
    show()
    return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    Task {
      await store.disconnect()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
