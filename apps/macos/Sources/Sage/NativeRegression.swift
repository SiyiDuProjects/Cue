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
    func respond(_ json: JSON, status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
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
    static func run() async {
        do {
            try await keychainWaitCancellation(); try await loginRestoration()
            try await chatgptEventRequests(); try await serverPreparesRequest()
            try await captureRace(); try await prepareCancellation(); try await screenshotOwnership()
            try await audioConversion(); try await socketContract()
            print("\(count) native runtime checks passed"); exit(0)
        } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
    }
    /// Explicit diagnostic: authenticated connection only, no Keychain write, host or media.
    static func sitesConnection(sendEvent: Bool = false) async {
        let store = AppStore(preview: true)
        do {
            guard let input = readLine(), let value = try JSONSerialization.jsonObject(with: Data(input.utf8)) as? JSON,
                  let origin = value["origin"] as? String, let keys = value["credential"] as? JSON else { throw SageError("Invalid diagnostic input") }
            let token = String(data: try JSONSerialization.data(withJSONObject: keys), encoding: .utf8)!
            await store.connect(server: origin, token: token, remember: false)
            guard store.connected else { throw SageError(store.error ?? store.connection) }
            for _ in 0..<200 {
                if store.testReadyChannels == 2 { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            guard store.testReadyChannels == 2, !store.state.active, !store.preparing else { throw SageError("Audio connection verification failed") }
            print("PASS native AppStore authenticated HTTP, recording snapshot and two idle WebSockets; no media or model started")
            if sendEvent {
                guard let expectedRecording = value["expected_recording"] as? String,
                      let expectedImage = value["expected_image"] as? String,
                      let expectedSubscription = value["expected_subscription"] as? String,
                      store.state.conversationID == expectedRecording,
                      store.state.screens.count == 1,
                      store.state.screens.first?["request_id"] as? String == expectedImage,
                      store.state.transcripts.isEmpty else { throw SageError("Diagnostic fixture changed; no event sent") }
                await store.chatgpt.refresh()
                guard store.chatgpt.subscriptions.contains(where: { $0["id"] as? String == expectedSubscription }) else { throw SageError("Expected subscription missing; no event sent") }
                store.chatgpt.selectedID = expectedSubscription
                store.requestChatGPT()
                for _ in 0..<450 {
                    if store.chatgpt.requestID != nil && !store.chatgpt.waiting { break }
                    try await Task.sleep(for: .milliseconds(100))
                }
                let receipt: JSON = ["request_id":store.chatgpt.requestID ?? "", "status":store.chatgpt.requestStatus,
                                     "recording":expectedRecording, "image":expectedImage]
                print(String(data: try JSONSerialization.data(withJSONObject: receipt), encoding: .utf8)!)
                guard store.chatgpt.requestStatus == "delivered" else { throw SageError(store.chatgpt.status) }
                print("PASS explicit native request accepted by ChatGPT; answer completion must be verified in the subscribed chat")
            }
            await store.disconnect(); exit(0)
        } catch { await store.disconnect(); fputs("Sites connection check failed: \(error.localizedDescription)\n", stderr); exit(1) }
    }
    static func captureApplication(_ delegate: AppDelegate) async {
        do {
            try await eventually { delegate.store != nil }
            guard let store = delegate.store else { throw SageError("Capture store did not start") }
            try check(store.preview, "application fixture never opens production connections")
            try check(NSApp.activationPolicy() == .accessory, "normal capture launch has no Dock application")
            try await Task.sleep(for: .milliseconds(300))
            try check(!NSApp.windows.contains { $0.isVisible && $0.canBecomeMain }, "capture launch opens no chat or settings window")
            store.openCaptureSettings()
            try await eventually { NSApp.windows.contains { $0.isVisible && $0.title == "Cue 设置" } }
            try check(!store.state.active && !store.preparing, "opening capture settings starts no audio")
            try check(store.state.transcripts.count > 0, "capture settings retain the saved transcript")
            print("5 capture application lifecycle checks passed")
            exit(0)
        } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
    }
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
    static func chatgptEventRequests() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureHTTP.self]
        let http = HTTPClient(configuration: config)
        let events = ChatGPTRequests(http: http, preview: true)
        let address = try ServerAddress("https://events.invalid")
        events.configure(address: address, session: try session("a"), supported: true)
        var posts = 0, reads = 0
        var pending: FixtureHTTP?
        var sent: JSON = [:]
        FixtureHTTP.handler = { request in
            if request.request.httpMethod == "POST" {
                posts += 1; pending = request
                var body = request.request.httpBody ?? Data()
                if body.isEmpty, let stream = request.request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(buffer, count: n) }
                }
                sent = (try? JSONSerialization.jsonObject(with: body)) as? JSON ?? [:]
            } else {
                reads += 1
                request.respond(["subscriptions": [["id": "fixture-sub", "channel": "mac"]], "requests": []])
            }
        }
        await events.refresh()
        try check(events.canRequest && events.selectedID == "fixture-sub", "one valid subscription is selected without model work")
        events.submit(conversation: "a", imageIDs: ["screen-a"])
        events.submit(conversation: "b", imageIDs: [])
        try await eventually { pending != nil }
        try check(posts == 1 && sent["conversation_id"] as? String == "a" && sent["image_ids"] as? [String] == ["screen-a"], "repeated hotkey sends one request with original chat and selected screenshots")
        try check(sent["text"] == nil && sent["draft"] == nil, "event request never exports composer draft")
        let id = events.requestID!
        pending?.respond(["id": id, "status": "queued", "detail": "fixture queued"], status: 202)
        try await eventually { !events.posting }
        events.disconnect()
        events.configure(address: address, session: try session("b"), supported: true)
        try check(posts == 1, "reconnect never resends an uncertain ChatGPT request")
        FixtureHTTP.handler = { request in
            reads += 1
            request.respond(["id": id, "status": "delivered", "detail": "ChatGPT 已接收，请到订阅对话查看回答。"])
        }
        await events.refreshReceipt()
        try check(events.requestStatus == "delivered" && posts == 1, "receipt query resolves delivery without claiming answer completion")
        events.disconnect()

        let late = ChatGPTRequests(http: http, preview: true)
        late.configure(address: address, session: try session("a"), supported: true)
        var waiting: FixtureHTTP?
        FixtureHTTP.handler = { waiting = $0 }
        let refresh = Task { await late.refresh() }
        try await eventually { waiting != nil }
        late.disconnect()
        waiting?.respond(["subscriptions": [["id": "stale", "channel": "mac"]]])
        await refresh.value
        try check(late.subscriptions.isEmpty && !late.canRequest, "late subscription response cannot re-enable a disconnected client")

        FixtureHTTP.handler = nil
    }
    static func keychainWaitCancellation() async throws {
        var credential: CheckedContinuation<String, Error>?
        let store = AppStore(preview: true, loadCredential: { _ in
            try await withCheckedThrowingContinuation { credential = $0 }
        })
        let restore = Task { await store.testRestoreConnection() }
        try await eventually { credential != nil }
        try check(store.connecting, "keychain confirmation waits without blocking main actor")
        await store.disconnect()
        try check(!store.connecting, "disconnect remains available during keychain confirmation")
        credential?.resume(returning: "fixture-token")
        await restore.value
        try check(!store.connected && store.testServer == nil, "late keychain result cannot reconnect or open a network session")
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
    static func socketContract() async throws {
        let transport = FixtureSocket()
        let link = SocketLink(url: URL(string: "wss://fixture.invalid/ws")!, token: "PRIVATE_TEST_TOKEN", role: "interviewer", connectionFactory: { _ in transport })
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
        let stopped = Task { try await link.send(["type": "stop", "request_id": "tail", "complete": false]) }
        transport.heldSend?.resume(); transport.heldSend = nil
        try await stopped.value
        let bytes = transport.sent.compactMap { message -> UInt8? in if case .data(let data) = message { return data.first }; return nil }
        try check(gaps == 1 && bytes == [1, 3, 4], "network queue drops oldest PCM within half-second bound")
        guard case .string(let last) = transport.sent.last! else { throw SageError("Tail acknowledgement preceded PCM") }
        try check(last.contains("stop"), "stop acknowledgement follows all retained tail frames")
        transport.holdData = true; link.audio(Data([5, 5]))
        try await eventually { transport.heldSend != nil }
        let uncertain = Task { try await link.send(["type": "flush", "id": "never-replay"]) }
        await Task.yield(); link.close()
        var failed = false
        do { try await uncertain.value } catch { failed = true }
        try check(failed && !link.ready, "closing fails pending control without automatic replay")
        let incompatible = FixtureSocket()
        let rejected = SocketLink(url: URL(string: "wss://fixture.invalid/ws")!, token: "test", role: "interviewer", connectionFactory: { _ in incompatible })
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
    static let credential = #"{"site":"synthetic-site","device":"synthetic-device"}"#
    static func loginRestoration() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureHTTP.self]
        let http = HTTPClient(configuration: config)
        var requests = 0, loads = 0, links = 0
        let store = AppStore(preview: true, http: http, loadCredential: { _ in loads += 1; return credential })
        store.testEstablish = { _, _ in links += 1 }
        FixtureHTTP.handler = { request in
            requests += 1
            guard request.request.value(forHTTPHeaderField: "OAI-Sites-Authorization") == "Bearer synthetic-site", request.request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-device" else { request.respond([:], status: 401); return }
            switch request.request.url?.path {
            case "/health": request.respond(["capture_protocol": protocolVersion, "appshot": true])
            case "/capture/session": request.respond(["interview_id": "current", "conversation_id": "restored", "session_token": "synthetic-device", "capture_token": "synthetic-device"])
            default: request.respond(["recording": "restored", "turns": [], "images": []])
            }
        }
        await store.testRestoreConnection(); await store.testRestoreConnection()
        try check(loads == 1 && requests == 3 && links == 1 && store.connected, "saved Sites login restores once through authenticated HTTP and snapshot")
        try check(!store.state.active && !store.preparing, "restoration never starts capture or transcription")
        var leaked = true
        FixtureHTTP.handler = { request in leaked = request.request.value(forHTTPHeaderField: "OAI-Sites-Authorization") != nil; request.respond([:]) }
        _ = try await http.request(ServerAddress("https://other.invalid"), "/health")
        try check(!leaked, "Sites service credential cannot leak to another origin")
        await store.disconnect()
        requests = 0
        let missing = AppStore(preview: true, http: http, loadCredential: { _ in "" })
        FixtureHTTP.handler = { request in requests += 1; request.respond([:]) }
        await missing.testRestoreConnection()
        try check(missing.needsSignIn && requests == 0, "missing credential opens no network connection")
        let expired = AppStore(preview: true, http: http, loadCredential: { _ in credential })
        FixtureHTTP.handler = { $0.respond([:], status: 401) }
        await expired.testRestoreConnection()
        try check(expired.needsSignIn && !expired.connected, "expired Sites access requires authentication without model work")
        await expired.disconnect(); FixtureHTTP.handler = nil
    }
    static func prepareCancellation() async throws {
        var pending: CheckedContinuation<any AudioCaptureSession, Error>?
        let audio = FakeAudio(), capture = CaptureController(factory: { _ in try await withCheckedThrowingContinuation { pending = $0 } })
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureHTTP.self]
        FixtureHTTP.handler = { $0.respond(["recording":"recording", "turns":[], "images":[]]) }
        let store = AppStore(preview: true, http: HTTPClient(configuration: config), capture: capture)
        try store.testSession("https://fixture.invalid", session("recording"))
        let sockets = ["interviewer": FixtureSocket(), "candidate": FixtureSocket()]
        var links: [String: SocketLink] = [:]
        for (role,socket) in sockets {
            let link = SocketLink(url: URL(string: "wss://fixture.invalid/"+role)!, token: "synthetic", role: role, connectionFactory: { _ in socket })
            links[role] = link; link.start(); socket.emit(["type":"session_ready", "realtime_protocol":protocolVersion])
        }
        try await eventually { links.values.allSatisfy { $0.ready } }; store.testCaptureLinks(links)
        let prepare = Task { try await store.testStartAudio() }
        try await eventually { pending != nil }
        try await store.control(["type":"stop_transcription"])
        pending?.resume(returning: audio)
        do { try await prepare.value } catch is CancellationError {}
        let started = sockets.values.flatMap { $0.sent }.contains { if case .string(let s) = $0 { return s.contains("\"start\"") }; return false }
        try check(!started && !capture.isPrepared && audio.stops == 1, "stop during capture preparation prevents late upstream start")
        await store.disconnect()
    }
    static func screenshotOwnership() async throws {
        var pending: CheckedContinuation<JSON, Error>?
        let capture = CaptureController(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureHTTP.self]
        let store = AppStore(preview: true, http: HTTPClient(configuration: config), capture: capture)
        try store.testSession("https://fixture.invalid", session("first")); store.sourceID = "primary"
        var uploads = 0
        FixtureHTTP.handler = { request in uploads += 1; request.respond([:]) }
        capture.testScreenshot = { _ in try await withCheckedThrowingContinuation { pending = $0 } }
        store.screenshot(); try await eventually { pending != nil }
        await store.disconnect(); try store.testSession("https://fixture.invalid", session("second"))
        store.error = "new recording"
        pending?.resume(returning: ["image_data":"data:image/png;base64,eA=="])
        try await Task.sleep(for: .milliseconds(20))
        try check(uploads == 0 && store.error == "new recording", "late screenshot cannot upload to replacement session or overwrite its status")
        await store.disconnect(); FixtureHTTP.handler = nil
    }
    static func serverPreparesRequest() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureHTTP.self]
        let store = AppStore(preview: true, http: HTTPClient(configuration: config))
        try store.testSession("https://fixture.invalid", session("recording"))
        store.chatgpt.configure(address: try ServerAddress("https://fixture.invalid"), session: try session("recording"), supported: true)
        var posts = 0
        FixtureHTTP.handler = { request in
            if request.request.url?.path == "/api/prepare" { request.respond(["status":"preparing"]) }
            else if request.request.httpMethod == "POST" { posts += 1; request.respond(["id":store.chatgpt.requestID!, "status":"delivered"]) }
            else { request.respond(["subscriptions":[["id":"subscription","channel":"mac"]]]) }
        }
        await store.chatgpt.refresh()
        let socket = FixtureSocket(), link = SocketLink(url: URL(string:"wss://fixture.invalid/audio")!, token:"synthetic", role:"candidate", connectionFactory:{ _ in socket })
        link.start(); socket.emit(["type":"session_ready","realtime_protocol":protocolVersion]); try await eventually { link.ready }
        store.testCaptureLinks(["candidate":link]); store.preparing = true; store.testCaptureEvent(["type":"started"], role:"candidate"); store.preparing = false
        store.requestChatGPT()
        try await eventually { posts == 1 }
        try check(socket.sent.count == 2, "manual request sends an ordered read marker, without transcript content")
        try check(posts == 1, "one explicit request delegates tail preparation to the server")
        await store.disconnect(); FixtureHTTP.handler = nil
    }
}
#endif
