import AppKit
import ApplicationServices
import SageCore

public struct WindowTextResult: Sendable {
    public var text: String
    public var status: String
    public var detail: String
    public init(text: String = "", status: String, detail: String = "") {
        self.text = text; self.status = status; self.detail = detail
    }
}

public struct WindowIdentity: Sendable {
    public let id: UInt32
    public let pid: Int32
    public let bounds: CGRect
    public let title: String
    public init(id: UInt32, pid: Int32, bounds: CGRect, title: String) { self.id = id; self.pid = pid; self.bounds = bounds; self.title = title }
}

/// Pure selection rule: ambiguous accessibility windows must never supply another window's text.
public enum WindowMatch {
    public static func unique(bounds: CGRect, title: String, candidates: [(CGRect, String)]) -> Int? {
        let matches = candidates.indices.filter {
            let other = candidates[$0].0
            return abs(other.minX - bounds.minX) < 2 && abs(other.minY - bounds.minY) < 2 &&
                abs(other.width - bounds.width) < 2 && abs(other.height - bounds.height) < 2 &&
                candidates[$0].1 == title
        }
        return matches.count == 1 ? matches[0] : nil
    }
    /// A surviving window ID is necessary, as geometry/title alone can name a replacement window.
    public static func isCurrent(_ target: WindowIdentity, windows: [WindowIdentity]) -> Bool {
        let sameApp = windows.filter { $0.pid == target.pid }
        guard let index = unique(bounds: target.bounds, title: target.title, candidates: sameApp.map { ($0.bounds, $0.title) }) else { return false }
        return sameApp[index].id == target.id
    }

}

public enum WindowText {
    public static var authorized: Bool { AXIsProcessTrusted() }
    @MainActor public static func requestPermission() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    /// Never runs AX calls on the UI/audio thread. Each call and the traversal have bounded time.
    public static func read(pid: Int32, bounds: CGRect, title: String) async -> WindowTextResult {
        guard authorized else { return WindowTextResult(status: "permission_denied", detail: "未授权辅助功能，已保留窗口截图；可在系统设置授权后重新获取文字。") }
        return await Task.detached(priority: .userInitiated) {
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.15)
            func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
                var result: CFTypeRef?
                return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
            }
            func rectangle(_ element: AXUIElement) -> CGRect? {
                guard let position = value(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
                      let size = value(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
                var point = CGPoint.zero, extent = CGSize.zero
                guard AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &point),
                      AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &extent) else { return nil }
                return CGRect(origin: point, size: extent)
            }
            let deadline = Date().addingTimeInterval(3)
            let windows = value(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
            guard windows.count <= 128 else { return WindowTextResult(status: "unavailable", detail: "窗口过多，无法可靠匹配文字；原图保留。") }
            var candidates: [(CGRect, String)] = []
            for window in windows {
                guard Date() < deadline else { return WindowTextResult(status: "unavailable", detail: "匹配窗口文字超时；原图保留。") }
                AXUIElementSetMessagingTimeout(window, 0.15)
                candidates.append((rectangle(window) ?? .null, value(window, kAXTitleAttribute) as? String ?? ""))
            }
            guard let index = WindowMatch.unique(bounds: bounds, title: title, candidates: candidates) else {
                return WindowTextResult(status: "unavailable", detail: "无法唯一匹配所选窗口的文字，已保留截图。")
            }
            var stack: [(AXUIElement, Int)] = [(windows[index], 0)]
            var visited = Set<AXUIElement>(), lines: [String] = []
            var count = 0, characters = 0, partial = false
            while let (node, depth) = stack.popLast() {
                if Date() >= deadline || count >= 5000 || characters >= 180_000 { partial = true; break }
                if depth > 64 { partial = true; continue }
                if !visited.insert(node).inserted { continue }
                count += 1
                AXUIElementSetMessagingTimeout(node, 0.15)
                var rawRole: CFTypeRef?
                let roleStatus = AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &rawRole)
                guard !AXAttributeReadCompletenessPolicy.attributeErrorInvalidatesNode(roleStatus, attribute: kAXRoleAttribute),
                      let role = rawRole as? String, !role.isEmpty else { partial = true; continue }
                let subrole = value(node, kAXSubroleAttribute) as? String ?? ""
                if subrole == kAXSecureTextFieldSubrole || role == "AXSecureTextField" { continue }
                var nodeText: [String] = []
                for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
                    var raw: CFTypeRef?
                    let status = AXUIElementCopyAttributeValue(node, attribute as CFString, &raw)
                    if AXAttributeReadCompletenessPolicy.attributeErrorInvalidatesNode(status, attribute: attribute) { partial = true }
                    if let string = raw as? String, !string.isEmpty, !nodeText.contains(string) { nodeText.append(string) }
                }
                let line = nodeText.joined(separator: " · ")
                if !line.isEmpty {
                    if characters + line.unicodeScalars.count > 180_000 { partial = true; break }
                    lines.append(line); characters += line.unicodeScalars.count + 1
                }
                var children: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children)
                if AXAttributeReadCompletenessPolicy.isIncomplete(error: status) { partial = true }
                let descendants = children as? [AXUIElement] ?? []
                if descendants.count > 5000 { partial = true }
                for child in descendants.prefix(5000).reversed() { stack.append((child, depth + 1)) }
            }
            return WindowTextResult(text: lines.joined(separator: "\n"), status: partial ? "partial" : lines.isEmpty ? "empty" : "available",
                detail: partial ? "窗口文字读取不完整（超时、应用未响应或达到读取上限）；原图保留。" : lines.isEmpty ? "该窗口未提供可读取文字，原图保留。" : "")
        }.value
    }
}
