import SwiftUI
import AppKit

@main struct SageEntry {
    @MainActor static func main() async {
        #if DEBUG
        if CommandLine.arguments.contains("--check-sites-event") { await NativeRegression.sitesConnection(sendEvent: true); return }
        if CommandLine.arguments.contains("--check-sites-connection") { await NativeRegression.sitesConnection(); return }
        #endif
        if CommandLine.arguments.contains("--self-test") {
            #if DEBUG
            await NativeRegression.run()
            return
            #else
            fputs("--self-test requires CONFIGURATION=debug.\n", stderr); exit(2)
            #endif
        }
        SageApp.main()
    }
}

struct SageApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = AppStore(preview: CommandLine.arguments.contains("--preview") || CommandLine.arguments.contains("--self-test") || CommandLine.arguments.contains("--check-capture-app"))
    var body: some Scene {
        Window("Cue 设置", id: "sage") {
            CaptureSettingsView(store: store)
                .onAppear { delegate.store = store; store.chatgpt.installShortcut() }
                .task { await store.restoreConnection() }
        }
        .defaultSize(width: 580, height: 600)
        .defaultLaunchBehavior(CommandLine.arguments.contains("--preview") ? .presented : .suppressed)
        .restorationBehavior(.disabled)
        .commands {
            CommandGroup(replacing: .newItem) {
            }
            CommandGroup(replacing: .appSettings) {
                Button("Cue 设置…") { store.openCaptureSettings() }.keyboardShortcut(",")
            }
            CommandMenu("ChatGPT") {
                Button("请 ChatGPT 回答") { store.requestChatGPT() }.disabled(!store.connected)
                Button("API 备用回答…") { store.openFallback() }
                Button("ChatGPT 订阅…") { store.showChatGPT = true; store.openCaptureSettings() }
            }
        }
        MenuBarExtra { CaptureMenu(store: store) }
            label: { CaptureStatusLabel(store: store, delegate: delegate) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: AppStore?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(CommandLine.arguments.contains("--preview") ? .regular : .accessory)
        #if DEBUG
        if CommandLine.arguments.contains("--check-capture-app") {
            Task { await NativeRegression.captureApplication(self) }
        }
        #endif
        if CommandLine.arguments.contains("--preview") {
            if CommandLine.arguments.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
            if CommandLine.arguments.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
            if let index = CommandLine.arguments.firstIndex(of: "--preview-size"), CommandLine.arguments.count > index + 2,
               let width = Double(CommandLine.arguments[index + 1]), let height = Double(CommandLine.arguments[index + 2]) {
                Task {
                    for _ in 0..<30 {
                        if let window = NSApp.windows.first(where: { $0.canBecomeMain && $0.contentView != nil }) {
                            window.setContentSize(NSSize(width: width, height: height)); break
                        }
                        try? await Task.sleep(for: .milliseconds(50))
                    }
                }
            }
        }
        if let index = CommandLine.arguments.firstIndex(of: "--render-preview"), CommandLine.arguments.count > index + 1 {
            let path = CommandLine.arguments[index + 1]
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                do {
                    guard CommandLine.arguments.contains("--preview"), let view = NSApp.windows.first(where: { $0.canBecomeMain && $0.contentView != nil })?.contentView,
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
        if !flag { store?.openCaptureSettings() }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        Task {
            if store.state.active || store.state.stopping || store.preparing {
                if !store.state.stopping { try? await store.control(["type": "stop_transcription"]) }
                for _ in 0..<240 {
                    if !store.state.active && !store.state.stopping && !store.preparing { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
            await store.disconnect()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
