import Foundation
import CueCore

var checked = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
  guard condition() else {
    fputs("FAIL \(name)\n", stderr)
    exit(1)
  }
  checked += 1
  print("PASS \(name)")
}
for value in [
  "https://cue.siyidu.com", "http://127.0.0.1:8000", "http://localhost:8000",
  "http://[::1]:8000",
] {
  check((try? ServerAddress(value)) != nil, "allowed server \(value)")
}
for value in [
  "http://example.com", "https://user:password@example.com", "https://example.com/?token=abc",
  "https://example.com/path", "file:///tmp/foo", "https://example.com/#secret",
] {
  check((try? ServerAddress(value)) == nil, "rejected unsafe origin")
}
let address = try ServerAddress("https://cue.siyidu.com")
let socket = address.socket()
check(socket.scheme == "wss" && socket.query == nil, "websocket credentials never in URL")
check(socket.path == "/capture/socket", "capture uses one fixed socket endpoint")
var queue = PCMQueue(capacity: 8)
queue.append(Data([1, 2, 3, 4]))
queue.append(Data([5, 6, 7, 8]))
queue.append(Data([9, 10, 11, 12]))
check(queue.bytes == 8 && queue.takeGap(), "bounded queue reports audio gap")
check(
  queue.pop() == Data([5, 6, 7, 8]) && queue.pop() == Data([9, 10, 11, 12]),
  "drops oldest frames and preserves tail order")
queue.append(Data(repeating: 1, count: 12))
queue.append(Data(repeating: 2, count: 4))
check(queue.takeDroppedBytes() == 12, "gap diagnostic counts oversized and evicted PCM bytes")
check(queue.takeDroppedBytes() == 0 && !queue.dropped, "gap diagnostic is consumed once")
var state = CaptureState()
state.merge(["id": "t", "speaker": "candidate", "text": "old", "revision": 1])
state.merge(["id": "t", "speaker": "candidate", "text": "corrected", "revision": 2])
state.merge(["id": "t", "speaker": "candidate", "text": "stale", "revision": 1])
check(
  state.transcripts.count == 1 && state.transcripts[0]["text"] as? String == "corrected",
  "stale snapshot cannot replace newer transcript revision")
check(
  (try? SiteCredentials(#"{"site":"a","device":"b"}"#)) != nil,
  "Sites credentials decode without an API key")
check((try? SiteCredentials("legacy-token")) == nil, "legacy VPS credential is never sent to Sites")
print("\(checked) offline checks passed")
@MainActor final class TestSocket: SocketConnection {
  var maximumMessageSize = 0
  var closeCode = URLSessionWebSocketTask.CloseCode.invalid
  var receivedReady = false
  var sent: [String] = []
  var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
  func resume() {}
  func cancel(with code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closeCode = code
    receiver?.resume(throwing: CueError("closed"))
    receiver = nil
  }
  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    switch message {
    case .data(let d): sent.append("pcm:\(d.first!)")
    case .string(let text):
      let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! JSON
      sent.append(value["type"] as! String)
    @unknown default: break
    }
  }
  func receive() async throws -> URLSessionWebSocketTask.Message {
    if !receivedReady {
      receivedReady = true
      return .string("{\"type\":\"session_ready\",\"protocol\":\"cue-chat-v2\"}")
    }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }
}
@MainActor func transportChecks() async throws {
  let fake = TestSocket()
  var connections = 0
  let link = SocketLink(
    url: URL(string: "wss://example.com/capture/socket")!, token: "test", role: "desktop",
    connectionFactory: { _ in
      connections += 1
      return fake
    })
  link.start()
  for _ in 0..<100 {
    if link.ready { break }
    await Task.yield()
  }
  check(link.ready && fake.sent == ["authenticate"], "connection does not start audio or ask")
  try link.enqueue(["type": "asr_commit", "stream": "interviewer"])
  try link.enqueue(["type": "asr_commit", "stream": "candidate"])
  try link.enqueue(["type": "ask"])
  try link.enqueue(["type": "asr_event"])
  for _ in 0..<100 {
    if fake.sent.count == 5 { break }
    await Task.yield()
  }
  check(
    fake.sent == ["authenticate", "asr_commit", "asr_commit", "ask", "asr_event"],
    "both ASR commits precede ask and later transcription events")
  fake.receiver?.resume(returning: .string("{\"type\":\"replaced\"}"))
  fake.receiver = nil
  for _ in 0..<100 {
    if !link.ready { break }
    await Task.yield()
  }
  check(!link.ready && connections == 1, "replaced client exits without reclaiming capture")
  check(
    (try? link.enqueue(["type": "ask"])) == nil && fake.sent.count == 5,
    "closed connection cannot retransmit a request")
  link.close()
}
try await transportChecks()
print("\(checked) total offline checks passed")
