import AppKit
import ApplicationServices
import Darwin
import OSLog
import SageAppShot

enum AccessibilityAccess {
  static let settingsURL = URL(
    string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
  static var granted: Bool { AXIsProcessTrusted() }
  static func require(asking: Bool) -> Bool {
    if granted { return true }
    guard asking else { return false }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    return AXIsProcessTrustedWithOptions(options as CFDictionary)
  }
}

enum WindowText {
  private static let queue = DispatchQueue(label: "com.siyidu.sage.appshot.ax", qos: .userInitiated)
  @MainActor static func capture(target: WindowIdentity, appName: String) async throws
    -> WindowTextResult
  {
    try Task.checkCancellation()
    guard AccessibilityAccess.require(asking: true) else {
      return WindowTextResult(
        status: "unavailable",
        detail: "请在系统设置中允许 Cue 访问窗口内容；本次已保留原图。")
    }
    let runningApp = NSRunningApplication(processIdentifier: target.pid)
    let bundleID = runningApp?.bundleIdentifier ?? ""
    let chromium =
      [
        "com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac",
        "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
        "company.thebrowser.Browser",
      ]
      .contains { bundleID.hasPrefix($0) }
      || runningApp?.bundleURL.map {
        FileManager.default.fileExists(
          atPath:
            $0.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
      } == true
    let budget = AXReadBudget()
    let result = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<WindowTextResult, Error>) in
        queue.async {
          do {
            let source = SystemAXSource(pid: target.pid, budget: budget)
            continuation.resume(
              returning: try AXWindowReader.read(
                target: target, app: appName, chromium: chromium, source: source, budget: budget))
          } catch { continuation.resume(throwing: error) }
        }
      }
    } onCancel: {
      budget.cancel()
    }
    try Task.checkCancellation()
    return result
  }
}

private struct AXElementIdentity: Hashable {
  let element: AXUIElement
  static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
  func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// No direct import of this private capability: older/future systems retain geometry fallback.
private enum AXWindowID {
  typealias Function = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  static let function: Function? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
    else {
      return nil
    }
    return unsafeBitCast(symbol, to: Function.self)
  }()
}

private final class SystemAXSource: AXWindowSource {
  private let logger = Logger(subsystem: "com.siyidu.sage.mac", category: "AppShot")
  let app: AXUIElement
  let budget: AXReadBudget
  init(pid: Int32, budget: AXReadBudget) {
    app = AXUIElementCreateApplication(pid)
    self.budget = budget
  }
  func prepare(_ element: AXUIElement, restoring: Bool = false) throws {
    let timeout = restoring ? 0.5 : try budget.timeout()
    guard AXUIElementSetMessagingTimeout(element, Float(timeout)) == .success else {
      throw AXReadFailure.unavailable
    }
  }
  func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    try prepare(element)
    var result: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &result)
    if error == .attributeUnsupported || error == .noValue { return nil }
    guard error == .success else {
      logger.debug("AX attribute \(name, privacy: .public) failed: \(error.rawValue)")
      throw AXReadFailure.unavailable
    }
    return result
  }
  func elements(_ element: AXUIElement, attribute: String, offset: Int, limit: Int) throws
    -> [AXUIElement]
  {
    try prepare(element)
    var count: CFIndex = 0
    let countError = AXUIElementGetAttributeValueCount(element, attribute as CFString, &count)
    if countError == .attributeUnsupported || countError == .noValue { return [] }
    guard countError == .success else {
      logger.debug("AX count \(attribute, privacy: .public) failed: \(countError.rawValue)")
      throw AXReadFailure.unavailable
    }
    guard offset < count else { return [] }
    try prepare(element)
    var result: CFArray?
    let error = AXUIElementCopyAttributeValues(
      element, attribute as CFString, offset, min(limit, count - offset), &result)
    guard error == .success, let values = result as? [AXUIElement] else {
      logger.debug("AX values \(attribute, privacy: .public) failed: \(error.rawValue)")
      throw AXReadFailure.unavailable
    }
    return values
  }
  func windows() throws -> [AXWindow] {
    // More candidates would make a truncated geometry match falsely appear unique.
    let elements = try elements(app, attribute: kAXWindowsAttribute, offset: 0, limit: 513)
    guard elements.count <= 512 else { throw AXReadFailure.nodeLimit }
    return try elements.map { element in
      var id: UInt32?
      if let function = AXWindowID.function {
        try prepare(element)
        var value: CGWindowID = 0
        if function(element, &value) == .success, value != 0 { id = value }
      }
      var position = CGPoint.zero
      var size = CGSize.zero
      var bounds: CGRect?
      if id == nil,
        let point = try attribute(element, kAXPositionAttribute),
        CFGetTypeID(point) == AXValueGetTypeID(),
        let dimensions = try attribute(element, kAXSizeAttribute),
        CFGetTypeID(dimensions) == AXValueGetTypeID(),
        AXValueGetValue(point as! AXValue, .cgPoint, &position),
        AXValueGetValue(dimensions as! AXValue, .cgSize, &size)
      {
        bounds = CGRect(origin: position, size: size)
      }
      let title = id == nil ? try attribute(element, kAXTitleAttribute) as? String : nil
      return AXWindow(
        identity: .init(id: id, bounds: bounds, title: title),
        node: SystemAXNode(element: element, source: self))
    }
  }
  func enableManualAccessibility() throws {
    try set("AXManualAccessibility", value: true, restoring: false, optional: true)
  }
  func enhancedAccessibility() throws -> Bool? {
    try attribute(app, "AXEnhancedUserInterface") as? Bool
  }
  func setEnhancedAccessibility(_ value: Bool, restoring: Bool) throws {
    try set("AXEnhancedUserInterface", value: value, restoring: restoring, optional: false)
  }
  private func set(_ name: String, value: Bool, restoring: Bool, optional: Bool) throws {
    try prepare(app, restoring: restoring)
    let error = AXUIElementSetAttributeValue(
      app, name as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
    if optional && (error == .attributeUnsupported || error == .notImplemented) { return }
    guard error == .success else { throw AXReadFailure.unavailable }
  }
}

private struct SystemAXNode: AXNode {
  let element: AXUIElement
  let source: SystemAXSource
  var identity: AnyHashable { AnyHashable(AXElementIdentity(element: element)) }
  func text() throws -> AXNodeText {
    try AXNodeText.read { try source.attribute(element, $0) as? String }
  }
  func children(offset: Int, limit: Int) throws -> [any AXNode] {
    try source.elements(element, attribute: kAXChildrenAttribute, offset: offset, limit: limit)
      .map { SystemAXNode(element: $0, source: source) }
  }
}
