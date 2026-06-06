# ForgeAgent macOS

ForgeAgent macOS is the desktop body for ForgeAgent.

It is not a rewritten chat client. The app starts or reuses the local Forge Core
service, keeps it alive through LaunchAgent, and displays the same Web Console
inside WKWebView.

## Build

```sh
npm run macos:build
npm run macos:package
open apps/macos/ForgeAgentMac/dist/ForgeAgent.app
```

The packaged app bundles:

- ForgeAgent Core source/runtime files
- `web/dist`
- `node_modules`
- a local Node binary

## Runtime

On launch, the app checks `http://127.0.0.1:3000/health`.

If Core is not running, it installs and starts `com.forgeagent.gateway` as a
LaunchAgent using:

- data directory: `~/Library/Application Support/ForgeAgent/data`
- host: `0.0.0.0`
- port: `3000`
- idle sleep prevention: bundled `ForgeAgentPowerHelper`

The app window can close while Core keeps running in the background. The helper
uses a native macOS idle-system-sleep assertion, so the display may sleep while
Core remains online for remote devices. Real system sleep, lid-close sleep,
network loss, or power loss will still interrupt remote Android operation.

## User Flow

1. Open `ForgeAgent.app`.
2. Configure DeepSeek in the Web Console if needed.
3. Use the same console experience as the browser version.
4. Use **Remote Access** from the app menu, or **Pair Mobile** from the Web Console rail, to connect a phone.
