// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SageMac",
    platforms: [.macOS("15.0")],
    products: [.executable(name: "Sage", targets: ["Sage"]), .executable(name: "SageChecks", targets: ["SageChecks"])],
    targets: [
        .target(name: "SageCore"),
        .target(name: "SageAppShot", dependencies: ["SageCore"]),
        .executableTarget(name: "Sage", dependencies: ["SageCore", "SageAppShot"]),
        .executableTarget(name: "SageChecks", dependencies: ["SageCore", "SageAppShot"]),
    ]
)
