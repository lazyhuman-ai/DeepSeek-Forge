import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderLaunchAgentPlist } from "../src/cli/launchd.js";
import { packageWebridgeExtension } from "../src/cli/webridge-package.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DeepSeek-Forge productization helpers", () => {
  it("renders a launchd plist with gateway environment", () => {
    const plist = renderLaunchAgentPlist({
      projectRoot: "/tmp/Forge & Agent",
      dataDir: "/tmp/Forge & Agent/.forge",
      host: "127.0.0.1",
      port: 3000,
      logPath: "/tmp/Forge & Agent/.forge/run/forgeagent.log",
    });

    expect(plist).toContain("<string>com.forgeagent.gateway</string>");
    expect(plist).toContain("<key>FORGE_DATA_DIR</key>");
    expect(plist).toContain("<string>/tmp/Forge &amp; Agent/.forge</string>");
    expect(plist).toContain("<key>HTTP_HOST</key>");
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
  });

  const packageIt = hasZip() ? it : it.skip;

  packageIt("packages DeepSeek-Forge Webridge with generated icons and release manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "forgewebridge-package-"));
    tmpRoots.push(root);
    const extensionDir = join(root, "extension");
    const outputDir = join(root, "release");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      name: "DeepSeek-Forge Webridge",
      version: "9.9.9",
      background: { service_worker: "background.js" },
    }));
    writeFileSync(join(extensionDir, "background.js"), "console.log('ok');\n");

    const result = packageWebridgeExtension({ extensionDir, outputDir });
    const release = JSON.parse(readFileSync(result.manifestPath, "utf-8")) as {
      sha256?: string;
      zipPath?: string;
    };

    expect(existsSync(result.zipPath)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.sha256).toBe(result.sha256);
    expect(release.zipPath).toBe(result.zipPath);
    expect(existsSync(join(extensionDir, "icons", "icon128.png"))).toBe(true);
  });
});

function hasZip(): boolean {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
