import SwiftUI

@main
struct ForgeAgentMacApp: App {
    @StateObject private var service = CoreServiceController()
    @StateObject private var notifications = NativeNotificationController()

    var body: some Scene {
        WindowGroup {
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
            CommandMenu("ForgeAgent") {
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
            }
        }
    }
}
