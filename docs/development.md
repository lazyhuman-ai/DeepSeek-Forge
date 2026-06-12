# ForgeAgent Development Notes

This document keeps developer-facing information out of the user README.

## Repository Layout

```text
src/                    Forge Core, gateways, tools, memory, skills, MCP
web/                    React + Vite Web Console
apps/macos/             macOS WKWebView shell and Core service controller
apps/android/           Android WebView device client
tests/                  Vitest unit and integration tests
e2e/                    Playwright Web Console tests
scripts/                release gates, soak tests, build helpers
docs/                   architecture notes and historical research
```

Local runtime data is intentionally ignored by Git:

```text
.env
.forge/
.forge-*/
node_modules/
dist/
build/
.build/
.gradle/
test-results/
playwright-report/
apps/*/**/build/
apps/macos/ForgeAgentMac/dist/
```

The local `claude-code/` reference snapshot is also ignored. It was used for implementation research and is not part of the ForgeAgent release source.

## Core Development Commands

```sh
npm install
npm run typecheck
npm test
npm run product:build
npm run ui:e2e
npm run check
```

`npm run check` currently runs:

```sh
npm run typecheck
npm run product:build
npm test
npm run ui:e2e
```

## Product Entrypoints

Local Web Console:

```sh
npm run install:local
npm run status
npm run doctor
npm run logs
```

macOS:

```sh
npm run macos:build
npm run macos:package
open apps/macos/ForgeAgentMac/dist/DeepSeek-Forge.app
```

Android:

```sh
npm run android:build
npm run android:lint
npm run android:install
```

ForgeWebridge:

```sh
npm run webridge:package
npm run webridge:open
```

MCP:

```sh
npm run mcp -- list
npm run mcp -- add
npm run mcp -- status
npm run mcp -- doctor
```

Skills:

```sh
npm run skills -- list
npm run skills -- doctor
```

## Release Gate

The public release gate is:

```sh
npm run release:gate
```

It runs the normal check pipeline, macOS app packaging smoke checks, Android app builds plus Android connection unit tests, extension E2E, and release E2E:
`npm run check`, `npm run native:build`, `npm run extensions:e2e`, and `npm run release:e2e`.
The release E2E step exercises real product flows and writes reports under `.forge-release-e2e/`.

After the gate passes, package local beta artifacts with:

```sh
npm run release:bundle
```

The artifacts and checksums are written under `.forge-release/dist/`.
Use `docs/release-checklist.md` as the release operator checklist.

Use isolated data directories for manual soak tests whenever possible so user runtime data is not polluted.

## Design Baseline

The current implementation baseline is:

- `docs/forge_agent_v_2_architecture_spec.md`
- `docs/develop.md`
- source code behavior

Historical research archives are useful for context but are not implementation specifications.

Key invariants:

- Session thread is the durable fact source.
- `running` means queued or active.
- Ordinary tool errors return as `tool_result isError: true` and stay visible to Agent.
- `blocked` is reserved for Core, Provider, Runtime, protocol, compaction, artifact, or other framework-level failures where the loop cannot safely continue.
- Web Console is the only UI fact source; native clients should not duplicate chat state.
- Project/workspace is a security boundary, not only UI grouping.

## Git Hygiene

Before committing:

```sh
git status --short
npm run check
```

Do not commit:

- provider keys or `.env`
- `.forge/` runtime state
- generated soak/e2e output
- `node_modules/`
- packaged `.app` bundles or APK build output
- local reference snapshots such as `claude-code/`
