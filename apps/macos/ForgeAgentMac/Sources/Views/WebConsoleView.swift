import SwiftUI
import WebKit

struct WebConsoleView: NSViewRepresentable {
    let url: URL
    let reloadNonce: UUID

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(context.coordinator, name: "forgeNative")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        context.coordinator.attach(view, baseURL: url)
        loadConsole(view, url: url)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.attach(view, baseURL: url)
        if context.coordinator.lastReloadNonce != reloadNonce {
            context.coordinator.lastReloadNonce = reloadNonce
            loadConsole(view, url: url)
        }
    }

    private func loadConsole(_ view: WKWebView, url: URL) {
        let cacheTypes: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
        ]
        view.configuration.websiteDataStore.removeData(
            ofTypes: cacheTypes,
            modifiedSince: Date(timeIntervalSince1970: 0)
        ) {
            DispatchQueue.main.async {
                view.load(consoleRequest(for: url))
            }
        }
    }

    private func consoleRequest(for url: URL) -> URLRequest {
        URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var lastReloadNonce = UUID()
        private weak var webView: WKWebView?
        private var baseURL: URL?
        private var observing = false

        func attach(_ view: WKWebView, baseURL: URL) {
            webView = view
            self.baseURL = baseURL
            if !observing {
                observing = true
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(selectSession(_:)),
                    name: .forgeSelectSession,
                    object: nil
                )
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(openRemoteAccess),
                    name: .forgeOpenRemoteAccess,
                    object: nil
                )
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(openSettings),
                    name: .forgeOpenSettings,
                    object: nil
                )
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(openExtensions),
                    name: .forgeOpenExtensions,
                    object: nil
                )
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(handleNativeCommand(_:)),
                    name: .forgeNativeCommand,
                    object: nil
                )
            }
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                if shouldOpenInsideDeepSeekForge(url) || url.scheme == "blob" {
                    webView.load(URLRequest(url: url))
                    return nil
                }
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        @MainActor
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @Sendable () -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "DeepSeek-Forge"
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            present(alert, for: webView) { _ in
                completionHandler()
            }
        }

        @MainActor
        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @Sendable (Bool) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "DeepSeek-Forge"
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            present(alert, for: webView) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        }

        @MainActor
        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable (String?) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "DeepSeek-Forge"
            alert.informativeText = prompt
            let field = NSTextField(string: defaultText ?? "")
            field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
            alert.accessoryView = field
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            present(alert, for: webView) { response in
                completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
            }
        }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseFiles = true
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.canCreateDirectories = false
            panel.begin { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
        }

        @available(macOS 12.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
        ) {
            decisionHandler(type == .microphone ? .grant : .prompt)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard
                message.name == "forgeNative",
                let body = message.body as? [String: Any],
                let id = body["id"] as? String,
                let kind = body["kind"] as? String
            else { return }

            switch kind {
            case "pickWorkspaceFolder":
                pickWorkspaceFolder(id: id, canCreate: false)
            case "createWorkspaceFolder":
                pickWorkspaceFolder(id: id, canCreate: true)
            default:
                sendNativeResponse(id: id, path: nil)
            }
        }

        @objc private func selectSession(_ notification: Notification) {
            guard let sessionId = notification.userInfo?["sessionId"] as? String else { return }
            openSession(sessionId)
        }

        @objc private func openRemoteAccess() {
            openRail("android")
        }

        @objc private func openSettings() {
            sendConsoleCommand("openSettings", fallbackQueryItems: [
                URLQueryItem(name: "settings", value: "1"),
            ])
        }

        @objc private func openExtensions() {
            sendConsoleCommand("openExtensions", fallbackQueryItems: [
                URLQueryItem(name: "view", value: "extensions"),
            ])
        }

        @objc private func handleNativeCommand(_ notification: Notification) {
            guard let action = notification.userInfo?["action"] as? String else { return }
            sendConsoleCommand(action, fallbackQueryItems: [])
        }

        private func openSession(_ sessionId: String) {
            guard
                let webView,
                let baseURL,
                var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
            else { return }
            components.queryItems = [URLQueryItem(name: "selectSessionId", value: sessionId)]
            guard let url = components.url else { return }
            webView.load(URLRequest(url: url))
        }

        private func openRail(_ panel: String) {
            guard
                let webView,
                let baseURL,
                var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
            else { return }
            components.queryItems = [URLQueryItem(name: "rail", value: panel)]
            guard let url = components.url else { return }
            webView.load(URLRequest(url: url))
        }

        private func openConsole(with queryItems: [URLQueryItem]) {
            guard
                let webView,
                let baseURL,
                var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
            else { return }
            components.queryItems = queryItems
            guard let url = components.url else { return }
            webView.load(URLRequest(url: url))
        }

        private func sendConsoleCommand(_ action: String, fallbackQueryItems: [URLQueryItem]) {
            guard let webView else { return }
            let payload: [String: Any] = ["action": action]
            guard
                let data = try? JSONSerialization.data(withJSONObject: payload),
                let json = String(data: data, encoding: .utf8)
            else { return }
            let script = "window.dispatchEvent(new CustomEvent('forge-native-command', { detail: \(json) }));"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                guard error != nil, !fallbackQueryItems.isEmpty else { return }
                self?.openConsole(with: fallbackQueryItems)
            }
        }

        private func shouldOpenInsideDeepSeekForge(_ url: URL) -> Bool {
            guard let baseURL else { return false }
            return url.scheme == baseURL.scheme &&
                url.host == baseURL.host &&
                url.port == baseURL.port &&
                url.path == "/html-preview"
        }

        private func pickWorkspaceFolder(id: String, canCreate: Bool) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = canCreate
            panel.allowsMultipleSelection = false
            panel.prompt = canCreate ? "Create or Choose" : "Choose"
            panel.message = canCreate
                ? "Create or choose a folder for this DeepSeek-Forge project."
                : "Choose a folder for this DeepSeek-Forge project."
            panel.begin { [weak self] response in
                self?.sendNativeResponse(id: id, path: response == .OK ? panel.url?.path : nil)
            }
        }

        private func sendNativeResponse(id: String, path: String?) {
            guard let webView else { return }
            let payload: [String: Any?] = [
                "id": id,
                "path": path,
            ]
            guard
                let data = try? JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 }),
                let json = String(data: data, encoding: .utf8)
            else { return }
            let script = "window.dispatchEvent(new CustomEvent('forge-native-response', { detail: \(json) }));"
            webView.evaluateJavaScript(script)
        }

        private func present(_ alert: NSAlert, for webView: WKWebView, completion: @escaping (NSApplication.ModalResponse) -> Void) {
            if let window = webView.window ?? NSApp.keyWindow {
                alert.beginSheetModal(for: window) { response in
                    completion(response)
                }
            } else {
                completion(alert.runModal())
            }
        }
    }
}
