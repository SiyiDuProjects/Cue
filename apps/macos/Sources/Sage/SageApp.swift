import SwiftUI
import AppKit

@main struct SageEntry {
    @MainActor static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            #if DEBUG
            await NativeRegression.run()
            #else
            fputs("--self-test requires CONFIGURATION=debug.\n", stderr); exit(2)
            #endif
            return
        }
        SageApp.main()
    }
}

struct SageApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = AppStore(preview: CommandLine.arguments.contains("--preview") || CommandLine.arguments.contains("--self-test"))
    var body: some Scene {
        Window("Sage", id: "sage") {
            MainView(store: store)
                .frame(minWidth: 640, minHeight: 480)
                .onAppear { delegate.store = store }
        }
        .defaultSize(width: 940, height: 740)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新对话") { store.switchTo(nil) }.keyboardShortcut("n").disabled(!store.connected)
            }
            CommandGroup(replacing: .appSettings) {
                Button("连接设置…") { store.showSettings = true }.keyboardShortcut(",")
            }
        }
        MenuBarExtra("Sage", systemImage: store.state.active ? "waveform.circle.fill" : "bubble.left.and.bubble.right") {
            Button("打开 Sage") { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first { $0.title == "Sage" }?.makeKeyAndOrderFront(nil) }
            Text(store.state.active ? "正在转录" : store.connection)
            Button(store.state.active ? "停止转录" : "开始转录") { store.toggleTranscription() }.disabled(!store.connected || store.preparing)
            Divider()
            Button("退出 Sage") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: AppStore?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true)
        if let index = CommandLine.arguments.firstIndex(of: "--render-preview"), CommandLine.arguments.count > index + 1 {
            let path = CommandLine.arguments[index + 1]
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                do {
                    guard CommandLine.arguments.contains("--preview"), let view = NSApp.windows.first(where: { $0.title == "Sage" })?.contentView,
                          let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw NSError(domain: "SagePreview", code: 1) }
                    view.cacheDisplay(in: view.bounds, to: image)
                    guard let png = image.representation(using: .png, properties: [:]) else { throw NSError(domain: "SagePreview", code: 2) }
                    try png.write(to: URL(fileURLWithPath: path)); print("Rendered native window: \(path)"); exit(0)
                } catch { fputs("Preview render failed: \(error)\n", stderr); exit(1) }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first { $0.title == "Sage" }?.makeKeyAndOrderFront(nil) }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        Task {
            if store.state.active {
                try? await store.control(["type": "stop_transcription"])
                for _ in 0..<240 {
                    if !store.state.active && !store.state.stopping { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
            await store.disconnect()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
