#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../core/env.js";
import { isDeepSeekForgeAppName } from "../core/app-info.js";
import {
  clearRunState,
  isProcessAlive,
  readRunState,
  runDir,
  runLogPath,
  type GatewayRunState,
} from "../gateways/http/run-state.js";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttpGateway } from "../gateways/http/app.js";
import {
  FORGE_AGENT_LAUNCHD_LABEL,
  getLaunchAgentStatus,
  installLaunchAgent,
  launchAgentLogPath,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  defaultWebridgeExtensionDir,
  packageWebridgeExtension,
  readWebridgeManifest,
} from "./webridge-package.js";
import { SkillStore } from "../skills/skill-store.js";

type CliOptions = {
  dataDir: string;
  host: string;
  port: number;
  foreground: boolean;
  extensionDir?: string;
  outputDir?: string;
  tailLines: number;
};

type HealthPayload = {
  app?: string;
  status?: string;
  version?: string;
  gateway?: { baseUrl?: string };
  webridge?: { enabled?: boolean; state?: string; message?: string; clients?: unknown[] };
};

function isDeepSeekForgeHealth(health: HealthPayload | null): health is HealthPayload {
  return isDeepSeekForgeAppName(health?.app);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "status";
  const options = parseOptions(command === args[0] ? args.slice(1) : args);

  switch (command) {
    case "install":
      await installCommand(options);
      return;
    case "install-service":
      await installServiceCommand(options);
      return;
    case "uninstall-service":
      await uninstallServiceCommand(options);
      return;
    case "start":
      await startCommand(options);
      return;
    case "status":
      await statusCommand(options);
      return;
    case "stop":
      await stopCommand(options);
      return;
    case "restart":
      await stopCommand(options, { quiet: true });
      await startCommand(options);
      return;
    case "doctor":
      await doctorCommand(options);
      return;
    case "logs":
      logsCommand(options);
      return;
    case "webridge-package":
      webridgePackageCommand(options);
      return;
    case "webridge-open":
      webridgeOpenCommand(options);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: process.env.FORGE_DATA_DIR ?? ".forge",
    host: process.env.HTTP_HOST ?? DEFAULT_HTTP_HOST,
    port: parseInt(process.env.HTTP_PORT ?? String(DEFAULT_HTTP_PORT), 10),
    foreground: false,
    tailLines: 80,
  };
  if (process.env.FORGE_WEBRIDGE_EXTENSION_DIR) {
    options.extensionDir = process.env.FORGE_WEBRIDGE_EXTENSION_DIR;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--data-dir":
        options.dataDir = requireValue(args, ++i, arg);
        break;
      case "--host":
        options.host = requireValue(args, ++i, arg);
        break;
      case "--port":
        options.port = parseInt(requireValue(args, ++i, arg), 10);
        if (!Number.isFinite(options.port) || options.port <= 0) {
          throw new Error("--port must be a positive integer.");
        }
        break;
      case "--foreground":
        options.foreground = true;
        break;
      case "--extension-dir":
        options.extensionDir = requireValue(args, ++i, arg);
        break;
      case "--output-dir":
        options.outputDir = requireValue(args, ++i, arg);
        break;
      case "--tail":
        options.tailLines = parseInt(requireValue(args, ++i, arg), 10);
        if (!Number.isFinite(options.tailLines) || options.tailLines <= 0) {
          throw new Error("--tail must be a positive integer.");
        }
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}.`);
  return value;
}

async function installCommand(options: CliOptions): Promise<void> {
  await installServiceCommand(options);
  webridgePackageCommand(options);
  await doctorCommand(options);
  const url = `http://${options.host}:${options.port}`;
  console.log("");
  console.log(`Open DeepSeek-Forge Web Console: ${url}`);
  openUrl(url);
  console.log("");
  console.log("Next step for Chrome:");
  console.log(`  Load or reload this unpacked extension: ${resolveWebridgeExtensionDir(options)}`);
  console.log("  Open chrome://extensions, enable Developer mode, then click Reload on DeepSeek-Forge Webridge.");
  console.log("After that, DeepSeek-Forge Webridge auto-pairs with the local gateway; manual pair codes are only a fallback.");
}

async function installServiceCommand(options: CliOptions): Promise<void> {
  await stopCommand(options, { quiet: true });
  const status = installLaunchAgent({
    projectRoot: process.cwd(),
    dataDir: options.dataDir,
    host: options.host,
    port: options.port,
    logPath: launchAgentLogPath(),
  });
  console.log(`Installed LaunchAgent: ${status.plistPath}`);
  console.log(`LaunchAgent loaded: ${status.loaded ? "yes" : "no"}`);
  const url = `http://${options.host}:${options.port}`;
  const health = await waitForHealth(url, 15_000);
  if (isDeepSeekForgeHealth(health)) {
    console.log(`DeepSeek-Forge service is ready: ${url}`);
    printHealth(health);
  } else {
    console.log(`DeepSeek-Forge service was installed, but health is not ready yet: ${url}/health`);
    console.log(`LaunchAgent log: ${launchAgentLogPath()}`);
    console.log(`Gateway run log: ${runLogPath(options.dataDir)}`);
  }
}

async function uninstallServiceCommand(options: CliOptions): Promise<void> {
  const state = readRunState(options.dataDir);
  const status = uninstallLaunchAgent();
  if (state?.pid && isProcessAlive(state.pid)) {
    await waitForExit(state.pid, 5_000);
  }
  if (state && !isProcessAlive(state.pid)) clearRunState(options.dataDir);
  console.log(`Uninstalled LaunchAgent: ${status.plistPath}`);
  console.log(`LaunchAgent loaded: ${status.loaded ? "yes" : "no"}`);
}

async function startCommand(options: CliOptions): Promise<void> {
  const existing = readRunState(options.dataDir);
  if (existing && isProcessAlive(existing.pid)) {
    const health = await fetchHealth(existing.url).catch(() => null);
    if (isDeepSeekForgeHealth(health)) {
      printRunning(existing, health);
      return;
    }
    console.log(`DeepSeek-Forge process ${existing.pid} is running, but /health is not responding.`);
    console.log(`Log: ${existing.logPath ?? runLogPath(options.dataDir)}`);
    return;
  }
  if (existing) clearRunState(options.dataDir);

  if (options.foreground) {
    const started = await startHttpGateway({
      dataDir: options.dataDir,
      host: options.host,
      port: options.port,
      logPath: runLogPath(options.dataDir),
    });
    console.log(`DeepSeek-Forge started: ${started.url}`);
    console.log(`Health: ${started.url}/health`);
    installForegroundShutdown(started);
    return;
  }

  const logPath = runLogPath(options.dataDir);
  mkdirSync(runDir(options.dataDir), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn("npm", ["run", "http"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORGE_DATA_DIR: options.dataDir,
      HTTP_HOST: options.host,
      HTTP_PORT: String(options.port),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const started = await waitForRunState(options.dataDir, 10_000);
  if (!started) {
    console.log("DeepSeek-Forge start requested, but health did not become ready before timeout.");
    console.log(`Log: ${logPath}`);
    return;
  }
  const health = await fetchHealth(started.url).catch(() => null);
  printRunning(started, health);
}

async function statusCommand(options: CliOptions): Promise<void> {
  const launchd = getLaunchAgentStatus();
  const state = readRunState(options.dataDir);
  if (state && isProcessAlive(state.pid)) {
    const health = await fetchHealth(state.url).catch(() => null);
    printRunning(state, health);
    printLaunchdStatus(launchd);
    return;
  }
  if (state) {
    clearRunState(options.dataDir);
    console.log("DeepSeek-Forge is not running; stale run files were removed.");
    printLaunchdStatus(launchd);
    return;
  }

  const fallbackUrl = `http://${options.host}:${options.port}`;
  const health = await fetchHealth(fallbackUrl).catch(() => null);
  if (isDeepSeekForgeHealth(health)) {
    console.log(`DeepSeek-Forge is reachable at ${fallbackUrl}, but no local run file was found.`);
    printHealth(health);
    printLaunchdStatus(launchd);
    return;
  }
  console.log("DeepSeek-Forge is not running.");
  printLaunchdStatus(launchd);
}

async function stopCommand(options: CliOptions, flags?: { quiet?: boolean }): Promise<void> {
  const state = readRunState(options.dataDir);
  if (!state) {
    if (!flags?.quiet) console.log("DeepSeek-Forge is not running.");
    return;
  }
  if (!isProcessAlive(state.pid)) {
    clearRunState(options.dataDir);
    if (!flags?.quiet) console.log("DeepSeek-Forge is not running; stale run files were removed.");
    return;
  }

  process.kill(state.pid, "SIGTERM");
  const stopped = await waitForExit(state.pid, 5_000);
  if (!stopped) {
    process.kill(state.pid, "SIGKILL");
    await waitForExit(state.pid, 2_000);
  }
  clearRunState(options.dataDir);
  if (!flags?.quiet) console.log(`Stopped DeepSeek-Forge process ${state.pid}.`);
}

async function doctorCommand(options: CliOptions): Promise<void> {
  const checks: Array<{ name: string; state: "OK" | "WARN" | "FAIL"; detail: string }> = [];
  checks.push({
    name: "Node.js",
    state: parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20 ? "OK" : "WARN",
    detail: `v${process.versions.node}`,
  });

  const dataDir = resolve(options.dataDir);
  checks.push({
    name: "Data directory",
    state: existsSync(dataDir) ? "OK" : "WARN",
    detail: existsSync(dataDir) ? dataDir : `${dataDir} does not exist yet.`,
  });

  const launchd = getLaunchAgentStatus();
  checks.push({
    name: "LaunchAgent",
    state: launchd.installed && launchd.loaded ? "OK" : launchd.installed ? "WARN" : "WARN",
    detail: launchd.installed
      ? `${launchd.label} installed=${launchd.installed} loaded=${launchd.loaded}`
      : "Not installed. Run npm run forgeagent -- install-service for auto-start.",
  });

  const state = readRunState(options.dataDir);
  if (state && isProcessAlive(state.pid)) {
    checks.push({
      name: "Gateway process",
      state: "OK",
      detail: `pid=${state.pid} url=${state.url}`,
    });
  } else {
    checks.push({
      name: "Gateway process",
      state: "WARN",
      detail: "No live run-state process. Run npm run forgeagent -- start or install-service.",
    });
  }

  const url = state?.url ?? `http://${options.host}:${options.port}`;
  const health = await fetchHealth(url).catch((err) => {
    checks.push({
      name: "HTTP health",
      state: "FAIL",
      detail: `${url}/health failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  });
  if (isDeepSeekForgeHealth(health)) {
    checks.push({
      name: "HTTP health",
      state: "OK",
      detail: `${health.status ?? "unknown"} at ${url}`,
    });
    const webridge = health.webridge;
    checks.push({
      name: "DeepSeek-Forge Webridge runtime",
      state: webridge?.enabled === false
        ? "FAIL"
        : webridge?.state === "online"
          ? "OK"
          : "WARN",
      detail: webridge
        ? `${webridge.state ?? "unknown"} - ${webridge.message ?? ""}`
        : "Missing from health payload.",
    });
  }

  const extensionDir = resolveWebridgeExtensionDir(options);
  try {
    const manifest = readWebridgeManifest(extensionDir);
    checks.push({
      name: "Chrome extension",
      state: "OK",
      detail: `${manifest.name} ${manifest.version} at ${extensionDir}`,
    });
  } catch (err) {
    checks.push({
      name: "Chrome extension",
      state: "FAIL",
      detail: `${extensionDir}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const logPath = state?.logPath ?? runLogPath(options.dataDir);
  checks.push({
    name: "Gateway run log",
    state: existsSync(logPath) ? "OK" : "WARN",
    detail: existsSync(logPath) ? logPath : `${logPath} does not exist yet.`,
  });
  try {
    const skills = new SkillStore({ rootDir: resolve(options.dataDir, "skills") });
    const status = skills.getStatus();
    checks.push({
      name: "Skill ecosystem",
      state: status.invalid > 0 || status.quarantined > 0 ? "WARN" : "OK",
      detail: `active=${status.active} generated=${status.generated} invalid=${status.invalid} quarantined=${status.quarantined} manifest=${status.manifestPath}`,
    });
  } catch (err) {
    checks.push({
      name: "Skill ecosystem",
      state: "FAIL",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const serviceLogPath = launchAgentLogPath();
  checks.push({
    name: "LaunchAgent log",
    state: existsSync(serviceLogPath) ? "OK" : "WARN",
    detail: existsSync(serviceLogPath) ? serviceLogPath : `${serviceLogPath} does not exist yet.`,
  });

  console.log("DeepSeek-Forge doctor");
  for (const check of checks) {
    console.log(`[${check.state}] ${check.name}: ${check.detail}`);
  }
}

function logsCommand(options: CliOptions): void {
  const state = readRunState(options.dataDir);
  const serviceLogPath = launchAgentLogPath();
  const logPath = state?.logPath
    ?? (existsSync(serviceLogPath) ? serviceLogPath : runLogPath(options.dataDir));
  if (!existsSync(logPath)) {
    console.log(`Log file does not exist yet: ${logPath}`);
    return;
  }
  const lines = readFileSync(logPath, "utf-8").split(/\r?\n/);
  console.log(lines.slice(-options.tailLines).join("\n"));
}

function webridgePackageCommand(options: CliOptions): void {
  const result = packageWebridgeExtension({
    extensionDir: resolveWebridgeExtensionDir(options),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
  });
  console.log(`Packaged DeepSeek-Forge Webridge ${result.version}`);
  console.log(`Extension: ${result.extensionDir}`);
  console.log(`Zip: ${result.zipPath}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`SHA256: ${result.sha256}`);
}

function webridgeOpenCommand(options: CliOptions): void {
  const extensionDir = resolveWebridgeExtensionDir(options);
  spawn("open", ["-R", extensionDir], { detached: true, stdio: "ignore" }).unref();
  spawn("open", ["-a", "Google Chrome", "chrome://extensions/"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  console.log(`Opened Chrome extensions page and revealed: ${extensionDir}`);
}

function installForegroundShutdown(started: Awaited<ReturnType<typeof startHttpGateway>>): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void started.shutdown()
      .finally(() => {
        clearRunState(started.dataDir);
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function waitForRunState(dataDir: string, timeoutMs: number): Promise<GatewayRunState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readRunState(dataDir);
    if (state && isProcessAlive(state.pid)) {
      const health = await fetchHealth(state.url).catch(() => null);
      if (isDeepSeekForgeHealth(health)) return state;
    }
    await sleep(200);
  }
  return null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<HealthPayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(url).catch(() => null);
    if (isDeepSeekForgeHealth(health)) return health;
    await sleep(300);
  }
  return null;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

async function fetchHealth(url: string): Promise<HealthPayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json() as HealthPayload;
  } finally {
    clearTimeout(timer);
  }
}

function printRunning(state: GatewayRunState, health: HealthPayload | null): void {
  console.log(`DeepSeek-Forge is running: ${state.url}`);
  console.log(`Web Console: ${state.url}`);
  console.log(`PID: ${state.pid}`);
  console.log(`Data: ${resolve(state.dataDir)}`);
  console.log(`Log: ${state.logPath ?? runLogPath(state.dataDir)}`);
  if (health) printHealth(health);
}

function printLaunchdStatus(status = getLaunchAgentStatus()): void {
  if (status.installed) {
    console.log(`LaunchAgent: ${status.loaded ? "loaded" : "installed, not loaded"} (${status.plistPath})`);
  } else {
    console.log(`LaunchAgent: not installed (${FORGE_AGENT_LAUNCHD_LABEL})`);
  }
}

function printHealth(health: HealthPayload): void {
  const version = health.version ? ` ${health.version}` : "";
  console.log(`Health: ${health.status ?? "unknown"} (${health.app ?? "unknown"}${version})`);
  const webridge = health.webridge;
  if (webridge) {
    const state = webridge.state ?? "unknown";
    const message = webridge.message ?? "";
    console.log(`DeepSeek-Forge Webridge: ${webridge.enabled === false ? "disabled" : state}${message ? ` - ${message}` : ""}`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  npm run forgeagent -- install [--host 127.0.0.1] [--port 3000] [--data-dir .forge]
  npm run forgeagent -- install-service [--host 127.0.0.1] [--port 3000] [--data-dir .forge]
  npm run forgeagent -- uninstall-service [--data-dir .forge]
  npm run forgeagent -- start [--foreground] [--host 127.0.0.1] [--port 3000] [--data-dir .forge]
  npm run forgeagent -- status [--data-dir .forge]
  npm run forgeagent -- stop [--data-dir .forge]
  npm run forgeagent -- restart [--host 127.0.0.1] [--port 3000] [--data-dir .forge]
  npm run forgeagent -- doctor [--data-dir .forge]
  npm run forgeagent -- logs [--tail 80] [--data-dir .forge]
  npm run forgeagent -- webridge-package [--extension-dir <dir>] [--output-dir .forge/release]
  npm run forgeagent -- webridge-open [--extension-dir <dir>]

DeepSeek-Forge writes process state to ${runDir(".forge")}.
LaunchAgent label: ${FORGE_AGENT_LAUNCHD_LABEL}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWebridgeExtensionDir(options: CliOptions): string {
  return resolve(options.extensionDir ?? defaultWebridgeExtensionDir(process.cwd()));
}

function openUrl(url: string): void {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
