import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type SandboxAccess = "read" | "write";

export type PathSandboxOptions = {
  projectRoot?: string;
  scratchRoot?: string;
  readRoots?: string[];
  writeRoots?: string[];
};

export type PathSandboxResolveResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

const SENSITIVE_DIRS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".config/gcloud",
]);

const SENSITIVE_FILES = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^known_hosts$/i,
];

function normalizeRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function deepestExistingAncestor(path: string): { ancestor: string; remainder: string[] } {
  const absolute = resolve(path);
  if (existsSync(absolute)) return { ancestor: absolute, remainder: [] };

  const parts = absolute.split(sep).filter(Boolean);
  const prefix = absolute.startsWith(sep) ? sep : "";
  const remainder: string[] = [];
  let current = absolute;

  while (!existsSync(current)) {
    const base = basename(current);
    if (base) remainder.unshift(base);
    const next = dirname(current);
    if (next === current) {
      return { ancestor: prefix || sep, remainder: parts };
    }
    current = next;
  }

  return { ancestor: current, remainder };
}

function materializedPath(path: string): string {
  const { ancestor, remainder } = deepestExistingAncestor(path);
  const realAncestor = normalizeRoot(ancestor);
  return remainder.length > 0 ? join(realAncestor, ...remainder) : realAncestor;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pathSegments(path: string): string[] {
  return resolve(path).split(sep).filter(Boolean);
}

function sensitiveReason(path: string): string | null {
  const normalized = resolve(path);
  const segments = pathSegments(normalized);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (SENSITIVE_DIRS.has(segment)) return `The path is inside sensitive directory '${segment}'.`;
    const two = i + 1 < segments.length ? `${segment}/${segments[i + 1]!}` : "";
    if (two && SENSITIVE_DIRS.has(two)) return `The path is inside sensitive directory '${two}'.`;
  }
  const file = basename(normalized);
  if (SENSITIVE_FILES.some((pattern) => pattern.test(file))) {
    return `The path matches sensitive file rule '${file}'.`;
  }
  return null;
}

export class PathSandbox {
  #projectRoot: string;
  #scratchRoot: string;
  #readRoots: string[];
  #writeRoots: string[];

  constructor(options?: PathSandboxOptions) {
    this.#projectRoot = normalizeRoot(options?.projectRoot ?? process.cwd());
    this.#scratchRoot = normalizeRoot(options?.scratchRoot ?? join(this.#projectRoot, ".forge", "workspaces"));
    mkdirSync(this.#scratchRoot, { recursive: true });

    this.#readRoots = unique([
      this.#projectRoot,
      this.#scratchRoot,
      ...(options?.readRoots ?? []),
    ].map(normalizeRoot));
    this.#writeRoots = unique([
      this.#projectRoot,
      this.#scratchRoot,
      ...(options?.writeRoots ?? []),
    ].map(normalizeRoot));
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  get scratchRoot(): string {
    return this.#scratchRoot;
  }

  allowedRoots(access: SandboxAccess): string[] {
    return access === "read" ? [...this.#readRoots] : [...this.#writeRoots];
  }

  isSensitivePath(path: string): boolean {
    return sensitiveReason(path) !== null;
  }

  resolvePath(
    requestedPath: string,
    access: SandboxAccess,
    toolName: string,
    action?: string,
  ): PathSandboxResolveResult {
    const absolute = resolve(requestedPath);
    const materialized = materializedPath(absolute);
    const roots = this.allowedRoots(access);
    const inside = roots.some((root) => isInside(materialized, root));
    if (!inside) {
      return {
        ok: false,
        message: buildSandboxError({
          toolName,
          action: action ?? (access === "read" ? "fs.read" : "fs.write"),
          requestedPath: absolute,
          reason: "The resolved path is outside the allowed workspace roots.",
          allowedRoots: roots,
        }),
      };
    }
    return { ok: true, path: materialized };
  }
}

export function buildSandboxError(options: {
  toolName: string;
  action: string;
  requestedPath: string;
  reason: string;
  allowedRoots: string[];
}): string {
  return [
    "Tool sandbox blocked filesystem access.",
    `Tool: ${options.toolName}`,
    `Requested action: ${options.action}`,
    `Requested path: ${resolve(options.requestedPath)}`,
    `Reason: ${options.reason}`,
    `Allowed roots: ${options.allowedRoots.join(", ")}`,
    "Recovery: Use a path inside the allowed workspace, or ask the user to approve a different approach.",
  ].join("\n");
}

export function getSensitivePathReason(path: string): string | null {
  return sensitiveReason(path);
}
