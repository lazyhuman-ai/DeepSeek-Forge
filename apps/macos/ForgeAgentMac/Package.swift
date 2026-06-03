// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ForgeAgentMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ForgeAgentMac", targets: ["ForgeAgentMac"])
    ],
    targets: [
        .executableTarget(
            name: "ForgeAgentMac",
            path: "Sources"
        )
    ]
)
