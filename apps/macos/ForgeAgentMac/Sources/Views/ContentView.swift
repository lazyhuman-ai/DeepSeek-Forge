import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var service: CoreServiceController
    @EnvironmentObject private var notifications: NativeNotificationController
    @State private var showPairAndroid = false

    var body: some View {
        ZStack {
            switch service.status {
            case .ready:
                WebConsoleView(url: service.consoleURL, reloadNonce: service.reloadNonce)
                    .ignoresSafeArea()
            case .starting:
                LaunchStateView(title: "Starting ForgeAgent", message: "Preparing the local Core service…", progress: true)
            case .restarting:
                LaunchStateView(title: "Restarting ForgeAgent", message: "Core is restarting. The console will reload automatically.", progress: true)
            case .degraded(let message):
                LaunchStateView(title: "ForgeAgent needs attention", message: message, progress: false)
            }
        }
        .sheet(isPresented: $showPairAndroid) {
            PairAndroidSheet()
                .environmentObject(service)
                .frame(width: 520, height: 360)
        }
        .onReceive(NotificationCenter.default.publisher(for: .forgeShowPairAndroid)) { _ in
            showPairAndroid = true
            Task { await service.createAndroidPairingLink() }
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
            Text("ForgeAgent")
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

struct PairAndroidSheet: View {
    @EnvironmentObject private var service: CoreServiceController

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pair Android")
                .font(.title2)
            Text("Use the Android app to open this link. For QR code pairing, open the Android panel in the Web Console.")
                .foregroundStyle(.secondary)
            if let link = service.pairingLink {
                LabeledContent("Gateway", value: link.baseUrl)
                TextEditor(text: .constant(link.pairingUrl))
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 92)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                Text("Expires \(link.expiresAt.formatted(date: .omitted, time: .shortened))")
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Copy Link") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link.pairingUrl, forType: .string)
                    }
                    Button("Refresh") {
                        Task { await service.createAndroidPairingLink() }
                    }
                    Button("Open Web Console") {
                        service.openConsoleInBrowser()
                    }
                }
            } else {
                ProgressView("Creating pairing link…")
            }
        }
        .padding(24)
    }
}

extension Notification.Name {
    static let forgeShowPairAndroid = Notification.Name("forgeShowPairAndroid")
    static let forgeSelectSession = Notification.Name("forgeSelectSession")
}
