import Foundation
import SageAppShot

func appShotFixtures() -> [[String: String]] {
  ["a", "\"", "\\", "\n", "\u{01}", "😀", "e\u{301}", "中文"].map { unit in
    WindowTextResult(text: String(repeating: unit, count: 80_000), status: "available")
      .payload(app: String(repeating: "😀", count: 512), title: String(repeating: "\"", count: 2048))
  }
}

private final class FixtureNode: AXNode {
  var fields: AXNodeText
  var items: [FixtureNode]
  var onRead: (() throws -> Void)?
  var reads = 0
  var identity: AnyHashable { ObjectIdentifier(self) }
  init(_ role: String = "AXStaticText", value: String = "", children: [FixtureNode] = []) {
    fields = AXNodeText(role: role, value: value)
    items = children
  }
  func text() throws -> AXNodeText {
    reads += 1
    try onRead?()
    return fields
  }
  func children(offset: Int, limit: Int) throws -> [any AXNode] {
    Array(items.dropFirst(offset).prefix(limit))
  }
}

private final class FixtureSource: AXWindowSource {
  let budget: AXReadBudget
  var items: [AXWindow]
  var scans = 0
  var manual = 0
  var settings: [(Bool, Bool)] = []
  var oldEnhanced: Bool? = false
  var onScan: ((Int) throws -> Void)?
  var onSet: (() throws -> Void)?
  init(root: FixtureNode, target: WindowIdentity, budget: AXReadBudget, id: UInt32? = nil) {
    self.budget = budget
    items = [
      AXWindow(identity: .init(id: id, bounds: target.bounds, title: target.title), node: root)
    ]
  }
  func windows() throws -> [AXWindow] {
    _ = try budget.timeout()
    scans += 1
    try onScan?(scans)
    return items
  }
  func enableManualAccessibility() throws {
    _ = try budget.timeout()
    manual += 1
  }
  func enhancedAccessibility() throws -> Bool? {
    _ = try budget.timeout()
    return oldEnhanced
  }
  func setEnhancedAccessibility(_ value: Bool, restoring: Bool) throws {
    if !restoring { _ = try budget.timeout() }
    settings.append((value, restoring))
    if !restoring { try onSet?() }
  }
}

func runAppShotChecks() throws {
  let start = checked
  let bounds = CGRect(x: 100, y: 200, width: 600, height: 400)
  let target = WindowIdentity(id: 42, pid: 99, bounds: bounds, title: "Synthetic")
  let sibling = WindowIdentity(id: 43, pid: 99, bounds: bounds, title: "Synthetic")
  let candidates = [42, 43].map {
    WindowMatch.Candidate(id: UInt32($0), bounds: bounds, title: target.title)
  }
  check(
    WindowMatch.select(target, candidates: candidates)?.index == 0,
    "AX exact ID separates overlapping same-title windows")
  check(
    WindowMatch.isCurrent(target, windows: [target, sibling], basis: .exactID),
    "exact revalidation permits identical sibling geometry")
  check(
    !WindowMatch.isCurrent(target, windows: [target, sibling], basis: .geometry),
    "geometry revalidation still rejects ambiguity")
  check(
    WindowMatch.select(target, candidates: [.init(id: 43, bounds: bounds, title: target.title)])
      == nil,
    "known wrong ID never falls back to geometry")
  check(
    WindowMatch.select(target, candidates: [candidates[0], candidates[0]]) == nil,
    "duplicate exact IDs rejected")
  check(
    WindowMatch.select(target, candidates: [.init(id: nil, bounds: bounds, title: target.title)])?
      .basis == .geometry,
    "missing private symbol or failed ID lookup retains geometry fallback")
  check(
    WindowMatch.select(target, candidates: [.init(id: nil, bounds: nil, title: target.title)])
      == nil,
    "missing geometry cannot identify a window")
  for basis in [WindowMatch.Basis.exactID, .geometry] {
    for replacement in [
      sibling,
      WindowIdentity(id: 42, pid: 100, bounds: bounds, title: target.title),
      WindowIdentity(id: 42, pid: 99, bounds: bounds, title: "Changed"),
      WindowIdentity(id: 42, pid: 99, bounds: bounds.offsetBy(dx: 10, dy: 0), title: target.title),
    ] {
      check(
        !WindowMatch.isCurrent(target, windows: [replacement], basis: basis),
        "changed window identity discards text")
    }
    check(!WindowMatch.isCurrent(target, windows: [], basis: basis), "closed window discards text")
  }

  let repeated = FixtureNode(value: "ORBIT-4729")
  let failedDescription = try AXNodeText.read { name in
    if name == "AXDescription" { throw AXReadFailure.unavailable }
    return ["AXRole": "AXScrollArea", "AXValue": "READABLE-VALUE"][name]
  }
  check(failedDescription.incomplete && failedDescription.value == "READABLE-VALUE",
        "failed optional description preserves readable value")
  let container = FixtureNode("AXScrollArea", children: [FixtureNode(value: "TEXTEDIT-BODY")])
  container.fields = failedDescription
  let retained = try AXTextBuilder.read(
    root: FixtureNode("AXWindow", children: [container]), app: "Fixture", title: "Synthetic",
    budget: AXReadBudget())
  check(retained.result.status == "partial" && retained.result.text.contains("TEXTEDIT-BODY"),
        "failed container metadata does not skip its text descendants")
  var secureRead = false
  _ = try AXNodeText.read { name in
    if name == "AXValue" { secureRead = true }
    return ["AXRole": "AXTextField", "AXSubrole": "AXSecureTextField"][name]
  }
  check(!secureRead, "secure classification happens before any value read")
  var unknownRoleValueRead = false
  _ = try? AXNodeText.read { name in
    if name == "AXSubrole" { throw AXReadFailure.unavailable }
    if name == "AXValue" { unknownRoleValueRead = true }
    return nil
  }
  check(!unknownRoleValueRead, "failed secure classification stops value reads")
  for cancel in [false, true] {
    var propagated = false
    do {
      _ = try AXNodeText.read { name in
        if name == "AXDescription" {
          if cancel { throw CancellationError() }
          throw AXReadFailure.deadline
        }
        return nil
      }
    } catch is CancellationError { propagated = cancel }
      catch AXReadFailure.deadline { propagated = !cancel }
    check(propagated, "optional attribute reads preserve cancellation and deadline")
  }
  let area = FixtureNode("AXTextArea", value: "BEFORE\nORBIT-4729\nAFTER")
  let root = FixtureNode("AXWindow", children: [repeated, FixtureNode(value: "ORBIT-4729"), area])
  let snapshot = try AXTextBuilder.read(
    root: root, app: "Fixture", title: "Synthetic", budget: AXReadBudget())
  check(
    snapshot.result.status == "available"
      && snapshot.result.text.contains("BEFORE\nORBIT-4729\nAFTER"),
    "AX text area retains all supplied text, including offscreen content")
  check(
    snapshot.result.text.components(separatedBy: "[AXStaticText] ORBIT-4729").count == 2,
    "adjacent repeated text is emitted once")
  check(
    snapshot.result.text.hasPrefix("Window: \"Synthetic\", App: Fixture\n"),
    "AX text has window header")
  let secure = FixtureNode("AXTextField", value: "PRIVATE")
  secure.fields.subrole = "AXSecureTextField"
  root.items.append(secure)
  let secureResult = try AXTextBuilder.read(
    root: root, app: "Fixture", title: "Synthetic", budget: AXReadBudget())
  check(!secureResult.result.text.contains("PRIVATE"), "secure text field values excluded")
  root.items.append(root)
  let cycleResult = try AXTextBuilder.read(
    root: root, app: "Fixture", title: "Synthetic", budget: AXReadBudget())
  check(
    cycleResult.result.status == "available", "cyclic AX references do not recurse indefinitely")
  let limited = try AXTextBuilder.read(
    root: root, app: "Fixture", title: "Synthetic", budget: AXReadBudget(nodeLimit: 2))
  check(
    limited.result.status == "partial" && limited.result.text.contains("ORBIT"),
    "node limit retains earlier text")
  let shallow = try AXTextBuilder.read(
    root: FixtureNode("AXWindow", children: [FixtureNode(value: "first", children: [area])]),
    app: "Fixture", title: "Synthetic", budget: AXReadBudget(), depthLimit: 1)
  check(
    shallow.result.status == "partial" && shallow.result.text.contains("first")
      && !shallow.result.text.contains("BEFORE"),
    "depth limit retains parent text without reading descendants")
  let long = try AXTextBuilder.read(
    root: FixtureNode(
      "AXWindow", children: [FixtureNode(value: String(repeating: "字", count: 90_000))]),
    app: "Fixture", title: "Synthetic", budget: AXReadBudget())
  check(
    long.result.status == "partial" && long.result.text.unicodeScalars.count == 80_000,
    "builder scalar limit marks partial")
  let wide = FixtureNode("AXWindow", children: (0..<300).map { FixtureNode(value: "row-\($0)") })
  let wideResult = try AXTextBuilder.read(
    root: wide, app: "Fixture", title: "Synthetic", budget: AXReadBudget())
  check(wideResult.result.text.contains("row-299"), "children pagination reads beyond first page")

  for payload in appShotFixtures() {
    let data = try JSONSerialization.data(withJSONObject: payload)
    check(data.count < 100_000, "full escaped appshot fits server budget")
    let decoded = try JSONSerialization.jsonObject(with: data) as? [String: String]
    check(decoded == payload, "budget preserves valid Unicode and JSON")
  }
  for status in ["available", "partial", "unavailable"] {
    let payload = WindowTextResult(
      text: "ORBIT-4729", status: status, detail: String(repeating: "😀", count: 9000)
    )
    .payload(app: String(repeating: "\"", count: 9000), title: String(repeating: "\\", count: 9000))
    let bytes = try JSONSerialization.data(withJSONObject: payload).count
    check(
      bytes < 100_000 && payload["status"] == status,
      "all statuses bound metadata before upload")
  }
  let empty = WindowTextResult(status: "available").payload(app: "Fixture", title: "Synthetic")
  let overhead = try JSONSerialization.data(withJSONObject: empty).count
  // Quotes exercise JSON escaping while staying below the preliminary 80k scalar cap.
  let text99999 =
    String(repeating: "\"", count: (99_999 - overhead) / 2)
    + String(repeating: "a", count: (99_999 - overhead) % 2)
  let fits = WindowTextResult(text: text99999, status: "available").payload(
    app: "Fixture", title: "Synthetic")
  let fitsBytes = try JSONSerialization.data(withJSONObject: fits).count
  check(
    fitsBytes == 99_999 && fits["status"] == "available",
    "99999 serialized bytes accepted unchanged")
  let truncated = WindowTextResult(text: text99999 + "a", status: "available").payload(
    app: "Fixture", title: "Synthetic")
  let truncatedBytes = try JSONSerialization.data(withJSONObject: truncated).count
  check(
    truncatedBytes < 100_000 && truncated["status"] == "partial",
    "100000 serialized bytes rejected and truncated with final status included")

  var now: TimeInterval = 0
  let timed = AXReadBudget(seconds: 0.1, clock: { now })
  let remaining = try timed.timeout()
  check(abs(remaining - 0.1) < 0.001, "AX call timeout shrinks to remaining budget")
  let slow = FixtureNode(value: "late")
  slow.onRead = {
    now = 1
    throw AXReadFailure.deadline
  }
  let timedRoot = FixtureNode(
    "AXWindow", children: [FixtureNode(value: "saved"), slow, FixtureNode(value: "never")])
  let timedResult = try AXTextBuilder.read(
    root: timedRoot, app: "Fixture", title: "Synthetic", budget: timed)
  check(
    timedResult.result.status == "partial" && timedResult.result.text.contains("saved")
      && !timedResult.result.text.contains("never"),
    "unresponsive node stops traversal and retains earlier text")
  check((try? timed.timeout()) == nil, "expired timeout never becomes zero/default")
  let cancelled = AXReadBudget()
  let cancelNode = FixtureNode(value: "cancel")
  cancelNode.onRead = { cancelled.cancel() }
  let untouched = FixtureNode(value: "never")
  do {
    _ = try AXTextBuilder.read(
      root: FixtureNode("AXWindow", children: [cancelNode, untouched]),
      app: "Fixture", title: "Synthetic", budget: cancelled)
    check(false, "cancelled capture must throw")
  } catch is CancellationError {
    check(untouched.reads == 0, "cancellation stops subsequent traversal")
  }

  // Exercise temporary setting cleanup after success, RPC failure, timeout, and cancellation.
  for outcome in ["success", "failure", "deadline", "cancel"] {
    var time: TimeInterval = 0
    let budget = AXReadBudget(clock: { time })
    let chromeRoot = FixtureNode("AXWindow", children: [FixtureNode(value: "toolbar")])
    let source = FixtureSource(root: chromeRoot, target: target, budget: budget, id: 42)
    source.onSet = {
      if outcome == "failure" { throw AXReadFailure.unavailable }
      if outcome == "deadline" { time = 4 }
      if outcome == "cancel" { budget.cancel() }
      if outcome == "success" {
        chromeRoot.items.append(
          FixtureNode("AXWebArea", children: [FixtureNode(value: "web body")]))
      }
    }
    do {
      let result = try AXWindowReader.read(
        target: target, app: "Fixture", chromium: true,
        source: source, budget: budget, sleep: { time += $0 })
      check(outcome != "cancel", "cancel does not return an uploadable result")
      check(
        result.status == (outcome == "success" ? "available" : "partial"),
        "browser retry preserves appropriate completeness")
    } catch is CancellationError {
      check(outcome == "cancel", "cancel propagated to screenshot caller")
    }
    check(
      source.settings.count == 2 && source.settings[0] == (true, false)
        && source.settings[1] == (false, true),
      "temporary enhanced accessibility restored after \(outcome)")
    check(source.scans <= 3 && source.manual == 1, "browser attempts are bounded")
  }
  var retryTime: TimeInterval = 0
  let retryBudget = AXReadBudget(seconds: 0.2, clock: { retryTime })
  let retrySource = FixtureSource(
    root: FixtureNode("AXWindow", children: [FixtureNode(value: "toolbar")]), target: target,
    budget: retryBudget)
  let retryResult = try AXWindowReader.read(
    target: target, app: "Fixture", chromium: true,
    source: retrySource, budget: retryBudget, sleep: { retryTime += $0 })
  check(
    retrySource.scans == 1 && retryResult.status == "partial",
    "Chromium wait cannot reset or exceed shared deadline")
  for old in [true, nil] as [Bool?] {
    var time: TimeInterval = 0
    let budget = AXReadBudget(clock: { time })
    let source = FixtureSource(root: FixtureNode("AXWindow"), target: target, budget: budget)
    source.oldEnhanced = old
    _ = try AXWindowReader.read(
      target: target, app: "Fixture", chromium: true, source: source, budget: budget,
      sleep: { time += $0 })
    check(source.settings.isEmpty, "unknown or already enabled enhancement remains unchanged")
  }
  print("\(checked - start) App Shot offline checks passed")
}
