#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const appRoot = join(projectRoot, "apps/macos/ForgeAgentMac/dist/ForgeAgent.app");
const contents = join(appRoot, "Contents");
const resources = join(contents, "Resources");
const core = join(resources, "ForgeAgentCore");

function fail(message) {
  console.error(`[macos-smoke] FAIL ${message}`);
  process.exit(1);
}

function assertFile(path, label, executable = false) {
  if (!existsSync(path)) fail(`${label} is missing at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) fail(`${label} is not a file at ${path}`);
  if (stat.size <= 0) fail(`${label} is empty at ${path}`);
  if (executable) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      fail(`${label} is not executable at ${path}`);
    }
  }
}

function assertDir(path, label) {
  if (!existsSync(path)) fail(`${label} is missing at ${path}`);
  if (!statSync(path).isDirectory()) fail(`${label} is not a directory at ${path}`);
}

function readInfoPlist() {
  const plist = join(contents, "Info.plist");
  assertFile(plist, "Info.plist");
  const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf-8" });
  return JSON.parse(raw);
}

function bundledNodeVersion() {
  const nodePath = join(resources, "node/bin/node");
  let lastFailure = "not executed";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(nodePath, ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const version = result.stdout.trim();
    if (result.status === 0 && /^v\d+\./.test(version)) return version;
    lastFailure = JSON.stringify({
      attempt,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
    if (attempt < 3) spawnSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  fail(`bundled Node.js did not execute --version after 3 attempts: ${lastFailure}`);
}

function main() {
  assertDir(appRoot, "ForgeAgent.app bundle");
  assertDir(contents, "Contents directory");
  assertDir(resources, "Resources directory");
  assertFile(join(contents, "MacOS/ForgeAgentMac"), "macOS app executable", true);
  assertFile(join(resources, "ForgeAgentPowerHelper"), "native power helper", true);
  assertFile(join(resources, "AppIcon.icns"), "app icon");
  assertFile(join(resources, "node/bin/node"), "bundled Node.js", true);
  assertDir(core, "bundled ForgeAgent Core");
  assertFile(join(core, "package.json"), "bundled package.json");
  assertFile(join(core, "package-lock.json"), "bundled package-lock.json");
  assertFile(join(core, "src/gateways/http/main.ts"), "bundled HTTP gateway entrypoint");
  assertFile(join(core, "node_modules/tsx/dist/cli.mjs"), "bundled tsx CLI");
  assertFile(join(core, "web/dist/index.html"), "bundled Web Console index");
  assertFile(join(core, "web/dist/manifest.webmanifest"), "bundled Web Console manifest");

  const assetFiles = readdirSync(join(core, "web/dist/assets")).filter((name) => name.endsWith(".js") || name.endsWith(".css"));
  if (!assetFiles.some((name) => name.endsWith(".js"))) fail("bundled Web Console has no JavaScript asset");
  if (!assetFiles.some((name) => name.endsWith(".css"))) fail("bundled Web Console has no CSS asset");

  const nodeVersion = bundledNodeVersion();

  const info = readInfoPlist();
  if (info.CFBundleExecutable !== "ForgeAgentMac") fail("Info.plist CFBundleExecutable must be ForgeAgentMac");
  if (info.CFBundleIdentifier !== "dev.forgeagent.mac") fail("Info.plist bundle identifier changed unexpectedly");
  if (info.CFBundleIconFile !== "AppIcon") fail("Info.plist CFBundleIconFile must reference AppIcon");
  if (info.NSAppTransportSecurity?.NSAllowsLocalNetworking !== true) fail("Info.plist must allow local networking for loopback Web Console");
  const schemes = info.CFBundleURLTypes?.flatMap((entry) => entry.CFBundleURLSchemes ?? []) ?? [];
  if (!schemes.includes("forgeagent")) fail("Info.plist must register the forgeagent:// URL scheme");

  console.log(`[macos-smoke] PASS app=${appRoot}`);
  console.log(`[macos-smoke] bundled_node=${nodeVersion}`);
}

main();
