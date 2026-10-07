import AppKit
import SageCore

/// One manual capture through the user's installed ChatGPT MCP runtime.
/// No model request and no shared Codex chat/session is involved.
enum NativeAppShot {
  @MainActor static func capture(app: NSRunningApplication, title: String? = nil) async throws
    -> JSON
  {
    guard let appURL = app.bundleURL, let bundleID = app.bundleIdentifier,
      let resources = Bundle.main.resourceURL
    else { throw SageError("无法确认原生采集应用。") }
    let binary = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/sage-node")
    let script = resources.appendingPathComponent("bridge/native-appshot.cjs")
    guard FileManager.default.isExecutableFile(atPath: binary.path),
      FileManager.default.fileExists(atPath: script.path)
    else { throw SageError("缺少 ChatGPT 原生采集桥接程序，请更新 Cue。") }
    var request: JSON = ["app": appURL.path, "bundle_id": bundleID]
    if let title { request["window_title"] = title }
    let input = try JSONSerialization.data(withJSONObject: request) + Data([10])
    let job = NativeAppShotProcess(binary: binary, script: script, input: input)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          do { continuation.resume(returning: try job.run()) } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    } onCancel: {
      job.cancel()
    }
  }
}

private final class NativeAppShotProcess: @unchecked Sendable {
  private let binary: URL, script: URL, input: Data
  private let lock = NSLock()
  private var process: Process?
  private var cancelled = false
  init(binary: URL, script: URL, input: Data) {
    self.binary = binary
    self.script = script
    self.input = input
  }
  func cancel() {
    lock.lock()
    cancelled = true
    let child = process
    lock.unlock()
    guard let child else { return }
    if child.isRunning { child.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
      if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }
  }
  func run() throws -> JSON {
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    child.executableURL = binary
    child.arguments = [script.path]
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = FileHandle.nullDevice
    lock.lock()
    if cancelled {
      lock.unlock()
      throw CancellationError()
    }
    do {
      try child.run()
      process = child
      lock.unlock()
    } catch {
      lock.unlock()
      throw SageError("无法启动 ChatGPT 原生采集桥接程序。")
    }
    let deadline = DispatchWorkItem { [weak self] in self?.cancel() }
    DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
    defer {
      deadline.cancel()
      try? stdin.fileHandleForWriting.close()
      try? stdout.fileHandleForReading.close()
      lock.lock()
      process = nil
      lock.unlock()
    }
    do {
      try stdin.fileHandleForWriting.write(contentsOf: input)
      try stdin.fileHandleForWriting.close()
    } catch {
      cancel()
      child.waitUntilExit()
      throw SageError("原生采集请求发送失败。")
    }
    var output = Data()
    while true {
      let chunk = stdout.fileHandleForReading.availableData
      if chunk.isEmpty { break }
      output.append(chunk)
      if output.count > 9 * 1024 * 1024 {
        cancel()
        break
      }
    }
    child.waitUntilExit()
    lock.lock()
    let wasCancelled = cancelled
    lock.unlock()
    if wasCancelled { throw SageError("ChatGPT 原生采集已取消或超时。") }
    guard output.count <= 9 * 1024 * 1024, child.terminationStatus == 0,
      let result = try? JSONSerialization.jsonObject(with: output) as? JSON
    else {
      throw SageError("ChatGPT 原生采集返回了无效结果。")
    }
    guard result["ok"] as? Bool == true else {
      throw SageError(result["error"] as? String ?? "ChatGPT 原生采集失败。")
    }
    return result
  }
}
