import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve, relative } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

const DEFAULT_HEAD_LIMIT = 250;
const MAX_HEAD_LIMIT = 1_000;

type GrepOutputMode = "content" | "files" | "count";

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
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20_000,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ARGV0: "rg" },
    }).trim();
  }
  throw new Error("ripgrep not found");
}

function nativeGrep(
  searchDir: string,
  pattern: string,
  options: { caseInsensitive?: boolean; includeGlob?: string; maxResults: number; outputMode: GrepOutputMode },
): string {
  const results: string[] = [];
  const regex = new RegExp(pattern, options.caseInsensitive ? "i" : "");

  function walk(dir: string) {
    if (results.length >= options.maxResults) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= options.maxResults) return;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const fullPath = resolve(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = relative(searchDir, fullPath);
          if (options.includeGlob && !matchSimpleGlob(relPath, options.includeGlob)) {
            continue;
          }
          try {
            const stat = statSync(fullPath);
            if (stat.size > 1024 * 1024) continue; // skip files > 1MB
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");
            let matchCount = 0;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= options.maxResults) return;
              if (regex.test(lines[i]!)) {
                matchCount++;
                if (options.outputMode === "content") {
                  results.push(`${relPath}:${i + 1}:${lines[i]}`);
                }
              }
            }
            if (matchCount > 0 && options.outputMode === "files") results.push(relPath);
            if (matchCount > 0 && options.outputMode === "count") results.push(`${relPath}:${matchCount}`);
          } catch {
            // skip unreadable files
          }
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  walk(searchDir);
  return results.join("\n") || "";
}

function matchSimpleGlob(filepath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regexStr}$`).test(filepath) || new RegExp(`(^|/)${regexStr}$`).test(filepath);
}

function outputMode(value: unknown): GrepOutputMode {
  return value === "files" || value === "count" ? value : "content";
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function resolveSearchTarget(path: string): { cwd: string; targets: string[] } {
  if (existsSync(path) && statSync(path).isFile()) {
    return { cwd: dirname(path), targets: [basename(path)] };
  }
  return { cwd: path, targets: ["."] };
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const pattern = args.pattern as string;
  const defaultRoot = context?.projectRoot ?? process.cwd();
  const resolvedPath = resolveToolPath(args.path ? args : { ...args, path: defaultRoot }, context, {
    argName: "path",
    access: "read",
    toolName: "grep",
    action: "fs.read",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const path = resolvedPath.path;
  const include = args.include as string | undefined;
  const caseInsensitive = (args.case_insensitive as boolean) ?? false;
  const mode = outputMode(args.output_mode);
  const headLimit = boundedNumber(args.head_limit, DEFAULT_HEAD_LIMIT, MAX_HEAD_LIMIT);
  const offset = boundedNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const beforeContext = boundedNumber(args.before_context ?? args.context, 0, 25);
  const afterContext = boundedNumber(args.after_context ?? args.context, 0, 25);
  const type = typeof args.type === "string" && args.type.trim() ? args.type.trim() : undefined;
  const multiline = args.multiline === true;

  const searchDir = existsSync(path) && !path.includes("*") ? path : process.cwd();

  try {
    let result: string;
    try {
      const target = resolveSearchTarget(searchDir);
      const flags: string[] = [
        "--hidden",
        "--glob", "!.git",
        "--glob", "!.svn",
        "--glob", "!.hg",
        "--max-columns", "500",
      ];
      if (mode === "content") flags.push("-n");
      if (mode === "files") flags.push("--files-with-matches");
      if (mode === "count") flags.push("--count-matches");
      if (caseInsensitive) flags.push("-i");
      if (include) {
        flags.push("--glob", include);
      }
      if (type) flags.push("--type", type);
      if (beforeContext > 0) flags.push("-B", String(beforeContext));
      if (afterContext > 0) flags.push("-A", String(afterContext));
      if (multiline) flags.push("-U", "--multiline-dotall");

      result = execRg(
        [...flags, "-e", pattern, ...target.targets],
        target.cwd,
      );
    } catch {
      const nativeOptions: {
        caseInsensitive?: boolean;
        includeGlob?: string;
        maxResults: number;
        outputMode: GrepOutputMode;
      } = {
        caseInsensitive,
        maxResults: offset + headLimit,
        outputMode: mode,
      };
      if (include !== undefined) nativeOptions.includeGlob = include;
      result = nativeGrep(searchDir, pattern, nativeOptions);
    }

    if (!result) return "No matches found.";

    const lines = result.split("\n");
    const visible = lines.slice(offset, offset + headLimit);
    const truncated = offset + visible.length < lines.length;

    let output = visible.join("\n");
    if (truncated) {
      output += `\n[Output truncated: showing ${visible.length} result line(s) from offset ${offset} of ${lines.length}]`;
    }

    return output;
  } catch (error: unknown) {
    const err = error as Error;
    return `Grep failed: ${err.message}`;
  }
}

export const grepTool: ExecutableToolDefinition = buildTool({
  name: "grep",
  description: `Search for a pattern in file contents using ripgrep.

Usage:
- Default output format: file_path:line_number:content
- output_mode=files returns matching file paths; output_mode=count returns per-file match counts
- Use include to filter by file glob (e.g., "*.ts", "*.md")
- Set case_insensitive to true for case-insensitive search
- Use context / before_context / after_context for nearby lines, and head_limit / offset for paging
- Use type for ripgrep file types (e.g., "ts", "py", "md") and multiline for multi-line regex search
- Results are limited to ${DEFAULT_HEAD_LIMIT} lines by default
- Prefer grep over bash grep/rg — it respects .gitignore and is faster`,
  params: {
    pattern: {
      type: "string",
      description: "The regex pattern to search for in file contents",
    },
    path: {
      type: "string",
      description: "The directory or file to search in (defaults to cwd)",
      optional: true,
    },
    include: {
      type: "string",
      description: "Glob pattern to filter files (e.g., '*.ts')",
      optional: true,
    },
    case_insensitive: {
      type: "boolean",
      description: "Set to true for case-insensitive search",
      optional: true,
    },
    output_mode: {
      type: "string",
      description: "content, files, or count. Defaults to content.",
      optional: true,
    },
    context: {
      type: "number",
      description: "Number of context lines before and after each match.",
      optional: true,
    },
    before_context: {
      type: "number",
      description: "Number of lines before each match.",
      optional: true,
    },
    after_context: {
      type: "number",
      description: "Number of lines after each match.",
      optional: true,
    },
    head_limit: {
      type: "number",
      description: "Maximum number of output lines to return.",
      optional: true,
    },
    offset: {
      type: "number",
      description: "Number of output lines to skip before returning results.",
      optional: true,
    },
    type: {
      type: "string",
      description: "Ripgrep file type filter, such as ts, js, py, md.",
      optional: true,
    },
    multiline: {
      type: "boolean",
      description: "Enable multi-line regex search.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
