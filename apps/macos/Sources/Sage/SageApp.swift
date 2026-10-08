import AppKit

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
    NSApp.mainMenu = applicationMenu
    let shortcut = AnswerHotkey(action: { [weak self] in self?.answer() })
    if !shortcut.setEnabled(true) {
      store.onEvent(["type": "error", "detail": "全局快捷键被占用，仍可使用窗口中的回答按钮。"])
    }
    hotkey = shortcut
    chat?.show()
    if let i = CommandLine.arguments.firstIndex(of: "--render-preview"),
      CommandLine.arguments.count > i + 1, CommandLine.arguments.contains("--preview")
    {
      let path = CommandLine.arguments[i + 1]
      Task {
        for _ in 0..<100 {
          if (try? await chat!.web.evaluateJavaScript(
            "document.querySelector('.connection')?.textContent === '已连接'")) as? Bool == true
          {
            break
          }
          try? await Task.sleep(for: .milliseconds(100))
        }
        do {
          let diagnostic = try await chat!.web.evaluateJavaScript(
            "JSON.stringify({bridge:typeof window.cue,status:document.querySelector('.connection')?.textContent,error:document.querySelector('.notice')?.textContent})"
          )
          print("Preview:", diagnostic ?? "unavailable")
          let image = try await chat!.web.takeSnapshot(configuration: nil)
          guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:])
          else { exit(1) }
          try png.write(to: URL(fileURLWithPath: path))
          exit(0)
        } catch {
          fputs("Preview failed\n", stderr)
          exit(1)
        }
      }
    }
  }
  @objc private func show() { chat?.show() }
  @objc private func answer() { chat?.emit(["type": "answer_requested"]) }
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
