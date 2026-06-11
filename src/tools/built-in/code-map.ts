import { extname, resolve } from "node:path";
import { statSync } from "node:fs";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { buildWorkspaceFileIndex, likelyTextFile } from "../../workspace/file-index.js";
import { genericFileSymbols } from "../../workspace/code-index.js";
import { resolveToolPath } from "./path-helper.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".kts", ".swift",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh",
  ".cs", ".rb", ".php",
]);

function languageForExt(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".tsx": return "TypeScript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs": return "JavaScript";
    case ".py": return "Python";
    case ".rs": return "Rust";
    case ".go": return "Go";
    case ".java": return "Java";
    case ".kt":
    case ".kts": return "Kotlin";
    case ".swift": return "Swift";
    case ".c":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".h":
    case ".hpp":
    case ".hh": return "C/C++";
    case ".cs": return "C#";
    case ".rb": return "Ruby";
    case ".php": return "PHP";
    default: return ext || "other";
  }
}

function clamp(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  let projectRoot = resolve(context?.projectRoot ?? process.cwd());
  if (typeof args.path === "string") {
    const resolved = resolveToolPath(args, context, {
      argName: "path",
      access: "read",
      toolName: "code_map",
      action: "fs.read",
    });
    if (!resolved.ok) return resolved;
    projectRoot = resolved.path;
  }
  const maxFiles = clamp(args.max_files, 120, 500);
  const includeSymbols = args.include_symbols !== false;
  try {
    const index = buildWorkspaceFileIndex(projectRoot);
    const byLanguage = new Map<string, number>();
    const byDirectory = new Map<string, number>();
    const codeFiles: string[] = [];
    for (const file of index.files) {
      const ext = extname(file).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        codeFiles.push(file);
        increment(byLanguage, languageForExt(ext));
      }
      const top = file.includes("/") ? file.split("/")[0]! : ".";
      increment(byDirectory, top);
    }

    const importantFiles = index.files
      .filter((file) => /(^|\/)(package\.json|tsconfig\.json|vite\.config|next\.config|README|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Makefile|Dockerfile|\.mcp\.json)/i.test(file))
      .slice(0, 40);

    const symbolLines: string[] = [];
    if (includeSymbols) {
      for (const file of codeFiles.slice(0, maxFiles)) {
        const absolute = resolve(index.root, file);
        if (!likelyTextFile(absolute)) continue;
        let size = 0;
        try {
          size = statSync(absolute).size;
        } catch {
          continue;
        }
        if (size > 512 * 1024) continue;
        const symbols = genericFileSymbols(absolute).slice(0, 8);
        if (symbols.length === 0) continue;
        symbolLines.push(`- ${file}: ${symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ")}`);
        if (symbolLines.length >= 80) break;
      }
    }

    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "analysis",
      status: "completed",
      title: "Code map",
      message: `${index.files.length} file(s), ${codeFiles.length} code file(s), source=${index.source}`,
      payload: {
        root: index.root,
        source: index.source,
        totalFiles: index.files.length,
        codeFiles: codeFiles.length,
      },
    });

    return [
      `Code map for ${index.root}`,
      `Index source: ${index.source}`,
      `Files: ${index.files.length}`,
      `Code files: ${codeFiles.length}`,
      "",
      "Languages:",
      ...topEntries(byLanguage, 20).map(([language, count]) => `- ${language}: ${count}`),
      "",
      "Top directories:",
      ...topEntries(byDirectory, 30).map(([dir, count]) => `- ${dir}: ${count}`),
      "",
      "Important files:",
      ...(importantFiles.length ? importantFiles.map((file) => `- ${file}`) : ["- (none detected)"]),
      includeSymbols ? "" : "",
      includeSymbols ? "Representative symbols:" : "",
      ...(includeSymbols ? (symbolLines.length ? symbolLines : ["- (none detected in scanned files)"]) : []),
    ].filter(Boolean).join("\n");
  } catch (error) {
    return {
      output: `code_map failed for ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

export const codeMapTool: ExecutableToolDefinition = buildTool({
  name: "code_map",
  description: "Builds a bounded repository code map: language mix, top directories, important project files, and representative symbols. Use before large coding/refactor work to orient in a repo.",
  params: {
    path: {
      type: "string",
      description: "Optional workspace root. Defaults to the active project/worktree root.",
      optional: true,
    },
    max_files: {
      type: "number",
      description: "Maximum code files to scan for representative symbols. Defaults to 120, capped at 500.",
      optional: true,
    },
    include_symbols: {
      type: "boolean",
      description: "Whether to include representative symbols. Defaults to true.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
