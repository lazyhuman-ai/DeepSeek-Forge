// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ForgeAgentMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ForgeAgentMac", targets: ["ForgeAgentMac"]),
        .executable(name: "ForgeAgentPowerHelper", targets: ["ForgeAgentPowerHelper"])
    ],
    targets: [
        .executableTarget(
            name: "ForgeAgentMac",
            path: "Sources"
        ),
        .executableTarget(
            name: "ForgeAgentPowerHelper",
            path: "PowerHelper"
        )
    ]
)
