import AppKit
import AVFoundation
import ScreenCaptureKit
import SageCore
import SageAppShot

struct WindowTextResult: Sendable {
    var text: String
    var status: String
    var detail: String
    init(text: String = "", status: String, detail: String = "") {
        self.text = text; self.status = status; self.detail = detail
    }
}

struct CaptureSource: Identifiable, Hashable {
    let id: String
    let name: String
}

/// Samples stay on a serial audio queue. Only bounded PCM mailboxes cross to the UI thread.
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.siyidu.sage.audio", qos: .userInitiated)
    private let lock = NSLock()
    private var boxes = ["interviewer": PCMQueue(), "candidate": PCMQueue()]
    private var converters: [String: AVAudioConverter] = [:]
    private var lastError: String?
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock(); lastError = "音频采集已中断，请停止后重新开始。"; lock.unlock()
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard sampleBuffer.isValid, outputType == .audio || outputType == .microphone,
              let description = sampleBuffer.formatDescription else { return }
        let role = outputType == .audio ? "interviewer" : "candidate"
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let count = AVAudioFrameCount(sampleBuffer.numSamples)
        guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return }
        input.frameLength = count
        let result = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: input.mutableAudioBufferList)
        guard result == noErr else { fail(); return }
        consume(input, role: role)
    }
    func consume(_ input: AVAudioPCMBuffer, role: String) {
        let format = input.format, count = input.frameLength
        if converters[role]?.inputFormat != format {
            guard let destination = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true),
                  let converter = AVAudioConverter(from: format, to: destination) else { fail(); return }
            converters[role] = converter
        }
        guard let converter = converters[role],
              let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: AVAudioFrameCount(Double(count) * 24_000 / format.sampleRate) + 64) else { fail(); return }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if consumed { state.pointee = .noDataNow; return nil }
            consumed = true; state.pointee = .haveData; return input
        }
        guard status != .error, error == nil else { fail(); return }
        append(output, role: role)
    }
    private func append(_ output: AVAudioPCMBuffer, role: String) {
        guard output.frameLength > 0, let bytes = output.int16ChannelData?[0] else { return }
        let data = Data(bytes: bytes, count: Int(output.frameLength) * 2)
        lock.lock(); boxes[role]?.append(data); lock.unlock()
    }
    private func fail() { lock.lock(); lastError = "音频格式转换失败，请重新开始转录。"; lock.unlock() }
    func take(_ role: String) -> (frames: [Data], gap: Bool) {
        lock.lock(); defer { lock.unlock() }
        var result: [Data] = []
        while let frame = boxes[role]?.pop() { result.append(frame) }
        return (result, boxes[role]?.takeGap() ?? false)
    }
    func error() -> String? { lock.lock(); defer { lock.unlock() }; let value = lastError; lastError = nil; return value }
    func finish() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                for (role, converter) in converters {
                    guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 2048) else { continue }
                    var error: NSError?
                    _ = converter.convert(to: output, error: &error) { _, status in status.pointee = .endOfStream; return nil }
                    if error != nil { fail() }
                    append(output, role: role)
                }
                converters = [:]; continuation.resume()
            }
        }
    }
}

@MainActor protocol AudioCaptureSession: AnyObject {
    var sink: AudioSink { get }
    func stop() async throws
}

@MainActor private final class NativeAudioSession: AudioCaptureSession {
    let stream: SCStream
    let sink: AudioSink
    init(stream: SCStream, sink: AudioSink) { self.stream = stream; self.sink = sink }
    func stop() async throws { try await stream.stopCapture() }
}

@MainActor final class CaptureController {
    private var previousApp: Int32?
    private var activationObserver: NSObjectProtocol?
    private var audioSession: (any AudioCaptureSession)?
    private var epoch = UUID()
    private let factory: ((@escaping () -> Bool) async throws -> any AudioCaptureSession)?
    private(set) var sink: AudioSink?
    private var finishTask: Task<Bool, Never>?
    var isPrepared: Bool { audioSession != nil }
    init(factory: ((@escaping () -> Bool) async throws -> any AudioCaptureSession)? = nil) {
        self.factory = factory
        previousApp = NSWorkspace.shared.frontmostApplication?.processIdentifier
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
            Task { @MainActor in self?.previousApp = app.processIdentifier }
        }
    }
    func sources() async throws -> [CaptureSource] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let displays = content.displays.map { CaptureSource(id: "display:\($0.displayID)", name: $0.displayID == CGMainDisplayID() ? "主显示器" : "显示器 \($0.displayID)") }
        let windows = content.windows.filter { $0.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier && $0.windowLayer == 0 && !($0.title ?? "").isEmpty }
        return displays + windows.map { CaptureSource(id: "window:\($0.windowID)", name: "\($0.owningApplication?.applicationName ?? "应用") · \($0.title ?? "窗口")") }
    }
    private func filter(source: String, excludeSelf: Bool) async throws -> SCContentFilter {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        if source.hasPrefix("window:"), let id = UInt32(source.dropFirst(7)) {
            guard let window = content.windows.first(where: { $0.windowID == id }) else { throw SageError("所选窗口已关闭，请重新选择截图来源。") }
            return SCContentFilter(desktopIndependentWindow: window)
        }
        let id = source == "primary" ? CGMainDisplayID() : UInt32(source.replacingOccurrences(of: "display:", with: ""))
        guard let display = content.displays.first(where: { $0.displayID == id }) else { throw SageError("所选显示器不可用，请重新选择来源。") }
        let excluded = excludeSelf ? content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier } : []
        return SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    }
    #if DEBUG
    var testScreenshot: ((String) async throws -> JSON)?
    #endif
    func screenshot(source: String) async throws -> JSON {
        #if DEBUG
        if let testScreenshot { return try await testScreenshot(source) }
        #endif
        let requestedApp = previousApp
        var nativeFailure: Error?
        if source == "frontmost" {
            guard let pid = requestedApp, pid != ProcessInfo.processInfo.processIdentifier,
                  let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
                throw SageError("请先切换到目标应用，再回到 Cue 获取 App Shot，或在更多中选择窗口。")
            }
            do {
                // Cue remembers the last app; ChatGPT resolves its focused window and
                // returns the image and text together. No second AX/title matching here.
                let native = try await NativeAppShot.capture(app: app)
                try Task.checkCancellation()
                guard !app.isTerminated, let image = native["image_data"] as? String,
                      let title = native["window_title"] as? String, let text = native["text"] as? String else {
                    throw SageError("原生采集期间目标应用已退出或返回内容无效。")
                }
                return ["image_data": image, "source_id": "app:\(app.bundleIdentifier ?? String(pid))",
                        "captured_at": native["captured_at"] as? String ?? ISO8601DateFormatter().string(from: Date()),
                        "appshot": ["app_name": app.localizedName ?? "应用", "window_title": String(title.unicodeScalars.prefix(2048)),
                                    "text": text, "status": native["status"] as? String ?? "available",
                                    "detail": native["detail"] as? String ?? "ChatGPT 原生采集"]]
            } catch {
                if Task.isCancelled { throw CancellationError() }
                nativeFailure = error
            }
        }
        var selected = source
        if source == "frontmost" {
            guard let pid = requestedApp, pid != ProcessInfo.processInfo.processIdentifier,
                  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [JSON],
                  let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
                  let id = window[kCGWindowNumber as String] as? UInt32 else { throw SageError("请先切换到目标应用，再回到 Cue 获取 App Shot，或在更多中选择窗口。") }
            selected = "window:\(id)"
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let window = selected.hasPrefix("window:") ? content.windows.first { $0.windowID == UInt32(selected.dropFirst(7)) } : nil
        if selected.hasPrefix("window:") && window == nil { throw SageError("所选窗口已经关闭，请重新选择。") }
        let filter: SCContentFilter
        if let window { filter = SCContentFilter(desktopIndependentWindow: window) }
        else { filter = try await self.filter(source: selected, excludeSelf: true) }
        let config = SCStreamConfiguration()
        config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        let representation = NSBitmapImageRep(cgImage: image)
        guard let data = representation.representation(using: .png, properties: [:]) else { throw SageError("截图编码失败。") }
        var result: JSON = ["image_data": "data:image/png;base64," + data.base64EncodedString(), "source_id": selected, "captured_at": capturedAt]
        if let window, let app = window.owningApplication {
            let target = WindowIdentity(id: window.windowID, pid: app.processID, bounds: window.frame, title: window.title ?? "")
            func identities(_ windows: [SCWindow]) -> [WindowIdentity] {
                windows.compactMap { item in item.owningApplication.map { WindowIdentity(id: item.windowID, pid: $0.processID, bounds: item.frame, title: item.title ?? "") } }
            }
            var text = WindowTextResult(status: "unavailable", detail: "窗口身份无法唯一确认，已保留原图。")
            do {
                if let nativeFailure { throw nativeFailure }
                guard WindowMatch.isCurrent(target, windows: identities(content.windows)),
                      content.windows.filter({ $0.owningApplication?.processID == app.processID && $0.title == window.title }).count == 1,
                      let runningApp = NSRunningApplication(processIdentifier: app.processID) else {
                    throw SageError("窗口身份无法唯一确认，已保留原图。")
                }
                // ChatGPT's API reads the app's current window, not an arbitrary window ID.
                // Reject a background selection before asking it to capture another window.
                guard nativeFrontWindow(pid: app.processID) == window.windowID else {
                    throw SageError("请先切到所选应用窗口，再使用 ChatGPT 原生采集；本次已保留所选窗口原图。")
                }
                let native = try await NativeAppShot.capture(app: runningApp, title: window.title ?? "")
                try Task.checkCancellation()
                let latest = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                guard WindowMatch.isCurrent(target, windows: identities(latest.windows)),
                      latest.windows.filter({ $0.owningApplication?.processID == app.processID && $0.title == window.title }).count == 1,
                      nativeFrontWindow(pid: app.processID) == window.windowID else {
                    throw SageError("读取期间窗口已改变，已丢弃原生采集结果并保留原图。")
                }
                guard let imageData = native["image_data"] as? String,
                      let encoded = imageData.split(separator: ",", maxSplits: 1).last,
                      let bytes = Data(base64Encoded: String(encoded)), let bitmap = NSBitmapImageRep(data: bytes),
                      abs(bitmap.pixelsWide - config.width) <= 2, abs(bitmap.pixelsHigh - config.height) <= 2,
                      let nativeText = native["text"] as? String, !nativeText.isEmpty else {
                    throw SageError("原生采集的窗口尺寸或文字不匹配，已保留所选窗口原图。")
                }
                // Keep the native image bytes with the text returned by that same capture.
                result["image_data"] = imageData
                result["captured_at"] = native["captured_at"] as? String ?? capturedAt
                text = WindowTextResult(text: nativeText, status: native["status"] as? String ?? "available",
                                        detail: native["detail"] as? String ?? "ChatGPT 原生采集")
            } catch {
                if Task.isCancelled { throw CancellationError() }
                text = WindowTextResult(status: "unavailable", detail: error.localizedDescription + " 原图已保留。")
            }
            result["appshot"] = ["app_name": String(app.applicationName.unicodeScalars.prefix(512)), "window_title": String((window.title ?? "").unicodeScalars.prefix(2048)), "text": text.text, "status": text.status, "detail": text.detail]
        }
        return result
    }
    private func nativeFrontWindow(pid: Int32) -> UInt32? {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [JSON] ?? []
        return windows.first { item in
            (item[kCGWindowOwnerPID as String] as? Int32) == pid && (item[kCGWindowLayer as String] as? Int) == 0 &&
                !((item[kCGWindowName as String] as? String) ?? "").isEmpty
        }?[kCGWindowNumber as String] as? UInt32
    }
    func prepare() async throws {
        guard audioSession == nil else { return }
        let ticket = UUID(); epoch = ticket
        if let finishTask { _ = await finishTask.value }
        guard epoch == ticket else { throw CancellationError() }
        finishTask = nil
        let current = { [weak self] in self?.epoch == ticket }
        let session: any AudioCaptureSession
        if let factory { session = try await factory(current) }
        else { session = try await makeSession(current: current) }
        guard current() else {
            try? await session.stop(); await session.sink.finish()
            throw CancellationError()
        }
        sink = session.sink; audioSession = session
    }
    private func makeSession(current: @escaping () -> Bool) async throws -> any AudioCaptureSession {
        let authorized = await AVCaptureDevice.requestAccess(for: .audio)
        guard current() else { throw CancellationError() }
        guard authorized else { throw SageError("请在系统设置中允许 Cue 使用麦克风。") }
        let filter = try await filter(source: "primary", excludeSelf: false)
        guard current() else { throw CancellationError() }
        let config = SCStreamConfiguration()
        config.width = 64; config.height = 64
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        config.capturesAudio = true; config.captureMicrophone = true
        config.sampleRate = 24_000; config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        let sink = AudioSink()
        let stream = SCStream(filter: filter, configuration: config, delegate: sink)
        // Keep ScreenCaptureKit's tiny video track alive; the sink discards screen frames.
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
        try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
        try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: sink.queue)
        do { try await stream.startCapture() }
        catch { try? await stream.stopCapture(); throw SageError("无法开始采集，请检查屏幕与系统音频录制权限。\n\(error.localizedDescription)") }
        return NativeAudioSession(stream: stream, sink: sink)
    }
    /// Both streams stop together; each socket independently acknowledges after its PCM drains.
    func finish() async -> Bool {
        epoch = UUID() // Invalidate a pending permission prompt or stream start as well.
        if let finishTask { return await finishTask.value }
        let session = audioSession, sink = self.sink
        audioSession = nil
        let task = Task { () -> Bool in
            var complete = true
            if let session { do { try await session.stop() } catch { complete = false } }
            await sink?.finish()
            return complete && sink?.error() == nil
        }
        finishTask = task
        return await task.value
    }
}
