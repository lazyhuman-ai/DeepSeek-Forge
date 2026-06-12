import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var service: CoreServiceController
    @EnvironmentObject private var notifications: NativeNotificationController

    var body: some View {
        ZStack {
            switch service.status {
            case .ready:
                WebConsoleView(url: service.consoleURL, reloadNonce: service.reloadNonce)
                    .ignoresSafeArea()
            case .starting:
                LaunchStateView(title: "Starting DeepSeek-Forge", message: "Preparing the local Core service…", progress: true)
            case .restarting:
                LaunchStateView(title: "Restarting DeepSeek-Forge", message: "Core is restarting. The console will reload automatically.", progress: true)
            case .degraded(let message):
                LaunchStateView(title: "DeepSeek-Forge needs attention", message: message, progress: false)
            }
        }
        .onChange(of: service.status) { _, status in
            if status == .ready {
                Task { await notifications.start(consoleURL: service.consoleURL) }
            } else {
                notifications.stop()
            }
        }
    }
}

struct LaunchStateView: View {
    let title: String
    let message: String
    let progress: Bool
    @EnvironmentObject private var service: CoreServiceController

    var body: some View {
        VStack(spacing: 18) {
            Text("DeepSeek-Forge")
                .font(.system(size: 46, weight: .semibold, design: .serif))
            if progress {
                ProgressView()
                    .controlSize(.large)
            }
            Text(title)
                .font(.title3)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)
            HStack {
                Button("Restart Core") {
                    Task { await service.restartCore() }
                }
                Button("Open Logs") {
                    service.showLogs()
                }
            }
        }
        .padding(48)
    }
}

extension Notification.Name {
    static let forgeOpenRemoteAccess = Notification.Name("forgeOpenRemoteAccess")
    static let forgeOpenSettings = Notification.Name("forgeOpenSettings")
    static let forgeOpenExtensions = Notification.Name("forgeOpenExtensions")
    static let forgeSelectSession = Notification.Name("forgeSelectSession")
    static let forgeNativeCommand = Notification.Name("forgeNativeCommand")
}
