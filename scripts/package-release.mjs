#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = String(pkg.version ?? "0.0.0");
const dist = resolve(root, ".forge-release/dist");
const app = join(root, "apps/macos/ForgeAgentMac/dist/DeepSeek-Forge.app");
const androidApk = join(root, "apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk");

function fail(message) {
  console.error(`[release-bundle] FAIL ${message}`);
  process.exit(1);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  if (!statSync(path).isFile()) fail(`${label} is not a file: ${path}`);
}

function assertDir(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  if (!statSync(path).isDirectory()) fail(`${label} is not a directory: ${path}`);
}

function findWebridgePackage() {
  const releaseDir = join(root, ".forge-release/dist");
  if (!existsSync(releaseDir)) return undefined;
  const zips = readdirSync(releaseDir)
    .filter((name) => /^DeepSeek-Forge-Webridge-.+\.zip$/.test(name))
    .map((name) => join(releaseDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const zip = zips[0];
  if (!zip) return undefined;
  const manifest = zip.replace(/\.zip$/, ".json");
  return {
    zip,
    manifest: existsSync(manifest) ? manifest : undefined,
  };
}

function removeLegacyArtifacts() {
  if (!existsSync(dist)) return;
  for (const name of readdirSync(dist)) {
    if (/^(ForgeAgent|ForgeWebridge)-.+\.(zip|apk|json)$/.test(name)) {
      rmSync(join(dist, name), { force: true });
    }
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyArtifact(source, targetName) {
  assertFile(source, targetName);
  const target = join(dist, targetName);
  copyFileSync(source, target);
  return target;
}

function zipMacApp() {
  assertDir(app, "macOS app bundle");
  const target = join(dist, `DeepSeek-Forge-${version}-macos-arm64.zip`);
  rmSync(target, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, target], {
    cwd: root,
    stdio: "pipe",
  });
  return target;
}

function main() {
  mkdirSync(dist, { recursive: true });
  removeLegacyArtifacts();
  const webridgePackage = findWebridgePackage();

  const artifacts = [];
  const macZip = zipMacApp();
  artifacts.push({ name: basename(macZip), path: macZip, platform: "macos", kind: "app_zip" });

  const apk = copyArtifact(androidApk, `DeepSeek-Forge-${version}-android-debug.apk`);
  artifacts.push({ name: basename(apk), path: apk, platform: "android", kind: "debug_apk" });

  if (webridgePackage?.zip) {
    const copied = copyArtifact(webridgePackage.zip, basename(webridgePackage.zip));
    artifacts.push({ name: basename(copied), path: copied, platform: "chrome", kind: "extension_zip" });
  }
  if (webridgePackage?.manifest) {
    const copied = copyArtifact(webridgePackage.manifest, basename(webridgePackage.manifest));
    artifacts.push({ name: basename(copied), path: copied, platform: "chrome", kind: "extension_manifest" });
  }

  const checksums = artifacts.map((artifact) => `${sha256(artifact.path)}  ${artifact.name}`).join("\n") + "\n";
  const checksumsPath = join(dist, "SHA256SUMS");
  writeFileSync(checksumsPath, checksums, "utf-8");

  const manifest = {
    name: "DeepSeek-Forge",
    version,
    generatedAt: new Date().toISOString(),
    releaseGate: "Run `npm run release:gate` before publishing these artifacts.",
    signing: {
      macos: "Unsigned local-first beta artifact. For public binary distribution, sign and notarize before release.",
      android: "Debug APK for local sideload testing. For public Android distribution, produce a signed release APK/AAB.",
      chrome: "Unpacked or sideloaded Chrome extension package for local beta use.",
    },
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      platform: artifact.platform,
      kind: artifact.kind,
      sha256: sha256(artifact.path),
      bytes: statSync(artifact.path).size,
    })),
  };
  const manifestPath = join(dist, "release-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  console.log(`[release-bundle] PASS dist=${dist}`);
  for (const artifact of manifest.artifacts) {
    console.log(`[release-bundle] ${artifact.name} ${artifact.bytes} bytes ${artifact.sha256}`);
  }
  console.log(`[release-bundle] ${checksumsPath}`);
  console.log(`[release-bundle] ${manifestPath}`);
}

main();
