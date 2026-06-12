import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { FORGE_AGENT_APP_NAME, FORGE_AGENT_VERSION, isDeepSeekForgeAppName } from "../../core/app-info.js";

export type GatewayRunState = {
  app: typeof FORGE_AGENT_APP_NAME;
  version: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  dataDir: string;
  startedAt: string;
  logPath?: string;
};

export function runDir(dataDir = ".forge"): string {
  return join(resolve(dataDir), "run");
}

export function runStatePath(dataDir = ".forge"): string {
  return join(runDir(dataDir), "gateway.json");
}

export function runPidPath(dataDir = ".forge"): string {
  return join(runDir(dataDir), "forgeagent.pid");
}

export function runLogPath(dataDir = ".forge"): string {
  return join(runDir(dataDir), "forgeagent.log");
}

export function readRunState(dataDir = ".forge"): GatewayRunState | null {
  const statePath = runStatePath(dataDir);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<GatewayRunState>;
    if (!isDeepSeekForgeAppName(parsed.app)) return null;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.host !== "string" || typeof parsed.port !== "number") return null;
    if (typeof parsed.url !== "string" || typeof parsed.dataDir !== "string") return null;
    return {
      app: FORGE_AGENT_APP_NAME,
      version: typeof parsed.version === "string" ? parsed.version : FORGE_AGENT_VERSION,
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      dataDir: parsed.dataDir,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
      ...(typeof parsed.logPath === "string" ? { logPath: parsed.logPath } : {}),
    };
  } catch {
    return null;
  }
}

export function writeRunState(
  dataDir: string,
  input: {
    pid: number;
    host: string;
    port: number;
    url: string;
    logPath?: string;
  },
): GatewayRunState {
  const dir = runDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const state: GatewayRunState = {
    app: FORGE_AGENT_APP_NAME,
    version: FORGE_AGENT_VERSION,
    pid: input.pid,
    host: input.host,
    port: input.port,
    url: input.url,
    dataDir: resolve(dataDir),
    startedAt: new Date().toISOString(),
    ...(input.logPath ? { logPath: input.logPath } : {}),
  };
  atomicWrite(runStatePath(dataDir), JSON.stringify(state, null, 2));
  atomicWrite(runPidPath(dataDir), `${input.pid}\n`);
  return state;
}

export function clearRunState(dataDir = ".forge"): void {
  rmSync(runStatePath(dataDir), { force: true });
  rmSync(runPidPath(dataDir), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}
