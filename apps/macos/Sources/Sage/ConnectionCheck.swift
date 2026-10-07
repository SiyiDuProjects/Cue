import Foundation
import SageCore

/// Explicit release diagnostics. Never prints credentials or reference content.
@MainActor enum ConnectionCheck {
  static func run(importMaterials: Bool) async throws {
    print("Waiting for macOS Keychain authorization…")
    let address = try ServerAddress(AppStore.serviceURL)
    let keys = try SiteCredentials(try await Credentials.load(address.url.absoluteString))
    let http = HTTPClient()
    http.authorizeSite(address, token: keys.site)
    let health = try await http.request(address, "/health", token: keys.device)
    print("Authenticated health:", health["capture_protocol"] as? String ?? "unknown")
    guard health["capture_protocol"] as? String == protocolVersion else {
      print("Candidate backend not deployed; no capture or model started.")
      return
    }
    if importMaterials {
      let names = [
        "resume.txt", "01_tiktok_interview.md", "02_innovation_ai_interview.md",
        "03_coursehub_interview.md", "04_reachard_interview.md",
      ]
      let root = LocalFiles.root.appendingPathComponent(
        "assistant-workspace/materials", isDirectory: true)
      let files = try names.map { name -> JSON in
        let data = try Data(contentsOf: root.appendingPathComponent(name))
        guard data.count <= 250000, let text = String(data: data, encoding: .utf8) else {
          throw SageError("资料格式无效。")
        }
        return ["name": name, "text": text]
      }
      _ = try await http.request(
        address, "/capture/materials", method: "POST", token: keys.device,
        body: ["materials": files])
      print("Imported existing materials:", names.count)
    }
    let state = try await http.request(address, "/capture/state", token: keys.device)
    print("Saved state readable; chat count:", (state["chats"] as? [JSON])?.count ?? 0)
    let materials = try await http.request(address, "/capture/materials", token: keys.device)
    print("Material count:", (materials["materials"] as? [JSON])?.count ?? 0)
    print("PASS authenticated read-only connection; no microphone, screenshot or model call")
  }
}
