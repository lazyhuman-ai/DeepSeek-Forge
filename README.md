# ForgeAgent

<p align="center">
  <img src="assets/forge-agent-img.png" alt="ForgeAgent local agent workspace" width="100%" />
</p>

<p align="center">
  <strong>A local-first agent workspace for DeepSeek, MCP, Chrome, and multi-device work.</strong>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
</p>

ForgeAgent runs an agent core on your Mac and gives it a real workspace: project files, tools, browser access, MCP servers, long-context memory, and a durable conversation thread. The interface is a local Web Console, shared by the browser, the macOS app, iPhone/iPad Safari, and the Android app.

It is built for people who want a Codex/Claude Code style local agent, but with first-class DeepSeek telemetry and a private, device-friendly workflow.

> **Original project**
> ForgeAgent is an original local-first agent workspace developed by the ForgeAgent contributors. It is released under the MIT License, so forks, modifications, and commercial use are welcome. If you build on ForgeAgent or present it publicly, attribution is appreciated: please mention ForgeAgent clearly where practical.

## Why ForgeAgent

- **Your Mac is the runtime.** Sessions, files, tool results, artifacts, credentials, and device state stay on your machine.
- **Projects are folders.** Each project maps to a workspace directory. File tools and sandbox rules are scoped around that folder.
- **The thread is durable.** Tool calls, errors, permissions, browser events, usage, artifacts, and final answers are written back to the session.
- **Errors are readable.** Permission denials, sandbox blocks, runtime failures, and tool errors are returned as text the agent can read and recover from.
- **DeepSeek is not treated as a generic endpoint.** ForgeAgent reads real usage, context, cache, and reasoning-token telemetry when DeepSeek provides it.

## What You Get

- Local Web Console with Markdown, code blocks, safe HTML previews, file upload, session branching, and inline permission approval.
- macOS app that starts or reuses the local Forge Core, keeps it alive with LaunchAgent, and uses a native power helper so the display may sleep while Core stays online.
- iPhone/iPad support through Safari/PWA.
- Android app with QR pairing, multiple saved Mac connections, background connection monitoring, and notifications.
- DeepSeek-native token usage, context usage, prefix cache hit/miss, reasoning token, and cost ledger.
- Workspace sandbox, session-level Danger Free mode, and reduced approval prompts for normal workspace tasks.
- Chrome browser access through ForgeWebridge, using the Chrome profile you are already logged into.
- MCP client support for stdio, streamable HTTP, and legacy SSE servers.
- Local-first extension system for skills, MCP servers, and bundles.
- Artifact storage for large tool output, with readable previews in the message thread.
- Long-term memory, skills, scheduler, runtime recovery, and process restart rehydration.

## Quick Start

### Requirements

- macOS for the main desktop runtime.
- Node.js 20+.
- A DeepSeek API key, or another configured provider.

Install dependencies and start the local product:

```sh
npm install
npm run product:build
npm run install:local
```

`install:local` builds the Web Console, installs the local LaunchAgent, starts Forge Core, and opens:

```text
http://127.0.0.1:3000
```

Configure your provider from the setup screen. For DeepSeek, the default base URL is:

```text
https://api.deepseek.com
```

`.env` is still supported for development, but the Web Console setup screen is the recommended path for normal use.

## macOS App

Build and open the desktop app from source:

```sh
npm run macos:build
npm run macos:package
open apps/macos/ForgeAgentMac/dist/ForgeAgent.app
```

The macOS app is not a separate chat client. It is the desktop shell for the same Forge Core and Web Console:

- starts or reuses the local Core service;
- installs `com.forgeagent.gateway` as a LaunchAgent;
- listens on `0.0.0.0:3000` for private-network devices;
- stores data in `~/Library/Application Support/ForgeAgent/data`;
- keeps Core online with `ForgeAgentPowerHelper`, a native macOS idle-system-sleep assertion helper.

The display can sleep. Core should continue running. Real system sleep, lid-close sleep, network loss, or power loss will still interrupt remote access.

## Mobile Access

ForgeAgent is local-first. Your phone connects to the Mac that is running Forge Core.

For away-from-home access, the easiest free path is [Tailscale](https://tailscale.com/): install it on the Mac and phone, sign in to the same tailnet, then pair the phone from ForgeAgent.

### iPhone / iPad

iOS uses Safari or an installed PWA.

1. Open **Pair Mobile** in the right rail of the Web Console.
2. Choose **iPhone**.
3. Scan the QR code with the camera.
4. Safari opens the ForgeAgent Web Console and completes pairing.
5. Optional: use **Add to Home Screen** for an app-like launcher.

If Tailscale is available, ForgeAgent uses the Tailscale URL in the QR code. Otherwise it falls back to the LAN URL and clearly marks it as local-only.

### Android

Build the Android APK:

```sh
npm run android:build
```

The debug APK is written to:

```text
apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk
```

Android pairing flow:

1. Open **Pair Mobile** on the Mac.
2. Choose **Android**.
3. Open the ForgeAgent Android app and scan the QR code.
4. Android saves the Mac identity, LAN URLs, Tailscale URLs, custom remote URLs, and device token.
5. The app loads the same Web Console as desktop.

The Android app keeps a foreground connection service for connectivity and activity notifications. It does not run Forge Core.

## Chrome Browser Access

ForgeAgent uses a Chrome extension called ForgeWebridge for browser tasks. It connects the agent to your existing Chrome profile, including visible logged-in sessions.

Package and open the extension folder:

```sh
npm run webridge:package
npm run webridge:open
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the ForgeWebridge extension folder.
5. If it is already installed, click **Reload** or **Refresh connection**.

ForgeWebridge auto-discovers the local ForgeAgent gateway and keeps a heartbeat. If it is offline, browser tools return a readable error to the agent instead of hanging.

## MCP

ForgeAgent is an MCP client. MCP tools are projected into the same tool runtime, permission broker, sandbox, artifact store, and thread model as built-in tools.

Common commands:

```sh
npm run mcp -- list
npm run mcp -- add
npm run mcp -- status
npm run mcp -- doctor
```

For a real end-to-end example, see:

- [ForgeAgent + Blender MCP Quick Start](docs/blender-mcp-quickstart.md)

Project `.mcp.json` files are discovered but not blindly trusted. Enable them from the UI or CLI after reviewing the transport, command, URL, environment variables, and authentication needs.

If a server is not in the built-in catalog, install it from the **Extensions** page or register it explicitly:

```sh
DATA_DIR="$HOME/Library/Application Support/ForgeAgent/data"

npm run mcp -- add \
  --data-dir "$DATA_DIR" \
  --name my-server \
  --transport stdio \
  --command npx \
  --args "-y,@example/mcp-server,arg1,arg2" \
  --env '{"EXAMPLE_API_KEY":"your-key"}' \
  --trust untrusted \
  --enabled
```

For HTTP or SSE servers, use:

```sh
npm run mcp -- add \
  --transport streamable-http \
  --url https://example.com/mcp \
  --headers '{"Authorization":"Bearer ..."}'
```

Restart Forge Core after changing the macOS app data directory from the CLI.

## Extensions

ForgeAgent has a local-first extension system for skills, MCP servers, and bundles. The macOS app and Web Console include an **Extensions** page with:

- recommended entries from the bundled registry snapshot;
- installed extensions;
- setup-required entries;
- warning and blocked states;
- registry sources;
- install and audit events.

You can also ask the agent naturally:

```text
Install filesystem MCP.
Install this GitHub skill: https://github.com/owner/repo/tree/main/skills/my-skill
Install the code review workspace bundle and use it on this project.
Find a PDF research extension, install it, and use it on this file.
```

ForgeAgent installs GitHub skills as full packages. If `SKILL.md` lives in a directory, supporting files such as `references/`, `scripts/`, `templates/`, `assets/`, and `tests/` are installed with it. It does not reduce a skill to a raw `SKILL.md` download.

CLI examples:

```sh
npm run extensions -- status
npm run extensions -- search filesystem
npm run extensions -- install-skill-github https://github.com/owner/repo/tree/main/skills/my-skill
npm run extensions -- install-bundle code-review-workspace
npm run extensions -- install-mcp-catalog modelcontextprotocol-filesystem
npm run extensions -- enable mcp_server filesystem
npm run extensions -- doctor
```

Built-in recommendations currently include:

- MCP: Filesystem, Everything, Memory, Sequential Thinking, GitHub, Brave Search, Puppeteer, Postgres, PDF, Map, Three.js, Blender.
- Skills: Serenity Invest, Code Reviewer, Frontend Design.
- Bundles: Code Review Workspace, Design Reference, Investor Research, PDF Research.

## DeepSeek Telemetry

DeepSeek support is a first-class path in ForgeAgent:

- `prompt_tokens`, `completion_tokens`, and `total_tokens`;
- prefix cache hit/miss tokens;
- reasoning tokens;
- cost and usage records;
- real context-window percentage;
- compaction based on real provider usage when available.

When compaction happens, ForgeAgent shows a local estimate of the compressed context immediately, then replaces it with real provider telemetry after the next model call.

## Data and Security Model

ForgeAgent is designed for one user and multiple personal devices.

- Source checkout data directory: `.forge/`
- macOS app data directory: `~/Library/Application Support/ForgeAgent/data`
- API keys stay on the local machine and are masked in status/diagnostic responses.
- Business HTTP APIs require a device token.
- Pairing codes are short-lived and one-time use.
- Workspace sandboxing is scoped to the project folder and session scratch space.
- Permission denials and sandbox blocks are returned to the agent as readable `tool_result` errors.
- Danger Free is session-scoped. It reduces approvals for that session, but hard sandbox blocks still apply.

ForgeAgent is not a hosted SaaS service. Do not expose it directly to the public internet. For remote phone access, use Tailscale, ZeroTier, a trusted private network, or a carefully configured HTTPS reverse proxy.

## Useful Commands

```sh
npm run status          # local service status
npm run doctor          # diagnostics
npm run logs            # gateway logs
npm run start           # start one local background gateway
npm run stop            # stop it
npm run forgeagent -- restart
npm run check           # typecheck, product build, unit tests, UI e2e
npm run native:build    # package/smoke macOS app + Android app build + Android connection unit tests
npm run coding:e2e      # real-provider coding-agent release scenario
npm run release:gate    # full release gate: check, native build, extensions e2e, release e2e
npm run release:bundle  # build local beta artifacts under .forge-release/dist
```

For release preparation, see [docs/release-checklist.md](docs/release-checklist.md).

## Troubleshooting

### Web Console does not open

```sh
npm run status
npm run doctor
npm run logs
```

Restart the local service:

```sh
npm run forgeagent -- restart
```

### Phone cannot connect to the Mac

Check that:

- Forge Core is running on the Mac.
- The phone can reach the displayed LAN or Tailscale URL.
- The URL is not `127.0.0.1` on the phone.
- Tailscale or ZeroTier is online on both devices if you are away from home.
- The Mac is awake. Display sleep is fine; real system sleep is not.
- macOS firewall or network isolation is not blocking port `3000`.

### Agent cannot access a file

Check the current project. File tools are sandboxed around the selected project folder. Move the file into the project or create a project for the folder you want the agent to work in.

## Documentation

- [Development Guide](docs/development.md)
- [Architecture Spec](docs/forge_agent_v_2_architecture_spec.md)
- [Native Apps](docs/native-apps.md)
- [Blender MCP Quick Start](docs/blender-mcp-quickstart.md)

## License

ForgeAgent is released under the [MIT License](LICENSE). Forks, modifications, private use, and commercial use are welcome. If you build on ForgeAgent or present it publicly, attribution is appreciated.

## Project Status

ForgeAgent is an early local-first product. It is already usable for real local workflows, but the surface area is large: macOS app, Web Console, Android app, Chrome extension, MCP, skills, browser automation, memory, and runtime recovery. Expect rapid changes.

Contributions, bug reports, and real workflow reports are welcome.
