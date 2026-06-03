import AppKit
import Foundation
import UserNotifications

@MainActor
final class NativeNotificationController: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    private let tokenKey = "ForgeAgentNativeDeviceToken"
    private let lastNotifiedSeqKey = "ForgeAgentNativeLastNotifiedSeq"
    private let lastEventSeqKey = "ForgeAgentNativeLastEventSeq"
    private var listenTask: Task<Void, Never>?

    func start(consoleURL: URL) async {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        listenTask?.cancel()
        listenTask = Task { [weak self] in
            await self?.listenLoop(consoleURL: consoleURL)
        }
    }

    func stop() {
        listenTask?.cancel()
        listenTask = nil
    }

    private func listenLoop(consoleURL: URL) async {
        var backoff: UInt64 = 1_000_000_000
        while !Task.isCancelled {
            do {
                guard let token = try await ensureDeviceToken(consoleURL: consoleURL) else {
                    try await Task.sleep(nanoseconds: backoff)
                    continue
                }
                try await listenOnce(consoleURL: consoleURL, token: token)
                backoff = 1_000_000_000
            } catch {
                backoff = min(30_000_000_000, max(1_000_000_000, backoff * 2))
                try? await Task.sleep(nanoseconds: backoff)
            }
        }
    }

    private func listenOnce(consoleURL: URL, token: String) async throws {
        let defaults = UserDefaults.standard
        let cursor = max(defaults.integer(forKey: lastEventSeqKey), defaults.integer(forKey: lastNotifiedSeqKey))
        var components = URLComponents(url: consoleURL.appendingPathComponent("events"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 {
            defaults.removeObject(forKey: tokenKey)
            throw NSError(domain: "ForgeAgentMac", code: 401)
        }
        guard (200..<300).contains(status) else {
            throw NSError(domain: "ForgeAgentMac", code: status)
        }

        var eventType = ""
        var data = ""
        for try await line in bytes.lines {
            if Task.isCancelled { return }
            if line.isEmpty {
                handleSseEvent(eventType: eventType, data: data)
                eventType = ""
                data = ""
            } else if line.hasPrefix("event:") {
                eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                if !data.isEmpty { data.append("\n") }
                data.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }
    }

    private func handleSseEvent(eventType: String, data: String) {
        guard eventType == "session_event", !data.isEmpty else { return }
        guard
            let raw = data.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
            let sessionId = object["sessionId"] as? String,
            let event = object["event"] as? [String: Any],
            let seq = event["seq"] as? Int
        else { return }

        let defaults = UserDefaults.standard
        defaults.set(max(seq, defaults.integer(forKey: lastEventSeqKey)), forKey: lastEventSeqKey)
        guard seq > defaults.integer(forKey: lastNotifiedSeqKey) else { return }
        guard let payload = notificationPayload(event: event) else { return }

        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.sound = .default
        content.userInfo = ["sessionId": sessionId]
        let request = UNNotificationRequest(
            identifier: "forgeagent.\(sessionId).\(seq)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
        defaults.set(max(seq, defaults.integer(forKey: lastNotifiedSeqKey)), forKey: lastNotifiedSeqKey)
    }

    private func notificationPayload(event: [String: Any]) -> (title: String, body: String)? {
        let type = event["type"] as? String ?? ""
        switch type {
        case "permission_request":
            return ("ForgeAgent needs approval", truncate(event["message"] as? String ?? "A tool needs approval."))
        case "mcp_elicitation_request":
            return ("ForgeAgent needs input", truncate(event["message"] as? String ?? "A connected MCP server needs input."))
        case "assistant_message":
            return ("ForgeAgent replied", truncate(stripMarkup(event["text"] as? String ?? "Open ForgeAgent to read the reply.")))
        case "runtime_event":
            let detail = (event["detail"] as? String ?? "").lowercased()
            let message = (event["message"] as? String ?? "").lowercased()
            guard detail.contains("blocked") || message.hasPrefix("session blocked") else { return nil }
            return ("Session blocked", truncate(event["message"] as? String ?? "Open ForgeAgent to review the blocked session."))
        default:
            return nil
        }
    }

    private func ensureDeviceToken(consoleURL: URL) async throws -> String? {
        let defaults = UserDefaults.standard
        if let token = defaults.string(forKey: tokenKey), !token.isEmpty {
            return token
        }

        var codeRequest = URLRequest(url: consoleURL.appendingPathComponent("auth/pairing-codes"))
        codeRequest.httpMethod = "POST"
        codeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        codeRequest.httpBody = try JSONSerialization.data(withJSONObject: ["baseUrl": consoleURL.absoluteString])
        let (codeData, codeResponse) = try await URLSession.shared.data(for: codeRequest)
        guard (codeResponse as? HTTPURLResponse)?.statusCode == 201,
              let codeJson = try JSONSerialization.jsonObject(with: codeData) as? [String: Any],
              let code = codeJson["code"] as? String
        else { return nil }

        var pairRequest = URLRequest(url: consoleURL.appendingPathComponent("auth/pair"))
        pairRequest.httpMethod = "POST"
        pairRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        pairRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "name": "ForgeAgent macOS",
            "kind": "desktop",
        ])
        let (pairData, pairResponse) = try await URLSession.shared.data(for: pairRequest)
        guard (pairResponse as? HTTPURLResponse)?.statusCode == 201,
              let pairJson = try JSONSerialization.jsonObject(with: pairData) as? [String: Any],
              let token = pairJson["token"] as? String
        else { return nil }
        defaults.set(token, forKey: tokenKey)
        return token
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let sessionId = response.notification.request.content.userInfo["sessionId"] as? String else { return }
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            NotificationCenter.default.post(
                name: .forgeSelectSession,
                object: nil,
                userInfo: ["sessionId": sessionId]
            )
        }
    }

    private func stripMarkup(_ value: String) -> String {
        value
            .replacingOccurrences(of: #"```[\s\S]*?```"#, with: " code block ", options: .regularExpression)
            .replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"[#*_`~>\[\]()]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func truncate(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count > 180 else { return clean }
        return "\(clean.prefix(179))…"
    }
}
