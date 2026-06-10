import { basename, dirname, resolve } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { buildWorkspaceFileIndex, matchWorkspaceGlob, sortWorkspaceFilesByMtime } from "../../workspace/file-index.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const MAX_QUERY_CHARS = 80;

type Match = {
  file: string;
  score: number;
  reason: string;
};

function boundedLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\-.]+/g, " ");
}

function fuzzyScore(file: string, query: string): Match | null {
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
  if (!trimmed) {
    return { file, score: 0, reason: "recent" };
  }

  const loweredFile = file.toLowerCase();
  const loweredBase = basename(file).toLowerCase();
  const loweredQuery = trimmed.toLowerCase();
  const normalizedFile = normalize(file);
  const normalizedQuery = normalize(trimmed);

  if (loweredFile === loweredQuery) return { file, score: 10_000, reason: "exact path" };
  if (loweredBase === loweredQuery) return { file, score: 9_000, reason: "exact filename" };
  if (loweredFile.includes(loweredQuery)) {
    const baseBonus = loweredBase.includes(loweredQuery) ? 1_000 : 0;
    return { file, score: 7_000 + baseBonus - loweredFile.indexOf(loweredQuery), reason: "substring" };
  }
  if (normalizedFile.includes(normalizedQuery)) {
    return { file, score: 6_000 - normalizedFile.indexOf(normalizedQuery), reason: "normalized substring" };
  }

  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;
  for (const char of loweredQuery.replace(/\s+/g, "")) {
    const index = loweredFile.indexOf(char, lastIndex + 1);
    if (index === -1) return null;
    if (index === lastIndex + 1) consecutive++;
    else consecutive = 0;
    const boundary = index === 0 || /[/_\-.]/.test(loweredFile[index - 1] ?? "");
    score += 20 + (boundary ? 10 : 0) + consecutive * 5 - Math.min(index - lastIndex, 20);
    lastIndex = index;
  }

  const basenameBonus = loweredBase.includes(loweredQuery[0] ?? "") ? 50 : 0;
  const depthPenalty = file.split("/").length * 2;
  return { file, score: score + basenameBonus - depthPenalty, reason: "fuzzy" };
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query : "";
  const limit = boundedLimit(args.limit);
  const include = typeof args.include === "string" && args.include.trim() ? args.include.trim() : undefined;
  const defaultRoot = context?.projectRoot ?? process.cwd();
  const resolvedPath = resolveToolPath(args.path ? args : { ...args, path: defaultRoot }, context, {
    argName: "path",
    access: "read",
    toolName: "file_search",
    action: "fs.read",
  });
  if (!resolvedPath.ok) return resolvedPath;

  const index = buildWorkspaceFileIndex(resolvedPath.path);
  const candidates = include
    ? index.files.filter((file) => matchWorkspaceGlob(file, include))
    : index.files;
  const matches = candidates
    .map((file) => fuzzyScore(file, query))
    .filter((match): match is Match => match !== null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const selected = matches.length > 0
    ? matches.slice(0, limit)
    : sortWorkspaceFilesByMtime(index.root, candidates).slice(0, limit).map((file) => ({
      file,
      score: 0,
      reason: "recent fallback",
    }));

  if (selected.length === 0) return "No files found.";
  const lines = [
    `File search results for ${query.trim() ? JSON.stringify(query.trim()) : "(recent files)"} in ${index.root}`,
    `Source: ${index.source}. Showing ${selected.length} of ${matches.length || candidates.length} candidate file(s).`,
    "",
    ...selected.map((match, index) => {
      const dir = dirname(match.file);
      const directory = dir === "." ? "" : ` (${dir})`;
      return `${index + 1}. ${match.file}${directory} — ${match.reason}`;
    }),
  ];
  return lines.join("\n");
}

export const fileSearchTool: ExecutableToolDefinition = buildTool({
  name: "file_search",
  description: "Fuzzy-searches file paths in the current project or active worktree. Use this when you know part of a filename or path but not an exact glob.",
  params: {
    query: {
      type: "string",
      description: "Filename/path words or fuzzy characters to search for. Empty query returns recent files.",
      optional: true,
    },
    path: {
      type: "string",
      description: "Directory to search in. Defaults to the current project/worktree root.",
      optional: true,
    },
    include: {
      type: "string",
      description: "Optional glob filter, e.g. **/*.ts or src/**/*.tsx.",
      optional: true,
    },
    limit: {
      type: "number",
      description: `Maximum result count, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
