import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

export const CODEGRAPH_VERSION = "v0.9.7";

const CODEGRAPH_REPO = "colbymchenry/codegraph";
const DOWNLOAD_BASES = [
  `https://dl.reasonix.io/codegraph/${CODEGRAPH_VERSION}`,
  `https://github.com/${CODEGRAPH_REPO}/releases/download/${CODEGRAPH_VERSION}`,
];

const CHECKSUMS: Record<string, string> = {
  "codegraph-darwin-arm64.tar.gz": "83a3b90bc334ab2a34240e29e9fab7ff273ab6381794aa6f3cba428397c916b5",
  "codegraph-darwin-x64.tar.gz": "74d2331161a317fa6164285a61ec480ce7893be46c1677a4b5a2932e35586b9d",
  "codegraph-linux-arm64.tar.gz": "7b4225f90ca5285cccfec099323129348c2753bcbc9910281f9b61db88fa5f37",
  "codegraph-linux-x64.tar.gz": "61805e3c9b4052db53c71241b800859095fea4f2cbd2a1844a6c2b9594b9f84a",
  "codegraph-win32-arm64.zip": "c728ada3d42701213dde26d8e94ded3ed1c7d4b568124210649ce8f9f938a31a",
  "codegraph-win32-x64.zip": "a5571d3ee54cc1caac76bf09e0f7cb350fc4dd6788a5437217eac33b71fa7a15",
};

export const CODEGRAPH_READ_ONLY_TOOLS = [
  "codegraph_callees",
  "codegraph_callers",
  "codegraph_context",
  "codegraph_explore",
  "codegraph_files",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_search",
  "codegraph_status",
  "codegraph_trace",
];

function archName(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return process.arch;
}

function osName(): string {
  if (process.platform === "win32") return "win32";
  return process.platform;
}

function assetName(): string {
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return `codegraph-${osName()}-${archName()}.${ext}`;
}

function launcherNames(): string[] {
  if (process.platform === "win32") {
    return [
      join("bin", "codegraph.cmd"),
      join("bin", "codegraph.exe"),
      join("bin", "codegraph.bat"),
      "codegraph.cmd",
      "codegraph.exe",
    ];
  }
  return [join("bin", "codegraph")];
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function userCacheDir(): string {
  const root = process.env.FORGE_CODEGRAPH_CACHE_DIR
    ?? (process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "forgeagent") : join(process.env.HOME ?? tmpdir(), ".cache", "forgeagent"));
  return join(root, "codegraph", CODEGRAPH_VERSION);
}

function cachedLauncher(cacheDir = userCacheDir()): string | null {
  for (const rel of launcherNames()) {
    const candidate = join(cacheDir, rel);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function systemLauncher(): string | null {
  const path = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["codegraph.cmd", "codegraph.exe", "codegraph.bat"] : ["codegraph"];
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveCodeGraphLauncher(input?: { overridePath?: string; cacheDir?: string }): string | null {
  if (input?.overridePath && isExecutable(resolve(input.overridePath))) return resolve(input.overridePath);
  return cachedLauncher(input?.cacheDir) ?? systemLauncher();
}

function resolveRedirect(url: string, location: string): string {
  return new URL(location, url).toString();
}

function httpDownload(url: string, destination: string, signal?: AbortSignal, redirects = 0): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error("CodeGraph download aborted"));
      return;
    }
    const request = get(url, (response) => {
      if (
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location &&
        redirects < 5
      ) {
        const nextUrl = resolveRedirect(url, response.headers.location);
        response.resume();
        void httpDownload(nextUrl, destination, signal, redirects + 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectPromise(new Error(`GET ${url}: ${response.statusCode ?? "unknown"}`));
        return;
      }
      const out = createWriteStream(destination, { mode: 0o600 });
      pipeline(response, out).then(resolvePromise, rejectPromise);
    });
    const abort = (): void => {
      request.destroy(new Error("CodeGraph download aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      rejectPromise(error);
    });
    request.on("close", () => {
      signal?.removeEventListener("abort", abort);
    });
  });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function runCommand(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(new Error("CodeGraph operation aborted"));
      return;
    }
    let settled = false;
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const settleResolve = (value: string): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          settleReject(new Error(`${basename(command)} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    const abort = (): void => {
      child.kill("SIGKILL");
      settleReject(new Error("CodeGraph operation aborted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      settleReject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0) settleResolve(output);
      else settleReject(new Error(output || `${basename(command)} exited with ${code ?? "unknown"}`));
    });
  });
}

async function extractArchive(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(destination, { recursive: true });
  const runOptions: { signal?: AbortSignal; timeoutMs: number } = { timeoutMs: 120_000 };
  if (signal !== undefined) runOptions.signal = signal;
  if (archive.endsWith(".zip")) {
    const unzip = process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`]]
      : ["unzip", ["-q", archive, "-d", destination]];
    await runCommand(unzip[0] as string, unzip[1] as string[], runOptions);
    return;
  }
  await runCommand("tar", ["-xzf", archive, "-C", destination], runOptions);
}

export async function installCodeGraph(input?: {
  cacheDir?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<string> {
  const cacheDir = input?.cacheDir ?? userCacheDir();
  const existing = cachedLauncher(cacheDir);
  if (existing) return existing;

  const asset = assetName();
  const expected = CHECKSUMS[asset];
  if (!expected) throw new Error(`CodeGraph does not have a pinned checksum for ${asset}.`);
  const parent = dirname(cacheDir);
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(join(parent, ".codegraph-download-"));
  const archive = join(tmp, asset);
  try {
    let lastError: Error | null = null;
    for (const base of DOWNLOAD_BASES) {
      const url = `${base.replace(/\/+$/, "")}/${asset}`;
      input?.log?.(`Downloading CodeGraph ${CODEGRAPH_VERSION} from ${url}`);
      try {
        await httpDownload(url, archive, input?.signal);
        const actual = await sha256File(archive);
        if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        rmSync(archive, { force: true });
      }
    }
    if (!existsSync(archive)) throw lastError ?? new Error(`CodeGraph download failed for ${asset}.`);

    const extracted = join(tmp, "extract");
    await extractArchive(archive, extracted, input?.signal);
    const entries = await import("node:fs").then((fs) => fs.readdirSync(extracted));
    const root = entries.length === 1 ? join(extracted, entries[0]!) : extracted;
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(root, cacheDir);
    const launcher = cachedLauncher(cacheDir);
    if (!launcher) throw new Error("CodeGraph launcher not found after extraction.");
    return launcher;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function codeGraphInitialized(projectRoot: string): boolean {
  try {
    return statSync(join(projectRoot, ".codegraph")).isDirectory();
  } catch {
    return false;
  }
}

export function isCodeGraphIndexableRoot(projectRoot: string): boolean {
  const abs = resolve(projectRoot);
  return dirname(abs) !== abs;
}

export async function ensureCodeGraphReady(input: {
  projectRoot: string;
  overridePath?: string;
  cacheDir?: string;
  signal?: AbortSignal;
  autoInstall?: boolean;
}): Promise<string> {
  if (!isCodeGraphIndexableRoot(input.projectRoot)) {
    throw new Error("CodeGraph refused to index a filesystem root. Choose a real project folder.");
  }
  const launcherOptions: { overridePath?: string; cacheDir?: string } = {};
  if (input.overridePath !== undefined) launcherOptions.overridePath = input.overridePath;
  if (input.cacheDir !== undefined) launcherOptions.cacheDir = input.cacheDir;
  let launcher = resolveCodeGraphLauncher(launcherOptions);
  if (!launcher) {
    if (input.autoInstall === false) {
      throw new Error("CodeGraph launcher not found. Install CodeGraph or enable auto-install.");
    }
    const installOptions: { cacheDir?: string; signal?: AbortSignal } = {};
    if (input.cacheDir !== undefined) installOptions.cacheDir = input.cacheDir;
    if (input.signal !== undefined) installOptions.signal = input.signal;
    launcher = await installCodeGraph(installOptions);
  }
  if (!codeGraphInitialized(input.projectRoot)) {
    const runOptions: { cwd: string; signal?: AbortSignal; timeoutMs: number } = {
      cwd: input.projectRoot,
      timeoutMs: 30_000,
    };
    if (input.signal !== undefined) runOptions.signal = input.signal;
    await runCommand(launcher, ["init", input.projectRoot], runOptions);
  }
  return launcher;
}
