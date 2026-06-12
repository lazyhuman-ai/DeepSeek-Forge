import SwiftUI

@main
struct ForgeAgentMacApp: App {
    @StateObject private var service = CoreServiceController()
    @StateObject private var notifications = NativeNotificationController()

    var body: some Scene {
        WindowGroup("DeepSeek-Forge") {
            ContentView()
                .environmentObject(service)
                .environmentObject(notifications)
                .frame(minWidth: 920, minHeight: 640)
                .task {
                    await service.bootstrap()
                    if service.status == .ready {
                        await notifications.start(consoleURL: service.consoleURL)
                    }
                }
        }
        .windowStyle(.titleBar)
        .commands {
            CommandMenu("DeepSeek-Forge") {
                Button("Extensions") {
                    NotificationCenter.default.post(name: .forgeOpenExtensions, object: nil)
                }
                .keyboardShortcut("e", modifiers: [.command, .shift])

                Button("Settings…") {
                    NotificationCenter.default.post(name: .forgeOpenSettings, object: nil)
                }
                .keyboardShortcut(",", modifiers: [.command])

                Divider()

                Button("Open Console in Browser") {
                    service.openConsoleInBrowser()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Restart Core") {
                    Task {
                        await service.restartCore()
                        if service.status == .ready {
                            await notifications.start(consoleURL: service.consoleURL)
                        }
                    }
                }

                Button("Show Logs") {
                    service.showLogs()
                }

                Button("Remote Access") {
                    NotificationCenter.default.post(name: .forgeOpenRemoteAccess, object: nil)
                }

                Divider()

                Button("Increase Console Text Size") {
                    NotificationCenter.default.post(name: .forgeNativeCommand, object: nil, userInfo: ["action": "increaseFont"])
                }
                .keyboardShortcut("+", modifiers: [.command])

                Button("Decrease Console Text Size") {
                    NotificationCenter.default.post(name: .forgeNativeCommand, object: nil, userInfo: ["action": "decreaseFont"])
                }
                .keyboardShortcut("-", modifiers: [.command])

                Button("Toggle Console Theme") {
                    NotificationCenter.default.post(name: .forgeNativeCommand, object: nil, userInfo: ["action": "toggleTheme"])
                }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            }
        }
    }
}
