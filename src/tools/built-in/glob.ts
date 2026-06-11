import { execFileSync, execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildWorkspaceFileIndex, matchWorkspaceGlob, sortWorkspaceFilesByMtime } from "../../workspace/file-index.js";

const DEFAULT_MAX_RESULTS = 100;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".forge"]);

function findRgBinary(): string | null {
  try {
    const result = execSync("command -v rg", {
      encoding: "utf-8",
      shell: "/bin/zsh",
      timeout: 1000,
    }).trim();
    if (result && !result.includes("function")) {
      execFileSync(result, ["--version"], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return result;
    }
  } catch {
    // no rg found
  }
  return null;
}

function execRg(args: string[], cwd: string): string {
  const rgBin = findRgBinary();
  if (rgBin) {
    return execFileSync(rgBin, args, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ARGV0: "rg" },
    }).trim();
  }
  throw new Error("ripgrep not found");
}

function nativeGlob(baseDir: string, pattern: string, maxResults: number): string[] {
  const results: string[] = [];
  const parts = pattern.split("/");
  const isRecursive = parts.includes("**");

  function walk(dir: string, depth: number) {
    if (results.length >= maxResults) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const fullPath = resolve(dir, entry.name);
        const relative = fullPath.slice(baseDir.length + 1);

        if (entry.isDirectory()) {
          if (isRecursive || depth < 3) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          if (matchSimpleGlob(relative, pattern)) {
            results.push(relative);
          }
        }
      }
    } catch {
      // permission denied, skip
    }
  }

  walk(baseDir, 0);
  return results.sort((a, b) => {
    try {
      return statSync(resolve(baseDir, b)).mtimeMs - statSync(resolve(baseDir, a)).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function matchSimpleGlob(filepath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regexStr}$`).test(filepath);
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return { output: "pattern is required.", isError: true };
  const defaultRoot = context?.projectRoot ?? process.cwd();
  const resolvedPath = resolveToolPath(args.path ? args : { ...args, path: defaultRoot }, context, {
    argName: "path",
    access: "read",
    toolName: "glob",
    action: "fs.read",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const path = resolvedPath.path;

  if (!existsSync(path)) {
    return {
      output: [
        "Glob search path does not exist.",
        `Path: ${path}`,
        "Recovery: omit path to search the current project root, or provide an existing directory inside the workspace.",
      ].join("\n"),
      isError: true,
    };
  }
  if (!statSync(path).isDirectory()) {
    return {
      output: [
        "Glob search path is not a directory.",
        `Path: ${path}`,
        "Recovery: use the parent directory as path and put the file pattern in pattern.",
      ].join("\n"),
      isError: true,
    };
  }
  const searchDir = path;

  try {
    const index = buildWorkspaceFileIndex(searchDir);
    const indexedFiles = sortWorkspaceFilesByMtime(
      index.root,
      index.files.filter((file) => matchWorkspaceGlob(file, pattern)),
    );
    if (indexedFiles.length > 0) {
      return JSON.stringify({
        filenames: indexedFiles.slice(0, DEFAULT_MAX_RESULTS),
        numFiles: indexedFiles.length,
        truncated: indexedFiles.length > DEFAULT_MAX_RESULTS,
        source: index.source,
      });
    }

    let result: string;
    try {
      result = execRg(
        [
          "--files",
          "--glob",
          pattern,
          "--sort=modified",
          "--hidden",
          "--glob",
          "!.git",
          "--glob",
          "!node_modules",
          "--glob",
          "!dist",
          "--glob",
          "!build",
          "--glob",
          "!coverage",
          "--glob",
          "!.forge",
          ".",
        ],
        searchDir,
      );
    } catch {
      // fallback to native
      const files = nativeGlob(searchDir, pattern, DEFAULT_MAX_RESULTS);
      if (files.length === 0) return "No files found.";
      return JSON.stringify({
        filenames: files,
        numFiles: files.length,
        truncated: false,
      });
    }

    if (!result) return "No files found.";

    const files = result.split("\n")
      .slice(0, DEFAULT_MAX_RESULTS)
      .map((f) => f.startsWith("/") ? relative(searchDir, f) : f.replace(/^\.\//, ""));
    const truncated = result.split("\n").length > DEFAULT_MAX_RESULTS;

    return JSON.stringify({
      filenames: files,
      numFiles: files.length,
      truncated,
    });
  } catch (error: unknown) {
    const err = error as Error;
    return { output: `Glob failed: ${err.message}`, isError: true };
  }
}

export const globTool: ExecutableToolDefinition = buildTool({
  name: "glob",
  description: `Find files matching a glob pattern.

Usage:
- Uses standard glob patterns: ** for recursive matching, * for wildcards
- Pattern examples: "**/*.ts", "*.js", "src/**/*.test.ts"
- Results are sorted by modification time (newest first)
- Returns relative file paths
- Hidden files are included by default`,
  params: {
    pattern: {
      type: "string",
      description: "The glob pattern to match file paths against",
    },
    path: {
      type: "string",
      description: "The directory to search in (defaults to the current working directory)",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
