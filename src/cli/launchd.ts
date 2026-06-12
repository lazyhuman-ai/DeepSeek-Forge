import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const FORGE_AGENT_LAUNCHD_LABEL = "com.forgeagent.gateway";

export type LaunchAgentOptions = {
  projectRoot: string;
  dataDir: string;
  host: string;
  port: number;
  label?: string;
  logPath?: string;
};

export type LaunchAgentStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  details: string;
};

export function launchAgentPath(label = FORGE_AGENT_LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentSupportDir(): string {
  return join(homedir(), "Library", "Application Support", "ForgeAgent");
}

export function launchAgentLogPath(): string {
  return join(launchAgentSupportDir(), "forgeagent.log");
}

export function launchScriptPath(): string {
  return join(launchAgentSupportDir(), "launchd-start.sh");
}

export function renderLaunchAgentPlist(options: LaunchAgentOptions): string {
  const label = options.label ?? FORGE_AGENT_LAUNCHD_LABEL;
  const projectRoot = resolve(options.projectRoot);
  const dataDir = resolve(options.dataDir);
  const logPath = options.logPath ?? launchAgentLogPath();
  const programArguments = [
    "/bin/zsh",
    launchScriptPath(),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FORGE_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>HTTP_HOST</key>
    <string>${xmlEscape(options.host)}</string>
    <key>HTTP_PORT</key>
    <string>${xmlEscape(String(options.port))}</string>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>USER</key>
    <string>${xmlEscape(process.env.USER ?? "")}</string>
    <key>LOGNAME</key>
    <string>${xmlEscape(process.env.LOGNAME ?? process.env.USER ?? "")}</string>
    <key>SHELL</key>
    <string>${xmlEscape(process.env.SHELL ?? "/bin/zsh")}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(options: LaunchAgentOptions): LaunchAgentStatus {
  const label = options.label ?? FORGE_AGENT_LAUNCHD_LABEL;
  const plistPath = launchAgentPath(label);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(options.logPath ?? launchAgentLogPath()), { recursive: true });
  writeLaunchScript(options);
  writeFileSync(plistPath, renderLaunchAgentPlist({ ...options, label }), "utf-8");

  const domain = launchdDomain();
  runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
  runLaunchctl(["bootstrap", domain, plistPath]);
  runLaunchctl(["kickstart", "-k", `${domain}/${label}`], { allowFailure: true });
  return getLaunchAgentStatus(label);
}

export function uninstallLaunchAgent(label = FORGE_AGENT_LAUNCHD_LABEL): LaunchAgentStatus {
  const plistPath = launchAgentPath(label);
  const domain = launchdDomain();
  runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
  rmSync(plistPath, { force: true });
  return getLaunchAgentStatus(label);
}

export function getLaunchAgentStatus(label = FORGE_AGENT_LAUNCHD_LABEL): LaunchAgentStatus {
  const plistPath = launchAgentPath(label);
  const installed = existsSync(plistPath);
  const domainTarget = `${launchdDomain()}/${label}`;
  const printed = runLaunchctl(["print", domainTarget], { allowFailure: true });
  return {
    label,
    plistPath,
    installed,
    loaded: printed.ok,
    details: printed.output.trim() || (installed ? "Installed but not loaded." : "Not installed."),
  };
}

export function readLaunchAgentPlist(label = FORGE_AGENT_LAUNCHD_LABEL): string | null {
  const plistPath = launchAgentPath(label);
  if (!existsSync(plistPath)) return null;
  return readFileSync(plistPath, "utf-8");
}

function writeLaunchScript(options: LaunchAgentOptions): void {
  const projectRoot = resolve(options.projectRoot);
  const dataDir = resolve(options.dataDir);
  const scriptPath = launchScriptPath();
  mkdirSync(dirname(scriptPath), { recursive: true });
  const nodePath = process.execPath;
  const tsxPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const mainPath = join(projectRoot, "src", "gateways", "http", "main.ts");
  const content = [
    "#!/bin/zsh",
    "set -e",
    "echo \"[launchd] starting DeepSeek-Forge $(date -u +%Y-%m-%dT%H:%M:%SZ)\"",
    `cd ${shellQuote(projectRoot)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(tsxPath)} ${shellQuote(mainPath)}`,
    "",
  ].join("\n");
  writeFileSync(scriptPath, content, "utf-8");
  chmodSync(scriptPath, 0o755);
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  return typeof uid === "number" ? `gui/${uid}` : "gui/501";
}

function runLaunchctl(
  args: string[],
  options?: { allowFailure?: boolean },
): { ok: boolean; output: string } {
  try {
    const output = execFileSync("launchctl", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = [
      bufferToString(error.stdout),
      bufferToString(error.stderr),
      error.message ?? "",
    ].filter(Boolean).join("\n");
    if (options?.allowFailure) return { ok: false, output };
    throw new Error(output || `launchctl ${args.join(" ")} failed.`);
  }
}

function bufferToString(value: Buffer | string | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf-8") : value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
