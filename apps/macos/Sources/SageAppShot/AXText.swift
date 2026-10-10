import Foundation

public struct WindowTextResult: Sendable {
  public var text: String
  public var status: String
  public var detail: String
  public var basis: WindowMatch.Basis?
  public init(
    text: String = "", status: String, detail: String = "", basis: WindowMatch.Basis? = nil
  ) {
    self.text = text
    self.status = status
    self.detail = detail
    self.basis = basis
  }

  /// Compact UTF-8 bytes conservatively bound the server's JSON.stringify UTF-16 length.
  /// All statuses use this path; text can never make an otherwise valid image fail with 413.
  public func payload(app: String, title: String) -> [String: String] {
    var result = [
      "app_name": String(app.unicodeScalars.prefix(512)),
      "window_title": String(title.unicodeScalars.prefix(2048)),
      "text": String(text.unicodeScalars.prefix(80_000)),
      "status": ["available", "partial", "unavailable"].contains(status) ? status : "unavailable",
      "detail": String(detail.unicodeScalars.prefix(1024)),
    ]
    func fits() -> Bool {
      guard let data = try? JSONSerialization.data(withJSONObject: result) else { return false }
      return data.count < 100_000
    }
    if text.unicodeScalars.count > 80_000 || !fits() {
      result["status"] = "partial"
      result["detail"] = "窗口文字超过上限，已保留部分文字和原图。"
      let scalars = Array(result["text"]!.unicodeScalars)
      var low = 0
      var high = scalars.count
      while low < high {
        let middle = (low + high + 1) / 2
        result["text"] = String(String.UnicodeScalarView(scalars.prefix(middle)))
        if fits() { low = middle } else { high = middle - 1 }
      }
      result["text"] = String(String.UnicodeScalarView(scalars.prefix(low)))
    }
    if !fits() {
      return [
        "app_name": "", "window_title": "", "text": "", "status": "unavailable",
        "detail": "窗口文字不可用，已保留原图。",
      ]
    }
    return result
  }
}

public enum AXReadFailure: Error {
  case deadline, nodeLimit, unavailable
  public var detail: String {
    switch self {
    case .deadline: return "窗口文字读取超时，已保留部分内容。"
    case .nodeLimit: return "窗口元素超过上限，已保留部分内容。"
    case .unavailable: return "部分辅助功能元素无法读取。"
    }
  }
}

/// Only cancellation crosses threads. Clock and node accounting belong to the serial worker.
public final class AXReadBudget: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private let clock: () -> TimeInterval
  private let deadline: TimeInterval
  private let nodeLimit: Int
  private var nodes = 0
  public init(
    seconds: TimeInterval = 3, nodeLimit: Int = 20_000,
    clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.clock = clock
    self.deadline = clock() + seconds
    self.nodeLimit = nodeLimit
  }
  public func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }
  public func checkCancellation() throws {
    lock.lock()
    let value = cancelled
    lock.unlock()
    if value { throw CancellationError() }
  }
  public func timeout() throws -> TimeInterval {
    try checkCancellation()
    let remaining = deadline - clock()
    guard remaining > 0 else { throw AXReadFailure.deadline }
    return min(0.5, remaining)
  }
  public func visit() throws {
    _ = try timeout()
    guard nodes < nodeLimit else { throw AXReadFailure.nodeLimit }
    nodes += 1
  }
  public func wait(_ seconds: TimeInterval, sleep: (TimeInterval) -> Void = Thread.sleep) throws {
    let until = clock() + seconds
    while clock() < until {
      let remaining = try timeout()
      sleep(min(0.025, remaining, until - clock()))
    }
    _ = try timeout()
  }
}

public struct AXNodeText {
  public var role: String, subrole: String, title: String, description: String, value: String
  public var incomplete: Bool
  public init(
    role: String = "", subrole: String = "", title: String = "",
    description: String = "", value: String = "", incomplete: Bool = false
  ) {
    self.role = role
    self.subrole = subrole
    self.title = title
    self.description = description
    self.value = value
    self.incomplete = incomplete
  }

  /// Optional metadata failures must not hide a readable value or a whole subtree.
  /// Identity reads still fail closed so secure fields are never read accidentally.
  public static func read(attribute: (String) throws -> String?) throws -> Self {
    let role = try attribute("AXRole") ?? ""
    let subrole = try attribute("AXSubrole") ?? ""
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
      return Self(role: role, subrole: subrole)
    }
    var incomplete = false
    func optional(_ name: String) throws -> String {
      do { return try attribute(name) ?? "" }
      catch is CancellationError { throw CancellationError() }
      catch {
        if let failure = error as? AXReadFailure, failure != .unavailable { throw failure }
        incomplete = true
        return ""
      }
    }
    let title = try optional("AXTitle")
    let description = try optional("AXDescription")
    let value = try optional("AXValue")
    return Self(role: role, subrole: subrole, title: title, description: description,
                value: value, incomplete: incomplete)
  }
}

public protocol AXNode {
  var identity: AnyHashable { get }
  func text() throws -> AXNodeText
  /// Pages prevent a very wide tree from allocating an unbounded children array.
  func children(offset: Int, limit: Int) throws -> [any AXNode]
}

public struct AXTextSnapshot {
  public var result: WindowTextResult
  public var hasWebContent: Bool
}

public enum AXTextBuilder {
  public static func read(
    root: any AXNode, app: String, title: String, budget: AXReadBudget,
    textLimit: Int = 80_000, depthLimit: Int = 60
  ) throws -> AXTextSnapshot {
    var output = String("Window: \"\(title)\", App: \(app)".unicodeScalars.prefix(textLimit))
    var count = output.unicodeScalars.count
    var seen = Set<AnyHashable>()
    var previous = ""
    var hasText = false
    var webText = false
    var issues: [String] = []
    var full = false
    func issue(_ value: String) { if !issues.contains(value) { issues.append(value) } }
    func visit(_ node: any AXNode, depth: Int, inWeb: Bool) throws {
      guard !full, !seen.contains(node.identity) else { return }
      try budget.visit()
      seen.insert(node.identity)
      let fields: AXNodeText
      do { fields = try node.text() } catch is CancellationError { throw CancellationError() } catch
      {
        if let failure = error as? AXReadFailure, failure != .unavailable { throw failure }
        issue(AXReadFailure.unavailable.detail)
        return
      }
      guard fields.subrole != "AXSecureTextField", fields.role != "AXSecureTextField" else {
        return
      }
      if fields.incomplete { issue(AXReadFailure.unavailable.detail) }
      var parts: [String] = []
      for raw in [fields.title, fields.description, fields.value] {
        let part = String(raw.unicodeScalars.prefix(textLimit + 1))
        if !part.isEmpty && !parts.contains(part) { parts.append(part) }
      }
      let content = parts.joined(separator: ": ")
      let web = inWeb || fields.role == "AXWebArea"
      if !content.isEmpty {
        if depth > 0 { hasText = true }
        if inWeb { webText = true }
        let line = "[\(fields.role)] \(content)"
        if previous != line {
          let addition = "\n" + String(repeating: "  ", count: depth) + line
          let prefix = String(addition.unicodeScalars.prefix(max(0, textLimit - count)))
          output += prefix
          count += prefix.unicodeScalars.count
          if prefix.unicodeScalars.count < addition.unicodeScalars.count {
            full = true
            issue("窗口文字超过上限，已保留部分内容。")
          }
        }
        previous = line
      }
      guard !full else { return }
      var offset = 0
      while true {
        _ = try budget.timeout()
        let children: [any AXNode]
        do { children = try node.children(offset: offset, limit: 128) } catch is CancellationError {
          throw CancellationError()
        } catch {
          if let failure = error as? AXReadFailure, failure != .unavailable { throw failure }
          issue(AXReadFailure.unavailable.detail)
          return
        }
        if depth >= depthLimit {
          if !children.isEmpty { issue("窗口元素层级超过上限，已保留部分内容。") }
          return
        }
        for child in children {
          try visit(child, depth: depth + 1, inWeb: web)
          if full { return }
        }
        if children.count < 128 { return }
        offset += children.count
      }
    }
    do { try visit(root, depth: 0, inWeb: false) } catch is CancellationError {
      throw CancellationError()
    } catch { issue((error as? AXReadFailure)?.detail ?? AXReadFailure.unavailable.detail) }
    try budget.checkCancellation()
    return AXTextSnapshot(
      result: WindowTextResult(
        text: hasText ? output : "",
        status: hasText ? (issues.isEmpty ? "available" : "partial") : "unavailable",
        detail: issues.isEmpty
          ? (hasText ? "系统辅助功能读取" : "此窗口未提供可读取的文字，已保留原图。")
          : issues.joined(separator: " ")),
      hasWebContent: webText)
  }
}
