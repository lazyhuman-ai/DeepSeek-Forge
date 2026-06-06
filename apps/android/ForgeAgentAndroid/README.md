# ForgeAgent Android

ForgeAgent Android is a paired remote WebView device for ForgeAgent running on
a Mac. It does not maintain a second native chat UI. After pairing, it loads the
same Web Console as desktop, so Android keeps the same rich text, HTML previews,
uploads, branches, permissions, danger mode, usage, MCP, skills, memory, and
Webridge status.

## Product Flow

1. Start ForgeAgent on the Mac with the macOS app or local Web Console.
2. Open **Pair Mobile** on the Mac.
3. Open the Android app and tap **Scan Pair Mobile QR**.
4. After pairing, the app opens the full ForgeAgent Web Console.

Manual gateway URL + pairing-code entry remains available as a fallback for
users who cannot scan the QR code.

## Background Status

After pairing, Android starts a foreground service with a persistent
notification. The service polls the Mac's `/health` endpoint and shows whether
the phone can still reach ForgeAgent. Tapping the notification returns to the
Web Console. The service restarts after device boot or app update if the device
is still paired.

The same service also listens to ForgeAgent's authenticated event stream and
shows activity notifications for assistant replies, permission requests, MCP
elicitation requests, and blocked sessions. Activity notifications are
deduplicated with a local `lastNotifiedSeq`; tapping one opens the Web Console
for the relevant session.

This background service does not run a ForgeAgent Core on Android. The Core
remains on the Mac; Android is a device client.

## Build

The project vendors a Gradle wrapper. A JDK 17 and Android SDK are still
required.

```sh
npm run android:build
npm run android:lint
```

The debug APK is written to:

```text
apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk
```

To install on an attached device or emulator:

```sh
npm run android:install
```
