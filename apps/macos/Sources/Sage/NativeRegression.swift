#if DEBUG
import AppKit
@preconcurrency import AVFoundation
import SageCore

/// Runs only with --self-test, using controlled continuations and intercepted HTTP.
/// It never requests media access, reads credentials, writes user settings, or contacts a model.
private final class FixtureHTTP: URLProtocol, @unchecked Sendable {
    @MainActor static var handler: ((FixtureHTTP) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Task { @MainActor in Self.handler?(self) } }
    override func stopLoading() {}
    func respond(_ json: JSON) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json))
        client?.urlProtocolDidFinishLoading(self)
    }
}
@MainActor private final class FixtureSocket: SocketConnection {
    var maximumMessageSize = 0
    var closeCode = URLSessionWebSocketTask.CloseCode.invalid
    var sent: [URLSessionWebSocketTask.Message] = []
    var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    var pending: [URLSessionWebSocketTask.Message] = []
    var heldSend: CheckedContinuation<Void, Error>?
    var holdData = false
    var holdStop = false
    var delaySendCancellation = false
    func resume() {}
    func cancel(with code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        closeCode = code; receiver?.resume(throwing: CancellationError()); receiver = nil
        if !delaySendCancellation { heldSend?.resume(throwing: CancellationError()); heldSend = nil }
    }
    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if case .data = message, holdData { holdData = false; try await withCheckedThrowingContinuation { heldSend = $0 } }
        if case .string(let text) = message, holdStop, text.contains("capture_stopped") {
            holdStop = false; try await withCheckedThrowingContinuation { heldSend = $0 }
        }
        sent.append(message)
    }
    func receive() async throws -> URLSessionWebSocketTask.Message {
        if !pending.isEmpty { return pending.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func emit(_ event: JSON) {
        let message = URLSessionWebSocketTask.Message.string(String(data: try! JSONSerialization.data(withJSONObject: event), encoding: .utf8)!)
        if let receiver { self.receiver = nil; receiver.resume(returning: message) }
        else { pending.append(message) }
    }
}
@MainActor private final class FakeAudio: AudioCaptureSession {
    let sink = AudioSink()
    var stops = 0
    func stop() async throws { stops += 1 }
}
@MainActor enum NativeRegression {
    static var count = 0
    static func check(_ condition: @autoclosure () -> Bool, _ name: String) throws {
        guard condition() else { throw SageError("FAIL \(name)") }
        count += 1; print("PASS \(name)")
    }
    static func eventually(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !condition() {
            guard Date() < deadline else { throw SageError("Timed out waiting for test continuation") }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }
    static func session(_ id: String) throws -> Session {
        try Session(["interview_id": "current", "conversation_id": id, "session_token": "fixture-ui", "capture_token": "fixture-capture"])
    }
    static func run() async {
        do {
            try await captureRace()
            try await prepareStopBoundary()
            try await stopErrorOwnership()
            try await chatRace()
            try await screenshotSnapshotBoundary()
            try await screenshotRace()
            try await screenshotUploadRace()
            try await refreshRace()
            try await audioConversion()
            try await socketContract()
            print("\(count) native runtime checks passed"); exit(0)
        } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
    }
    static func captureRace() async throws {
        var waiting: CheckedContinuation<any AudioCaptureSession, Error>?
        var delay = true
        let fake = FakeAudio()
        let capture = CaptureController(factory: { _ in
            if delay { return try await withCheckedThrowingContinuation { waiting = $0 } }
            return fake
        })
        let preparation = Task { try await capture.prepare() }
        try await eventually { waiting != nil }
        _ = await capture.finish()
        waiting?.resume(returning: fake)
        do { try await preparation.value; throw SageError("Late prepare unexpectedly succeeded") }
        catch is CancellationError {}
        try check(!capture.isPrepared && fake.stops == 1, "disconnect during suspended prepare stops late resource")
        delay = false
        try await capture.prepare()
        try check(capture.isPrepared, "new prepare succeeds after cancelled generation")
        async let first = capture.finish()
        async let second = capture.finish()
        let results = await (first, second)
        try check(results.0 && results.1 && fake.stops == 2, "two channels share one stop and flush")
        let old = FakeAudio(), new = FakeAudio()
        var late: CheckedContinuation<any AudioCaptureSession, Error>?
        var firstPreparation = true
        let replacement = CaptureController(factory: { _ in
            if firstPreparation { firstPreparation = false; return try await withCheckedThrowingContinuation { late = $0 } }
            return new
        })
        let pending = Task { try await replacement.prepare() }
        try await eventually { late != nil }
        _ = await replacement.finish(); try await replacement.prepare()
        late?.resume(returning: old)
        do { try await pending.value; throw SageError("Old capture replaced new one") } catch is CancellationError {}
        try check(replacement.isPrepared && old.stops == 1 && new.stops == 0, "late previous capture cannot close replacement capture")
        _ = await replacement.finish()
    }
    static func prepareStopBoundary() async throws {
        let capture = CaptureController(factory: { _ in FakeAudio() })
        let store = AppStore(preview: true, capture: capture)
        try store.testSession("https://fixture.invalid", session("a"))
        let system = FixtureSocket(), microphone = FixtureSocket()
        let first = SocketLink(url: URL(string: "wss://fixture.invalid/interviewer")!, token: "fixture", role: "interviewer", connectionFactory: { _ in system })
        let second = SocketLink(url: URL(string: "wss://fixture.invalid/candidate")!, token: "fixture", role: "candidate", connectionFactory: { _ in microphone })
        first.start(); second.start()
        system.emit(["type": "session_ready", "realtime_protocol": protocolVersion])
        microphone.emit(["type": "session_ready", "realtime_protocol": protocolVersion])
        try await eventually { first.ready && second.ready }
        store.testCaptureLinks(["interviewer": first, "candidate": second])
        var starts = 0
        store.testControl = { if $0["type"] as? String == "start_transcription" { starts += 1 } }
        store.testCaptureEvent(["type": "prepare_capture", "mode": "assist"])
        // Wait until both ready messages have been sent; do not emit mode_ready yet.
        try await eventually { system.sent.count == 2 && microphone.sent.count == 2 }
        store.testCaptureEvent(["type": "capture_stop", "request_id": "stop-before-mode-ready"])
        try await eventually { !store.preparing }
        try check(!capture.isPrepared && starts == 0, "stop before mode confirmation releases prepare UI without starting")
        store.testCaptureEvent(["type": "prepare_capture", "mode": "assist"])
        try await eventually { capture.isPrepared }
        store.testCaptureEvent(["type": "capture_mode_ready", "mode": "assist"])
        try await eventually { !store.preparing && starts == 1 }
        try check(capture.isPrepared, "same connection can prepare again after early stop")
        await store.disconnect()
    }
    static func stopErrorOwnership() async throws {
        for reconnect in [false, true] {
            let capture = CaptureController(factory: { _ in FakeAudio() })
            let store = AppStore(preview: true, capture: capture)
            try store.testSession("https://fixture.invalid", session("a"))
            let transport = FixtureSocket()
            transport.holdStop = true; transport.delaySendCancellation = true
            let link = SocketLink(url: URL(string: "wss://fixture.invalid/interviewer")!, token: "fixture", role: "interviewer", connectionFactory: { _ in transport })
            link.start(); transport.emit(["type": "session_ready", "realtime_protocol": protocolVersion])
            try await eventually { link.ready }
            store.testCaptureLinks(["interviewer": link])
            store.testCaptureEvent(["type": "capture_stop", "request_id": "tail"])
            try await eventually { transport.heldSend != nil }
            if reconnect {
                await store.disconnect()
                try store.testSession("https://replacement.invalid", session("b"))
                store.error = "NEW_CONNECTION_NOTICE"
            }
            transport.heldSend?.resume(throwing: SageError("synthetic send failure")); transport.heldSend = nil
            if reconnect {
                try await Task.sleep(nanoseconds: 20_000_000)
                try check(store.error == "NEW_CONNECTION_NOTICE", "late old stop failure cannot overwrite replacement connection notice")
            } else {
                try await eventually { store.error != nil }
                try check(store.error == "音频收尾确认失败，尾句可能不完整。", "current connection stop failure still warns about incomplete tail")
            }
            await store.disconnect()
        }
    }
    static func chatRace() async throws {
        let store = AppStore(preview: true)
        try store.testSession("https://a.invalid", session("a"))
        var sent: [JSON] = []
        store.testControl = { sent.append($0) }
        store.draft = "OLD_DRAFT"; store.send()
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        try await eventually { store.error != nil }
        try check(sent.isEmpty, "conversation reset before scheduled send cannot retarget old draft")
        store.error = nil; store.draft = "NEW_DRAFT"; store.send()
        try await eventually { sent.count == 1 }
        try check(sent[0]["conversation_id"] as? String == "b" && sent[0]["text"] as? String == "NEW_DRAFT", "send snapshots current text and conversation together")
        store.testReceive(["type": "chat_message", "chat_message": ["message_id": store.pendingSend!, "text": "NEW_DRAFT"]])
        store.draft = "NEXT_DRAFT"; store.send()
        await store.disconnect()
        try await eventually { store.pendingSend == nil }
        try await Task.sleep(nanoseconds: 10_000_000)
        try check(sent.count == 1, "disconnect invalidates queued send")
    }
    static func screenshotSnapshotBoundary() async throws {
        let store = AppStore(preview: true)
        try store.testSession("https://fixture.invalid", session("a"))
        var sent: [JSON] = []
        store.testControl = { sent.append($0) }
        store.testReceive(["type": "session_ready", "realtime_protocol": protocolVersion, "chat": true, "pinned_code": false])
        store.screenshot()
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.isEmpty && !store.screenshotBusy, "initial snapshot must finish before creating screenshot operation")
        store.testReceive(["type": "operation_snapshot", "operations": []])
        store.screenshot(); store.screenshot()
        try await eventually { sent.count == 1 }
        try check(store.screenshotBusy && sent.count == 1, "snapshot completion allows exactly one pending screenshot")
        store.testReceive(["type": "session_ready", "realtime_protocol": protocolVersion, "chat": true, "pinned_code": false])
        store.testReceive(["type": "operation_snapshot", "operations": []])
        try check(!store.screenshotBusy, "reconnect snapshot still reconciles an older unconfirmed screenshot")
        store.screenshot()
        store.testReceive(["type": "session_ready", "realtime_protocol": protocolVersion, "chat": true, "pinned_code": false])
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.count == 1 && !store.screenshotBusy, "queued screenshot cannot execute after snapshot recovery starts")
        store.testReceive(["type": "operation_snapshot", "operations": []])
        store.screenshot()
        store.testReceive(["type": "session_ready", "realtime_protocol": protocolVersion, "chat": true, "pinned_code": false])
        store.testReceive(["type": "operation_snapshot", "operations": []])
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.count == 1 && !store.screenshotBusy, "reconciled screenshot cannot execute after entire snapshot overtakes queued task")
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        store.screenshot()
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.count == 1, "conversation reset also blocks screenshots before new snapshot boundary")
        await store.disconnect()
    }
    static func screenshotRace() async throws {
        let store = AppStore(preview: true)
        try store.testSession("https://a.invalid", session("a"))
        var sent: [JSON] = []
        store.testControl = { sent.append($0) }
        store.screenshot()
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.isEmpty && !store.screenshotBusy, "queued screenshot cannot move from old chat into new chat")
        store.testReceive(["type": "operation_snapshot", "operations": []])
        store.screenshot()
        store.testReceive(["type": "conversation_reset", "conversation_id": "a"])
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        try await Task.sleep(nanoseconds: 20_000_000)
        try check(sent.isEmpty && !store.screenshotBusy, "switching away and back still invalidates queued screenshot")
        store.testReceive(["type": "operation_snapshot", "operations": []])
        store.screenshot(); try await eventually { sent.count == 1 }
        let oldOperation = sent[0]["operation_id"] as! String
        store.testReceive(["type": "operation_status", "kind": "request_screen_capture", "operation_id": oldOperation, "status": "completed"])
        store.screenshot(); try await eventually { sent.count == 2 }
        store.testReceive(["type": "operation_status", "kind": "request_screen_capture", "operation_id": oldOperation, "status": "completed"])
        try check(store.screenshotBusy, "late old screenshot completion cannot release newer screenshot state")
        let currentOperation = sent[1]["operation_id"] as! String
        store.testReceive(["type": "operation_status", "kind": "request_screen_capture", "operation_id": currentOperation, "status": "completed"])
        try check(!store.screenshotBusy, "current screenshot completion releases its own state")
        await store.disconnect()
    }
    static func screenshotUploadRace() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureHTTP.self]
        let capture = CaptureController(factory: { _ in FakeAudio() })
        let store = AppStore(preview: true, http: HTTPClient(configuration: configuration), capture: capture)
        try store.testSession("https://fixture.invalid", session("a")); store.sourceID = "primary"
        let socket = FixtureSocket()
        let link = SocketLink(url: URL(string: "wss://fixture.invalid/interviewer")!, token: "fixture", role: "interviewer", connectionFactory: { _ in socket })
        link.start(); socket.emit(["type": "session_ready", "realtime_protocol": protocolVersion])
        try await eventually { link.ready }; store.testCaptureLinks(["interviewer": link])
        var captures = 0, uploads = 0
        var waiting: CheckedContinuation<JSON, Error>?
        FixtureHTTP.handler = { request in uploads += 1; request.respond(["ok": true]) }
        capture.testScreenshot = { _ in captures += 1; return try await withCheckedThrowingContinuation { waiting = $0 } }
        store.testCaptureEvent(["type": "screen_capture_request", "request_id": "old-before-start", "conversation_id": "a"])
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        store.testReceive(["type": "conversation_reset", "conversation_id": "a"])
        try await eventually { socket.sent.count >= 2 }
        try check(captures == 0 && uploads == 0, "stale screenshot event never invokes capture after a chat round trip")
        store.testCaptureEvent(["type": "screen_capture_request", "request_id": "old-during-capture", "conversation_id": "a"])
        try await eventually { waiting != nil }
        store.testReceive(["type": "conversation_reset", "conversation_id": "b"])
        waiting?.resume(returning: ["image_data": "data:image/png;base64,iVBORw0KGgo=", "appshot": ["status": "available", "text": "ONLY_A"]])
        try await eventually { socket.sent.count >= 3 }
        try check(captures == 1 && uploads == 0, "App Shot finishing after chat switch is discarded before HTTP upload")
        capture.testScreenshot = { _ in ["image_data": "data:image/png;base64,iVBORw0KGgo=", "appshot": ["status": "available", "text": "ONLY_B"]] }
        store.testCaptureEvent(["type": "screen_capture_request", "request_id": "new", "conversation_id": "b"])
        try await eventually { uploads == 1 }
        try check(uploads == 1, "new chat can upload its own explicit screenshot")
        await store.disconnect(); FixtureHTTP.handler = nil
    }
    static func refreshRace() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureHTTP.self]
        let store = AppStore(preview: true, http: HTTPClient(configuration: configuration))
        try store.testSession("https://a.invalid", session("a"))
        var waiting: FixtureHTTP?
        var established: [String] = []
        store.testEstablish = { address, _ in established.append(address.url.host!) }
        FixtureHTTP.handler = { request in
            if request.request.url?.host == "a.invalid" { waiting = request }
            else if request.request.url?.path == "/health" { request.respond(["realtime_protocol": protocolVersion, "chat": true, "pinned_code": false, "appshot": true]) }
            else { request.respond(["interview_id": "current", "conversation_id": "b", "session_token": "fixture-ui", "capture_token": "fixture-capture"]) }
        }
        let refreshing = Task { await store.testRefresh() }
        try await eventually { waiting != nil }
        await store.connect(server: "https://b.invalid", token: "synthetic", codex: "", remember: false)
        try check(established == ["b.invalid"], "new connection B establishes while old recovery A waits")
        waiting?.respond(["interview_id": "current", "conversation_id": "a", "session_token": "fixture-ui", "capture_token": "fixture-capture"])
        await refreshing.value
        try check(established == ["b.invalid"] && store.state.conversationID == "b", "late recovery A cannot replace B or leak old links")
        await store.disconnect(); FixtureHTTP.handler = nil
    }
    static func socketContract() async throws {
        let transport = FixtureSocket()
        let link = SocketLink(url: URL(string: "wss://fixture.invalid/ws")!, token: "PRIVATE_TEST_TOKEN", role: "client", connectionFactory: { _ in transport })
        var gaps = 0; link.onGap = { gaps += 1 }
        link.start()
        try await eventually { transport.sent.count == 1 }
        guard case .string(let first) = transport.sent[0], let auth = try JSONSerialization.jsonObject(with: Data(first.utf8)) as? JSON else { throw SageError("Missing auth frame") }
        try check(auth["type"] as? String == "authenticate" && auth["token"] as? String == "PRIVATE_TEST_TOKEN", "socket authenticates in first frame")
        transport.emit(["type": "session_ready", "realtime_protocol": protocolVersion, "chat": true, "pinned_code": false])
        try await eventually { link.ready }
        transport.holdData = true
        link.audio(Data(repeating: 1, count: 100))
        try await eventually { transport.heldSend != nil }
        for value in UInt8(2)...UInt8(4) { link.audio(Data(repeating: value, count: 12_000)) }
        let stopped = Task { try await link.send(["type": "capture_stopped", "request_id": "tail", "complete": false]) }
        transport.heldSend?.resume(); transport.heldSend = nil
        try await stopped.value
        let bytes = transport.sent.compactMap { message -> UInt8? in if case .data(let data) = message { return data.first }; return nil }
        try check(gaps == 1 && bytes == [1, 3, 4], "network queue drops oldest PCM within half-second bound")
        guard case .string(let last) = transport.sent.last! else { throw SageError("Tail acknowledgement preceded PCM") }
        try check(last.contains("capture_stopped"), "stop acknowledgement follows all retained tail frames")
        transport.holdData = true; link.audio(Data([5, 5]))
        try await eventually { transport.heldSend != nil }
        let uncertain = Task { try await link.send(["type": "chat_send", "text": "never replay"]) }
        await Task.yield(); link.close()
        var failed = false
        do { try await uncertain.value } catch { failed = true }
        try check(failed && !link.ready, "closing fails pending control without automatic replay")
        let incompatible = FixtureSocket()
        let rejected = SocketLink(url: URL(string: "wss://fixture.invalid/ws")!, token: "test", role: "client", connectionFactory: { _ in incompatible })
        var message = ""; rejected.onState = { _, text in message = text }
        rejected.start(); incompatible.emit(["type": "session_ready", "realtime_protocol": "interview-chat-v11", "chat": true, "pinned_code": false])
        try await eventually { !message.isEmpty }
        try check(!rejected.ready && message.contains("不兼容"), "old protocol is visibly rejected")
        rejected.close()
    }
    static func audioConversion() async throws {
        let sink = AudioSink()
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        let positive = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960)!
        let negative = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960)!
        for (buffer, value) in [(positive, Float(0.25)), (negative, Float(-0.5))] {
            buffer.frameLength = 960
            for channel in 0..<2 { for frame in 0..<960 { buffer.floatChannelData![channel][frame] = value } }
        }
        await withCheckedContinuation { continuation in
            sink.queue.async {
                sink.consume(positive, role: "interviewer"); sink.consume(negative, role: "candidate")
                continuation.resume()
            }
        }
        await sink.finish()
        let system = sink.take("interviewer"), microphone = sink.take("candidate")
        func samples(_ frames: [Data]) -> [Int16] { frames.flatMap { data in data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) } } }
        let a = samples(system.frames), b = samples(microphone.frames)
        try check(a.count == 480 && b.count == 480, "48 kHz stereo converts and drains to exact 24 kHz mono PCM")
        try check(a.contains { $0 > 1000 } && !a.contains { $0 < -1000 } && b.contains { $0 < -1000 } && !b.contains { $0 > 1000 }, "system audio and microphone never mix")
        try check(!system.gap && !microphone.gap && sink.error() == nil, "converter tail flush preserves both bounded queues")
    }
}
#endif
