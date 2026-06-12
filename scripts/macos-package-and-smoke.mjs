#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const app = join(root, "apps/macos/ForgeAgentMac/dist/DeepSeek-Forge.app");
const legacyApp = join(root, "apps/macos/ForgeAgentMac/dist/ForgeAgent.app");
const label = "com.forgeagent.gateway";
const domain = `gui/${process.getuid?.() ?? 501}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const launchScript = join(homedir(), "Library/Application Support/ForgeAgent/launchd-start.sh");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

function runQuiet(command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function launchScriptTargetsDistApp() {
  if (!existsSync(launchScript)) return false;
  const content = readFileSync(launchScript, "utf-8");
  return content.includes(`${app}/Contents/`) || content.includes(`${legacyApp}/Contents/`);
}

function launchdLoaded() {
  return runQuiet("launchctl", ["print", `${domain}/${label}`]);
}

function findDistAppPids() {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" });
  } catch {
    return [];
  }
  const markers = [`${app}/Contents/`, `${legacyApp}/Contents/`];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) return undefined;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter((entry) => entry && entry.pid !== process.pid && markers.some((marker) => entry.command.includes(marker)))
    .map((entry) => entry.pid);
}

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function stopRunningDistApp() {
  const state = { stoppedLaunchd: false, wasLoaded: false };
  if (launchScriptTargetsDistApp()) {
    state.wasLoaded = launchdLoaded();
    runQuiet("launchctl", ["bootout", `${domain}/${label}`]);
    if (existsSync(plist)) runQuiet("launchctl", ["bootout", domain, plist]);
    state.stoppedLaunchd = true;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pids = findDistAppPids();
    if (pids.length === 0) return state;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }
    sleep(0.2);
  }

  for (const pid of findDistAppPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
  return state;
}

function restoreDistAppService(state) {
  if (!state.stoppedLaunchd || !state.wasLoaded || !existsSync(plist)) return;
  if (existsSync(launchScript) && readFileSync(launchScript, "utf-8").includes(`${legacyApp}/Contents/`)) {
    return;
  }
  runQuiet("launchctl", ["bootstrap", domain, plist]);
  runQuiet("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
}

const serviceState = stopRunningDistApp();
let failure = undefined;
try {
  run("npm", ["run", "macos:package"], {
    env: {
      ...process.env,
      FORGEAGENT_PACKAGE_SKIP_SERVICE_MANAGEMENT: "1",
    },
  });
  run(process.execPath, ["scripts/macos-smoke.mjs"]);
} catch (err) {
  failure = err;
  process.exitCode = typeof err?.status === "number" ? err.status : 1;
} finally {
  restoreDistAppService(serviceState);
}

if (failure) {
  process.exit(process.exitCode ?? 1);
}
