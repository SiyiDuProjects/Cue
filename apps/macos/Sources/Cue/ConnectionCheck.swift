import Foundation
import CueCore

/// Explicit release diagnostics. Never prints credentials or reference content.
@MainActor enum ConnectionCheck {
  static func run() async throws {
    print("Waiting for macOS Keychain authorization…")
    let address = try ServerAddress(AppStore.serviceURL)
    let keys = try SiteCredentials(try await Credentials.load())
    let http = HTTPClient()
    http.authorizeSite(address, token: keys.site)
    let health = try await http.request(address, "/health", token: keys.device)
    print("Authenticated health:", health["capture_protocol"] as? String ?? "unknown")
    guard health["capture_protocol"] as? String == protocolVersion else {
      print("Candidate backend not deployed; no capture or model started.")
      return
    }
    let state = try await http.request(address, "/capture/state", token: keys.device)
    print("Saved state readable; chat count:", (state["chats"] as? [JSON])?.count ?? 0)
    print("PASS authenticated read-only connection; no microphone, screenshot or model call")
  }
}
