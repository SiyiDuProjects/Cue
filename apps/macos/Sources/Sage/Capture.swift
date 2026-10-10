import AVFoundation
import AppKit
import SageCore
import ScreenCaptureKit

/// ScreenCaptureKit calls prompt when access is missing, so callers check first.
/// Only explicit capture actions may ask; listing sources must stay silent.
enum ScreenAccess {
  static let settingsURL = URL(
    string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
  static var granted: Bool { CGPreflightScreenCaptureAccess() }
  static func require(asking: Bool) throws {
    guard !granted else { return }
    if asking { _ = CGRequestScreenCaptureAccess() }
    throw SageError(
      "Cue 没有录屏权限。在系统设置的「录屏与系统录音」中开启 Cue；如果已显示开启，移除 Cue 后重新添加一次。")
  }
}

/// Samples stay on a serial audio queue. Only bounded PCM mailboxes cross to the UI thread.
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "com.siyidu.sage.audio", qos: .userInitiated)
  private let lock = NSLock()
  private var boxes = ["interviewer": PCMQueue(), "candidate": PCMQueue()]
  private var converters: [String: AVAudioConverter] = [:]
  private var lastError: String?
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    lock.lock()
    lastError = "音频采集已中断，请停止后重新开始。"
    lock.unlock()
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard sampleBuffer.isValid, outputType == .audio || outputType == .microphone,
      let description = sampleBuffer.formatDescription
    else { return }
    let role = outputType == .audio ? "interviewer" : "candidate"
    let format = AVAudioFormat(cmAudioFormatDescription: description)
    let count = AVAudioFrameCount(sampleBuffer.numSamples)
    guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else {
      return
    }
    input.frameLength = count
    let result = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer, at: 0, frameCount: Int32(count), into: input.mutableAudioBufferList)
    guard result == noErr else {
      fail()
      return
    }
    consume(input, role: role)
  }
  func consume(_ input: AVAudioPCMBuffer, role: String) {
    let format = input.format
    let count = input.frameLength
    if converters[role]?.inputFormat != format {
      guard
        let destination = AVAudioFormat(
          commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true),
        let converter = AVAudioConverter(from: format, to: destination)
      else {
        fail()
        return
      }
      converters[role] = converter
    }
    guard let converter = converters[role],
      let output = AVAudioPCMBuffer(
        pcmFormat: converter.outputFormat,
        frameCapacity: AVAudioFrameCount(Double(count) * 24_000 / format.sampleRate) + 64)
    else {
      fail()
      return
    }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if consumed {
        state.pointee = .noDataNow
        return nil
      }
      consumed = true
      state.pointee = .haveData
      return input
    }
    guard status != .error, error == nil else {
      fail()
      return
    }
    append(output, role: role)
  }
  private func append(_ output: AVAudioPCMBuffer, role: String) {
    guard output.frameLength > 0, let bytes = output.int16ChannelData?[0] else { return }
    let data = Data(bytes: bytes, count: Int(output.frameLength) * 2)
    lock.lock()
    boxes[role]?.append(data)
    lock.unlock()
  }
  private func fail() {
    lock.lock()
    lastError = "音频格式转换失败，请重新开始转录。"
    lock.unlock()
  }
  func takeBoth() -> [(role: String, frames: [Data], droppedBytes: Int)] {
    lock.lock()
    defer { lock.unlock() }
    return ["interviewer", "candidate"].map { role in
      var frames: [Data] = []
      while let frame = boxes[role]?.pop() { frames.append(frame) }
      return (role, frames, boxes[role]?.takeDroppedBytes() ?? 0)
    }
  }
  func error() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let value = lastError
    lastError = nil
    return value
  }
  func finish() async {
    await withCheckedContinuation { continuation in
      queue.async { [self] in
        for (role, converter) in converters {
          guard
            let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 2048)
          else { continue }
          var error: NSError?
          _ = converter.convert(to: output, error: &error) { _, status in
            status.pointee = .endOfStream
            return nil
          }
          if error != nil { fail() }
          append(output, role: role)
        }
        converters = [:]
        continuation.resume()
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
  init(stream: SCStream, sink: AudioSink) {
    self.stream = stream
    self.sink = sink
  }
  func stop() async throws { try await stream.stopCapture() }
}

@MainActor final class CaptureController {
  private var audioSession: (any AudioCaptureSession)?
  private var epoch = UUID()
  private let factory: ((AudioSink, @escaping () -> Bool) async throws -> any AudioCaptureSession)?
  private(set) var sink: AudioSink?
  private var finishTask: Task<Bool, Never>?
  var isPrepared: Bool { audioSession != nil }
  init(factory: ((AudioSink, @escaping () -> Bool) async throws -> any AudioCaptureSession)? = nil) {
    self.factory = factory
  }
  private func filter(displayID: CGDirectDisplayID, excludeSelf: Bool) async throws -> SCContentFilter {
    let content = try await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
      throw SageError("显示器不可用。")
    }
    let excluded =
      excludeSelf
      ? content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
      : []
    return SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
  }
  func screenshot() async throws -> JSON {
    try ScreenAccess.require(asking: true)
    try Task.checkCancellation()
    let displayID = CGMainDisplayID()
    let filter = try await self.filter(displayID: displayID, excludeSelf: true)
    let config = SCStreamConfiguration()
    config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
    config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
    config.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: config)
    let capturedAt = ISO8601DateFormatter().string(from: Date())
    let representation = NSBitmapImageRep(cgImage: image)
    guard let data = representation.representation(using: .png, properties: [:]) else {
      throw SageError("截图编码失败。")
    }
    let result: JSON = [
      "image_data": "data:image/png;base64," + data.base64EncodedString(), "source_id": "display:\(displayID)",
      "captured_at": capturedAt,
    ]
    try Task.checkCancellation()
    return result
  }
  func prepare() async throws {
    guard audioSession == nil else { return }
    let ticket = UUID()
    epoch = ticket
    if let finishTask { _ = await finishTask.value }
    guard epoch == ticket else { throw CancellationError() }
    finishTask = nil
    // Publish the mailbox before startCapture can produce its first samples.
    // The caller already has ready upstreams and drains in the prepared phase.
    let sink = AudioSink()
    self.sink = sink
    let current = { [weak self] in self?.epoch == ticket }
    let session: any AudioCaptureSession
    if let factory {
      session = try await factory(sink, current)
    } else {
      session = try await makeSession(sink: sink, current: current)
    }
    guard current() else {
      try? await session.stop()
      await session.sink.finish()
      throw CancellationError()
    }
    self.sink = session.sink
    audioSession = session
  }
  private func makeSession(sink: AudioSink, current: @escaping () -> Bool) async throws -> any AudioCaptureSession {
    let authorized = await AVCaptureDevice.requestAccess(for: .audio)
    guard current() else { throw CancellationError() }
    guard authorized else { throw SageError("请在系统设置中允许 Cue 使用麦克风。") }
    // System audio comes through ScreenCaptureKit and needs the same access.
    try ScreenAccess.require(asking: true)
    let filter = try await filter(displayID: CGMainDisplayID(), excludeSelf: false)
    guard current() else { throw CancellationError() }
    let config = SCStreamConfiguration()
    config.width = 64
    config.height = 64
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.queueDepth = 3
    config.capturesAudio = true
    config.captureMicrophone = true
    config.sampleRate = 24_000
    config.channelCount = 1
    config.excludesCurrentProcessAudio = true
    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    // Keep ScreenCaptureKit's tiny video track alive; the sink discards screen frames.
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
    try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: sink.queue)
    do { try await stream.startCapture() } catch {
      try? await stream.stopCapture()
      throw SageError("无法开始采集，请检查屏幕与系统音频录制权限。\n\(error.localizedDescription)")
    }
    return NativeAudioSession(stream: stream, sink: sink)
  }
  /// Both streams stop together; each socket independently acknowledges after its PCM drains.
  /// A recording the server ended was never drained by the client, so its
  /// mailbox can still hold a tail. A new start drops it instead of letting the
  /// prepared-phase drain forward old audio to new upstreams.
  func discardFinishedSink() {
    guard audioSession == nil else { return }
    sink = nil
  }
  func finish() async -> Bool {
    epoch = UUID()  // Invalidate a pending permission prompt or stream start as well.
    if let finishTask { return await finishTask.value }
    let session = audioSession
    let sink = self.sink
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
