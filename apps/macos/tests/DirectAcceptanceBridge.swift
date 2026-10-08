import Foundation

/// Runs the same client VAD/WebSocket module as the desktop renderer. Only
/// ephemeral Realtime tokens enter this child; device credentials stay native.
@MainActor final class DirectAcceptanceBridge {
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var reader: Task<Void, Never>?
  private var closing = false
  var onMessage: (JSON) -> Void = { _ in }
  init() throws {
    guard let node = ProcessInfo.processInfo.environment["CUE_NODE_BIN"],
      let script = ProcessInfo.processInfo.environment["CUE_DIRECT_RUNNER"]
    else { throw SageError("Direct acceptance runtime paths are missing") }
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [script]
    process.environment = ["PATH": "/usr/bin:/bin", "NODE_NO_WARNINGS": "1"]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let handle = output.fileHandleForReading
    reader = Task { [weak self] in
      do {
        for try await line in handle.bytes.lines {
          guard let data = line.data(using: .utf8),
            let value = try JSONSerialization.jsonObject(with: data) as? JSON
          else { throw SageError("Direct runtime returned invalid data") }
          self?.onMessage(value)
        }
        if self?.closing == false {
          self?.onMessage(["kind": "error", "detail": "Direct runtime ended"])
        }
      } catch {
        if !Task.isCancelled {
          self?.onMessage(["kind": "error", "detail": "Direct runtime ended"])
        }
      }
    }
  }
  func send(_ value: JSON) throws {
    try input.fileHandleForWriting.write(
      contentsOf: JSONSerialization.data(withJSONObject: value) + Data([10]))
  }
  func close() {
    closing = true
    try? send(["kind": "close"])
    try? input.fileHandleForWriting.close()
    reader?.cancel()
    if process.isRunning { process.terminate() }
  }
}
