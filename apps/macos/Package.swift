// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CueMac",
    platforms: [.macOS("15.0")],
    products: [.executable(name: "Cue", targets: ["Cue"]), .executable(name: "CueChecks", targets: ["CueChecks"])],
    targets: [
        .target(name: "CueCore"),
        .executableTarget(name: "Cue", dependencies: ["CueCore"]),
        .executableTarget(name: "CueChecks", dependencies: ["CueCore"]),
    ]
)
