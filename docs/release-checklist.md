# ForgeAgent Release Checklist

This checklist is for preparing a local-first beta release from this repository.
It assumes the release is aimed at individual users who run ForgeAgent on their own Mac.

## 1. Start Clean

```sh
git status --short
npm install
```

Do not publish from an unknown dirty tree. If you intentionally include local
changes, commit them first and note them in the release notes.

## 2. Run the Release Gate

```sh
npm run release:gate
```

The gate currently covers:

- TypeScript and Web Console builds.
- Unit tests and Web Console Playwright E2E.
- macOS `.app` package smoke checks.
- Android APK build and Android connection unit tests.
- Extension E2E for control-page and natural-language installs.
- Real DeepSeek-backed core soak.
- Real Chrome/CDP browser soak.
- Real coding workspace E2E.
- Real external MCP E2E.
- Real ForgeWebridge extension E2E.

The release E2E report is written under:

```text
.forge-release-e2e/reports/
```

## 3. Build Local Beta Artifacts

```sh
npm run release:bundle
```

Artifacts are written to:

```text
.forge-release/dist/
```

Expected files:

- `ForgeAgent-<version>-macos-arm64.zip`
- `ForgeAgent-<version>-android-debug.apk`
- `ForgeWebridge-<version>.zip`
- `release-manifest.json`
- `SHA256SUMS`

## 4. Important Distribution Notes

ForgeAgent is currently a local-first beta distribution.

- macOS artifact is an unsigned beta `.app` zip unless you sign and notarize it yourself.
- Android artifact is a debug APK for sideload testing unless you create a signed release APK or AAB.
- ForgeWebridge is packaged for local extension loading unless you publish it through the Chrome Web Store.
- ForgeAgent does not host a cloud relay. Remote mobile access is private-network first, usually Tailscale.
- Users still need their own provider key, usually DeepSeek.

## 5. Manual Smoke Before Sharing

On a clean Mac account or a disposable test user:

1. Unzip the macOS artifact.
2. Open `ForgeAgent.app`.
3. Configure DeepSeek in the Web Console.
4. Create a session and send `Who are you?`.
5. Open **Pair Mobile** and verify the QR panel does not blank.
6. Install or refresh ForgeWebridge, then run one simple browser task.
7. Install one recommended MCP from **Extensions** and run a simple tool call.
8. If sharing Android, install the APK, scan the QR, and confirm connection recovery if Wi-Fi changes.

## 6. Rollback

If a local install becomes unhealthy:

```sh
npm run forgeagent -- stop
npm run forgeagent -- uninstall-service
```

User data is stored under the configured Forge data directory. The macOS app
defaults to:

```text
~/Library/Application Support/ForgeAgent/data
```

Do not delete user data during app uninstall unless the user explicitly asks.
