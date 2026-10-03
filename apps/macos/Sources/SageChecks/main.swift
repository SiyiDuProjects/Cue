import Foundation
import SageCore
@_spi(Testing) import SageAppShot
import ApplicationServices

var checked = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { fputs("FAIL \(name)\n", stderr); exit(1) }
    checked += 1; print("PASS \(name)")
}
for value in ["https://interview.siyidu.com", "http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000"] {
    check((try? ServerAddress(value)) != nil, "allowed server \(value)")
}
for value in ["http://example.com", "https://user:password@example.com", "https://example.com/?token=abc", "https://example.com/path", "file:///tmp/foo", "https://example.com/#secret"] {
    check((try? ServerAddress(value)) == nil, "rejected unsafe origin")
}
let address = try ServerAddress("https://interview.siyidu.com")
let socket = try address.socket(interview: "current_123", role: "client")
check(socket.scheme == "wss" && socket.query == nil, "websocket credentials never in URL")
check((try? address.socket(interview: "../bad", role: "client")) == nil, "interview path traversal rejected")
var queue = PCMQueue(capacity: 8)
queue.append(Data([1, 2, 3, 4])); queue.append(Data([5, 6, 7, 8])); queue.append(Data([9, 10, 11, 12]))
check(queue.bytes == 8 && queue.takeGap(), "bounded queue reports audio gap")
check(queue.pop() == Data([5, 6, 7, 8]) && queue.pop() == Data([9, 10, 11, 12]), "drops oldest frames and preserves tail order")
var state = ChatState()
state.apply(["type": "answer_delta", "response_id": "chat:x", "delta": "hello"])
state.apply(["type": "answer_completed", "response_id": "chat:x", "text": "hello world"])
state.apply(["type": "answer_delta", "response_id": "chat:x", "delta": "late"])
check(state.answers["chat:x"]?.text == "hello world", "late delta cannot rewrite completed answer")
state.apply(["type": "answer_snapshot", "response_id": "chat:x", "text": "restored", "status": "completed"])
check(state.answers["chat:x"]?.text == "restored", "snapshot replaces rather than duplicates answer")
state.apply(["type": "transcript_final", "turn_id": "t", "speaker": "candidate", "text": "old"])
state.apply(["type": "transcript_final", "turn_id": "t", "speaker": "candidate", "text": "corrected"])
check(state.transcripts.count == 1 && state.transcripts[0]["text"] as? String == "corrected", "transcript correction replaces same turn")
state.apply(["type": "interview_state", "active": true])
state.apply(["type": "conversation_reset", "conversation_id": "new"])
check(state.active && state.transcripts.count == 1 && state.answers.isEmpty, "chat switch preserves shared transcription")
let legacy = ChatMessage(["message_id": "legacy", "text": "old"])
check(legacy.provider == "codex", "legacy messages preserve Codex origin")
state.apply(["type": "operation_status", "operation_id": "a", "kind": "chat_send", "status": "running"])
check(state.busyID == "a", "active operation maps to stop target")
state.apply(["type": "operation_status", "operation_id": "a", "status": "cancelled"])
check(state.busyID == nil, "terminal operation releases generation lock")
print("\(checked) offline checks passed")
check(AXAttributeReadCompletenessPolicy.attributeErrorInvalidatesNode(.failure, attribute: kAXValueAttribute) == false, "Peekaboo sparse optional value preserves node")
check(AXAttributeReadCompletenessPolicy.attributeErrorInvalidatesNode(.failure, attribute: kAXRoleAttribute), "Peekaboo identity read failure is incomplete")
check(AXAttributeReadCompletenessPolicy.isIncomplete(error: .cannotComplete), "Peekaboo AX timeout is not silently empty")
let bounds = CGRect(x: 100, y: 100, width: 400, height: 300)
check(WindowMatch.unique(bounds: bounds, title: "A", candidates: [(bounds, "A"), (bounds, "B")]) == 0, "window text matches captured window")
check(WindowMatch.unique(bounds: bounds, title: "A", candidates: [(bounds, "A"), (bounds, "A")]) == nil, "ambiguous window cannot leak sibling text")
print("\(checked) total offline checks passed")

check(WindowMatch.unique(bounds: bounds, title: "", candidates: [(bounds, "Other window")]) == nil, "missing screenshot title cannot match a different titled window")

let targetWindow = WindowIdentity(id: 42, pid: 100, bounds: bounds, title: "A")
check(WindowMatch.isCurrent(targetWindow, windows: [targetWindow]), "exact captured window remains eligible")
check(!WindowMatch.isCurrent(targetWindow, windows: [WindowIdentity(id: 43, pid: 100, bounds: bounds, title: "A")]), "replacement window with identical title and geometry is rejected")
check(!WindowMatch.isCurrent(targetWindow, windows: [targetWindow, WindowIdentity(id: 43, pid: 100, bounds: bounds, title: "A")]), "ambiguous sibling window suppresses AX text")
check(!WindowMatch.isCurrent(targetWindow, windows: [WindowIdentity(id: 42, pid: 101, bounds: bounds, title: "A")]), "another process cannot reuse captured window identity")
print("\(checked) total offline checks passed")
