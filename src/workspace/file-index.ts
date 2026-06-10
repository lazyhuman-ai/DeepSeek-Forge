import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".forge"]);

export type WorkspaceFileIndex = {
  root: string;
  files: string[];
  source: "git" | "filesystem";
};

function gitFiles(root: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        SSH_ASKPASS: "true",
      },
    }).trim();
    if (!output) return [];
    return output.split(/\r?\n/).filter(Boolean).sort();
  } catch {
    return null;
  }
}

function walk(root: string, dir = root, files: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, fullPath, files);
      continue;
    }
    if (entry.isFile()) files.push(fullPath.slice(root.length + 1));
  }
  return files;
}

export function buildWorkspaceFileIndex(projectRoot: string): WorkspaceFileIndex {
  const root = resolve(projectRoot);
  const git = gitFiles(root);
  if (git && git.length > 0) return { root, files: git, source: "git" };
  return { root, files: walk(root).sort(), source: "filesystem" };
}

export function matchWorkspaceGlob(filePath: string, pattern: string): boolean {
  let regexStr = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          regexStr += "(?:.*/)?";
        } else {
          regexStr += ".*";
        }
      } else {
        regexStr += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      continue;
    }
    regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regexStr}$`).test(filePath);
}

export function sortWorkspaceFilesByMtime(root: string, files: string[]): string[] {
  return files.slice().sort((a, b) => {
    try {
      return statSync(resolve(root, b)).mtimeMs - statSync(resolve(root, a)).mtimeMs;
    } catch {
      return a.localeCompare(b);
    }
  });
}

export function likelyTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ![
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".zip",
    ".gz",
    ".pdf",
    ".sqlite",
    ".db",
  ].includes(ext);
}

export function workspaceRootExists(projectRoot: string): boolean {
  return existsSync(resolve(projectRoot));
}
