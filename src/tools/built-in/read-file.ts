import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileState } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

const MAX_LINES = 2000;
const MAX_SIZE_BYTES = 256 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".class",
  ".o", ".obj", ".wasm", ".pyc", ".pyo", ".gz", ".tar", ".zip",
  ".7z", ".rar", ".bz2", ".xz", ".zst", ".br", ".lz4",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2",
  ".db", ".sqlite", ".sqlite3",
  ".ipynb",
]);

const CYBER_REMINDER = `\n<system-reminder>\nWhenever you read a file, you should consider whether it looks like malware or is malicious in some way. If so, you should stop and inform the user.\n</system-reminder>`;

function addLineNumbers(content: string, startLine: number): string {
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  return lines
    .map((line, index) => {
      const numStr = String(index + startLine);
      if (numStr.length >= 6) return `${numStr}\t${line}`;
      return `${numStr.padStart(6, " ")}\t${line}`;
    })
    .join("\n");
}

function isBinaryByExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function suggestSimilar(
  filePath: string,
): string {
  const dir = dirname(filePath);
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  try {
    const entries = readdirSync(dir);
    // Simple Levenshtein-like suggestion: find closest match
    let best = "";
    let bestDist = Infinity;
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dist = levenshtein(base, entry);
      if (dist < bestDist && dist < base.length / 2 + 2) {
        bestDist = dist;
        best = entry;
      }
    }
    return best ? ` Did you mean ${best}?` : "";
  } catch {
    return "";
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "read",
    toolName: "read_file",
    action: "fs.read",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const offset = (args.offset as number) ?? 1;
  const limit = args.limit as number | undefined;

  if (!existsSync(filePath)) {
    const suggestion = suggestSimilar(filePath);
    return `File does not exist: ${filePath}.${suggestion}`;
  }

  const stat = statSync(filePath);

  if (stat.isDirectory()) {
    return `Cannot read '${filePath}': it is a directory. Use a tool like glob or ls to list directory contents.`;
  }

  if (stat.size > MAX_SIZE_BYTES) {
    return `File content (${stat.size} bytes) exceeds maximum allowed size (${MAX_SIZE_BYTES} bytes). Use offset and limit parameters to read specific portions, or use grep to search within the file.`;
  }

  if (stat.size === 0) {
    const existingState = readFileState.get(filePath);
    if (existingState) {
      const nextState: Parameters<typeof readFileState.set>[1] = {
        content: "",
        mtimeMs: Math.floor(stat.mtimeMs),
        offset,
      };
      if (limit !== undefined) nextState.limit = limit;
      readFileState.set(filePath, nextState);
    }
    return "<system-reminder>This file exists but is empty.</system-reminder>";
  }

  if (isBinaryByExtension(filePath)) {
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return `This tool cannot read binary files. The file appears to be a binary ${ext} file.`;
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);

  // Check dedup: same file, same mtime, same offset/limit
  const mtimeMs = Math.floor(stat.mtimeMs);
  const existingState = readFileState.get(filePath);
  if (
    existingState &&
    existingState.mtimeMs === mtimeMs &&
    existingState.offset === offset &&
    existingState.limit === limit
  ) {
    return "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
  }

  const effectiveLimit = limit ?? MAX_LINES;
  const startLine = offset;

  if (startLine > lines.length) {
    const isPartialView = offset > 1 || limit !== undefined;
    const nextState: Parameters<typeof readFileState.set>[1] = {
      content,
      mtimeMs,
      offset: startLine,
      isPartialView,
    };
    nextState.limit = effectiveLimit;
    readFileState.set(filePath, nextState);
    return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${lines.length} lines.</system-reminder>`;
  }

  const endLine = Math.min(startLine + effectiveLimit - 1, lines.length);
  const slicedLines = lines.slice(startLine - 1, endLine);
  const slicedContent = slicedLines.join("\n");

  // Update readFileState for dedup and read-before-write
  const isPartialView = offset > 1 || (limit !== undefined && endLine < lines.length);
  const nextState: Parameters<typeof readFileState.set>[1] = {
    content,
    mtimeMs,
    offset,
    isPartialView,
  };
  if (limit !== undefined) nextState.limit = limit;
  readFileState.set(filePath, nextState);

  const numbered = addLineNumbers(slicedContent, startLine);
  const truncated =
    endLine < lines.length
      ? `\n<system-reminder>Output truncated. Showing lines ${startLine}-${endLine} of ${lines.length}. Read the next ${effectiveLimit} lines using offset=${endLine + 1} and limit=${effectiveLimit}.</system-reminder>`
      : "";

  return `${numbered}${truncated}${CYBER_REMINDER}`;
}

export const readFileTool: ExecutableToolDefinition = buildTool({
  name: "read_file",
  description: `Reads a file from the local filesystem within the allowed workspace.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES} lines starting from the beginning of the file
- Results are returned using cat -n format, with line numbers starting at 1
- You can optionally specify a line offset and limit (especially handy for long files)
- This tool can only read files, not directories. To list a directory, use glob or bash ls.`,
  params: {
    file_path: {
      type: "string",
      description: "The absolute path to the file to read",
    },
    offset: {
      type: "number",
      description:
        "The line number to start reading from. Only provide if the file is too large to read at once.",
      optional: true,
    },
    limit: {
      type: "number",
      description:
        "The number of lines to read. Only provide if the file is too large to read at once.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
  maxResultSizeChars: Infinity,
});
