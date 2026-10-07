import CoreGraphics

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

