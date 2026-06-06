# ForgeAgent Native Apps

ForgeAgent native apps are product shells around the same Forge Core and Web
Console.

- macOS: `apps/macos/ForgeAgentMac`
- Android: `apps/android/ForgeAgentAndroid`

## macOS

The macOS app is the local ForgeAgent body. It starts or reuses the Core
LaunchAgent and renders the existing Web Console in WKWebView.

```sh
npm run macos:build
npm run macos:package
open apps/macos/ForgeAgentMac/dist/ForgeAgent.app
```

The app listens on `0.0.0.0:3000` for private-network device access, while all
business APIs still require device authentication. Core uses
`~/Library/Application Support/ForgeAgent/data` by default. LaunchAgent uses
`caffeinate -i` so display sleep does not stop remote operation; actual system
sleep still stops network access.

## Android

The Android app is a paired WebView client. It stores `baseUrl + device token`,
supports native QR scanning for `forgeagent://pair?...` links, injects the token
into Web Console local storage, and then loads the full Web Console after
pairing.

Use **Pair Mobile** in the macOS app or Web Console to create a QR code and
deep link. The pairing code remains one-time and short-lived. Manual gateway URL
+ pairing-code entry exists only as a fallback.

After pairing, Android starts a foreground connection monitor service with a
persistent notification. The service polls the Mac's public `/health` endpoint,
shows connected/offline state, and restarts after device boot or app update. It
also keeps an authenticated SSE connection for activity notifications:
assistant replies, permission requests, MCP elicitation requests, and blocked
sessions. Tapping an activity notification opens the Android WebView and selects
the relevant session. It does not host Core and does not duplicate session
state; it only keeps the remote device experience observable and easy to return
to.

## Notifications

ForgeAgent notification facts still come from durable thread/system events.
Native apps only consume those events:

- macOS: the app process requests notification permission and listens to Core
  SSE while the app is running. LaunchAgent/Core does not directly show OS
  notifications.
- Android: the foreground service keeps connection status visible and emits
  separate activity notifications from the same SSE stream.
- Web Console: browser notifications are opt-in from the right rail and use
  per-device `notificationSettings.lastNotifiedSeq`; this is separate from
  `sessionReadSeq`.

```sh
npm run android:build
npm run android:lint
```

Android build uses the project Gradle wrapper. It still requires JDK 17 and an
Android SDK.

## Design Rule

Do not duplicate ForgeAgent UI state in native clients. The Web Console remains
the display source for messages, rich text, HTML, permissions, files, branches,
usage, MCP, skills, memory, and Webridge. Native code should only handle app
shell concerns: startup, pairing, WebView, menus, logs, and diagnostics.
