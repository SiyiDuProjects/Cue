import Foundation

public struct AXWindow {
  public let identity: WindowMatch.Candidate
  public let node: any AXNode
  public init(identity: WindowMatch.Candidate, node: any AXNode) {
    self.identity = identity
    self.node = node
  }
}

/// The system adapter owns IPC and applies the shared budget to each receiving element.
public protocol AXWindowSource {
  func windows() throws -> [AXWindow]
  func enableManualAccessibility() throws
  func enhancedAccessibility() throws -> Bool?
  func setEnhancedAccessibility(_ value: Bool, restoring: Bool) throws
}

public enum AXWindowReader {
  public static func read(
    target: WindowIdentity, app: String, chromium: Bool,
    source: any AXWindowSource, budget: AXReadBudget,
    sleep: (TimeInterval) -> Void = Thread.sleep
  ) throws -> WindowTextResult {
    var best = WindowTextResult(status: "unavailable", detail: "窗口身份无法唯一确认，已保留原图。")
    var restore: Bool?
    defer {
      // Cancellation/deadline stop new reads, but never skip bounded cleanup.
      if let restore { try? source.setEnhancedAccessibility(restore, restoring: true) }
    }
    func attempt() throws -> Bool {
      _ = try budget.timeout()
      let windows = try source.windows()
      guard let match = WindowMatch.select(target, candidates: windows.map(\.identity)) else {
        // A changed/ambiguous identity invalidates earlier text as well.
        best = WindowTextResult(status: "unavailable", detail: "窗口身份无法唯一确认，已保留原图。")
        return true
      }
      var snapshot = try AXTextBuilder.read(
        root: windows[match.index].node, app: app, title: target.title, budget: budget)
      snapshot.result.basis = match.basis
      if !snapshot.result.text.isEmpty || best.text.isEmpty { best = snapshot.result }
      return snapshot.hasWebContent
    }
    do {
      if chromium { try source.enableManualAccessibility() }
      var webContent = try attempt()
      if chromium && !webContent {
        try budget.wait(0.35, sleep: sleep)
        webContent = try attempt()
        if !webContent, let old = try source.enhancedAccessibility(), !old {
          // Restore even when a failed setter may have reached the remote app.
          restore = old
          try source.setEnhancedAccessibility(true, restoring: false)
          try budget.wait(0.15, sleep: sleep)
          webContent = try attempt()
        }
        if !webContent {
          best.status = best.text.isEmpty ? "unavailable" : "partial"
          best.detail = "网页内容未完整提供辅助功能文字，已保留原图。"
        }
      }
    } catch is CancellationError { throw CancellationError() } catch {
      best.status = best.text.isEmpty ? "unavailable" : "partial"
      best.detail = (error as? AXReadFailure)?.detail ?? AXReadFailure.unavailable.detail
    }
    try budget.checkCancellation()
    return best
  }
}
