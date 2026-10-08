import AppKit
import SageCore
import ScreenCaptureKit

@main struct SageEntry {
  @MainActor static func main() async {
    if CommandLine.arguments.contains("--check-connection") {
      do {
        try await ConnectionCheck.run(
          importMaterials: CommandLine.arguments.contains("--import-existing-materials"))
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
  private var hotkey: AnswerHotkey?
  func applicationDidFinishLaunching(_ notification: Notification) {
    chat = ChatWindow(store: store)
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status?.button?.title = "Cue"
    let menu = NSMenu()
    for (title, action) in [
      ("打开 Cue", #selector(show)), ("回答", #selector(answer)), ("退出 Cue", #selector(quit)),
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
    let shortcut = AnswerHotkey(action: { [weak self] in self?.answer() })
    if !shortcut.setEnabled(true) {
      store.onEvent(["type": "error", "detail": "全局快捷键被占用，仍可使用窗口中的回答按钮。"])
    }
    hotkey = shortcut
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
        else { throw SageError("preview window not listed") }
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
  @objc private func show() { chat?.show() }
  @objc private func answer() { chat?.model.ask() }
  @objc private func quit() { NSApp.terminate(nil) }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
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
