import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

const DEFAULT_HEAD_LIMIT = 250;

function findRgBinary(): string | null {
  const claudePaths = [
    process.env.CLAUDE_CODE_EXECPATH,
    `${process.env.HOME}/.local/bin/claude`,
  ];
  for (const p of claudePaths) {
    if (p && existsSync(p)) return p;
  }
  try {
    const result = execSync("command -v rg", {
      encoding: "utf-8",
      shell: "/bin/zsh",
      timeout: 1000,
    }).trim();
    if (result && !result.includes("function")) return result;
  } catch {
    // no rg found
  }
  return null;
}

function execRg(args: string, cwd: string): string {
  const rgBin = findRgBinary();
  if (rgBin) {
    return execSync(`ARGV0=rg "${rgBin}" ${args}`, {
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20_000,
      cwd,
      shell: "/bin/zsh",
    }).trim();
  }
  throw new Error("ripgrep not found");
}

function nativeGrep(
  searchDir: string,
  pattern: string,
  options: { caseInsensitive?: boolean; includeGlob?: string; maxResults: number },
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
          if (options.includeGlob) {
            const globRegex = new RegExp(
              "^" + options.includeGlob.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
            );
            if (!globRegex.test(entry.name)) continue;
          }
          try {
            const stat = statSync(fullPath);
            if (stat.size > 1024 * 1024) continue; // skip files > 1MB
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= options.maxResults) return;
              if (regex.test(lines[i]!)) {
                results.push(`${relPath}:${i + 1}:${lines[i]}`);
              }
            }
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

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const pattern = args.pattern as string;
  const resolvedPath = resolveToolPath(args.path ? args : { ...args, path: process.cwd() }, context, {
    argName: "path",
    access: "read",
    toolName: "grep",
    action: "fs.read",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const path = resolvedPath.path;
  const include = args.include as string | undefined;
  const caseInsensitive = (args.case_insensitive as boolean) ?? false;

  const searchDir = existsSync(path) && !path.includes("*") ? path : process.cwd();

  try {
    let result: string;
    try {
      const flags: string[] = [
        "--hidden",
        "--glob", "!.git",
        "--glob", "!.svn",
        "--glob", "!.hg",
        "-n",
        "--max-columns", "500",
      ];
      if (caseInsensitive) flags.push("-i");
      if (include) {
        flags.push("--glob", include);
      }
      const escapedPattern = pattern.startsWith("-")
        ? `-e "${pattern}"`
        : `"${pattern}"`;

      result = execRg(
        `${flags.join(" ")} ${escapedPattern} "${searchDir}"`,
        process.cwd(),
      );
    } catch {
      const nativeOptions: { caseInsensitive?: boolean; includeGlob?: string; maxResults: number } = {
        caseInsensitive,
        maxResults: DEFAULT_HEAD_LIMIT,
      };
      if (include !== undefined) nativeOptions.includeGlob = include;
      result = nativeGrep(searchDir, pattern, nativeOptions);
    }

    if (!result) return "No matches found.";

    const lines = result.split("\n");
    const head = lines.slice(0, DEFAULT_HEAD_LIMIT);
    const truncated = head.length < lines.length;

    let output = head.join("\n");
    if (truncated) {
      output += `\n[Output truncated: showing ${head.length} of ${lines.length} matches]`;
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
- Use include to filter by file glob (e.g., "*.ts", "*.md")
- Set case_insensitive to true for case-insensitive search
- Results are limited to ${DEFAULT_HEAD_LIMIT} matches
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
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
