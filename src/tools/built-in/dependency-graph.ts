import { dirname, extname, normalize, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { buildWorkspaceFileIndex, likelyTextFile } from "../../workspace/file-index.js";
import { resolveToolPath } from "./path-helper.js";

const MAX_FILE_BYTES = 512 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift",
]);

type Edge = {
  from: string;
  to: string;
  kind: "internal" | "external";
};

function clamp(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

function readSmall(filePath: string): string | null {
  try {
    if (!likelyTextFile(filePath) || statSync(filePath).size > MAX_FILE_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractDependencies(filePath: string, content: string): string[] {
  const ext = extname(filePath).toLowerCase();
  const deps = new Set<string>();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    for (const match of content.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g)) deps.add(match[1]!);
    for (const match of content.matchAll(/\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g)) deps.add(match[1]!);
    for (const match of content.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) deps.add(match[1]!);
    for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) deps.add(match[1]!);
  } else if (ext === ".py") {
    for (const match of content.matchAll(/^\s*from\s+([A-Za-z0-9_ .]+)\s+import\s+/gm)) deps.add(match[1]!.trim());
    for (const match of content.matchAll(/^\s*import\s+([A-Za-z0-9_., ]+)/gm)) {
      for (const part of match[1]!.split(",")) deps.add(part.trim().split(/\s+as\s+/)[0]!.trim());
    }
  } else if (ext === ".go") {
    for (const match of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) deps.add(match[1]!);
    for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
      for (const match of block[1]!.matchAll(/"([^"]+)"/g)) deps.add(match[1]!);
    }
  } else if (ext === ".rs") {
    for (const match of content.matchAll(/^\s*(?:pub\s+)?(?:use|mod)\s+([A-Za-z0-9_:]+)/gm)) deps.add(match[1]!);
  } else if ([".java", ".kt", ".kts"].includes(ext)) {
    for (const match of content.matchAll(/^\s*import\s+([A-Za-z0-9_.*]+)\s*;?/gm)) deps.add(match[1]!);
  } else if (ext === ".swift") {
    for (const match of content.matchAll(/^\s*import\s+([A-Za-z0-9_]+)/gm)) deps.add(match[1]!);
  }
  return [...deps].filter(Boolean);
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function resolveInternal(
  root: string,
  fromRel: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = specifier.startsWith("/")
    ? specifier.slice(1)
    : normalize(`${dirname(fromRel)}/${specifier}`).replaceAll("\\", "/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ].map((candidate) => normalize(candidate).replaceAll("\\", "/"));
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  const absolute = resolve(root, base);
  const rel = normalize(absolute.slice(root.length + 1)).replaceAll("\\", "/");
  return fileSet.has(rel) ? rel : null;
}

function topCounts(values: string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
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
      toolName: "dependency_graph",
      action: "fs.read",
    });
    if (!resolved.ok) return resolved;
    projectRoot = resolved.path;
  }
  const maxFiles = clamp(args.max_files, 500, 2_000);
  const maxEdges = clamp(args.max_edges, 200, 1_000);
  try {
    const index = buildWorkspaceFileIndex(projectRoot);
    const fileSet = new Set(index.files.map((file) => normalize(file).replaceAll("\\", "/")));
    const edges: Edge[] = [];
    const unresolvedInternal: string[] = [];
    const external: string[] = [];
    for (const rel of index.files.filter((file) => SUPPORTED_EXTENSIONS.has(extname(file).toLowerCase())).slice(0, maxFiles)) {
      const absolute = resolve(index.root, rel);
      const content = readSmall(absolute);
      if (content === null) continue;
      for (const specifier of extractDependencies(absolute, content)) {
        const internal = resolveInternal(index.root, rel, specifier, fileSet);
        if (internal) {
          edges.push({ from: rel, to: internal, kind: "internal" });
        } else if (specifier.startsWith(".")) {
          unresolvedInternal.push(`${rel} -> ${specifier}`);
        } else {
          const pkg = packageName(specifier);
          external.push(pkg);
          edges.push({ from: rel, to: pkg, kind: "external" });
        }
        if (edges.length >= maxEdges) break;
      }
      if (edges.length >= maxEdges) break;
    }
    const internalEdges = edges.filter((edge) => edge.kind === "internal");
    const externalEdges = edges.filter((edge) => edge.kind === "external");
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "analysis",
      status: "completed",
      title: "Dependency graph",
      message: `${internalEdges.length} internal edge(s), ${externalEdges.length} external edge(s)`,
      payload: {
        root: index.root,
        source: index.source,
        internalEdges: internalEdges.length,
        externalEdges: externalEdges.length,
      },
    });
    return [
      `Dependency graph for ${index.root}`,
      `Index source: ${index.source}`,
      `Scanned files: ${Math.min(maxFiles, index.files.length)}`,
      `Edges shown: ${edges.length}${edges.length >= maxEdges ? " (truncated)" : ""}`,
      "",
      "Top external packages/modules:",
      ...(topCounts(external, 40).length ? topCounts(external, 40).map(([name, count]) => `- ${name}: ${count}`) : ["- (none detected)"]),
      "",
      "Internal edges:",
      ...(internalEdges.length ? internalEdges.slice(0, maxEdges).map((edge) => `- ${edge.from} -> ${edge.to}`) : ["- (none detected)"]),
      "",
      "Unresolved relative imports:",
      ...(unresolvedInternal.length ? unresolvedInternal.slice(0, 40).map((edge) => `- ${edge}`) : ["- (none)"]),
    ].join("\n");
  } catch (error) {
    return {
      output: `dependency_graph failed for ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

export const dependencyGraphTool: ExecutableToolDefinition = buildTool({
  name: "dependency_graph",
  description: "Builds a bounded import/dependency graph for the current workspace. Use with code_map before large refactors or when tracing coupling.",
  params: {
    path: {
      type: "string",
      description: "Optional workspace root. Defaults to the active project/worktree root.",
      optional: true,
    },
    max_files: {
      type: "number",
      description: "Maximum source files to scan. Defaults to 500, capped at 2000.",
      optional: true,
    },
    max_edges: {
      type: "number",
      description: "Maximum dependency edges to show. Defaults to 200, capped at 1000.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
