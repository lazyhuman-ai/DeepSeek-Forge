import { createReadStream, statSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { readTextFile } from "../text-file-io.js";
import { notifyWorkspaceFileTouched } from "./workspace-file-hooks.js";

const MAX_LINES = 2000;
const MAX_SIZE_BYTES = 256 * 1024;
const MAX_STREAMED_LINES = 2000;
const MAX_NOTEBOOK_SUMMARY_BYTES = 2 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".class",
  ".o", ".obj", ".wasm", ".pyc", ".pyo", ".gz", ".tar", ".zip",
  ".7z", ".rar", ".bz2", ".xz", ".zst", ".br", ".lz4",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2",
  ".db", ".sqlite", ".sqlite3",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/random",
  "/dev/urandom",
  "/dev/zero",
  "/dev/full",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/console",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
  "/proc/kcore",
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

function fileExtension(filePath: string): string {
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index).toLowerCase() : "";
}

function toolError(output: string): { output: string; isError: true } {
  return { output, isError: true };
}

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  if (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"))
  ) {
    return true;
  }
  return false;
}

function readUInt16LE(buffer: Buffer, offset: number): number | undefined {
  return buffer.length >= offset + 2 ? buffer.readUInt16LE(offset) : undefined;
}

function readUInt32BE(buffer: Buffer, offset: number): number | undefined {
  return buffer.length >= offset + 4 ? buffer.readUInt32BE(offset) : undefined;
}

function imageDimensions(filePath: string): { width?: number; height?: number; format: string } {
  const buffer = readFileSync(filePath, { flag: "r" }).subarray(0, 512);
  const ext = fileExtension(filePath);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const dims: { width?: number; height?: number; format: string } = { format: "PNG" };
    const width = readUInt32BE(buffer, 16);
    const height = readUInt32BE(buffer, 20);
    if (width !== undefined) dims.width = width;
    if (height !== undefined) dims.height = height;
    return dims;
  }
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length >= 10 && (gifHeader === "GIF87a" || gifHeader === "GIF89a")) {
    const dims: { width?: number; height?: number; format: string } = { format: "GIF" };
    const width = readUInt16LE(buffer, 6);
    const height = readUInt16LE(buffer, 8);
    if (width !== undefined) dims.width = width;
    if (height !== undefined) dims.height = height;
    return dims;
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { format: "WebP" };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
        return {
          format: "JPEG",
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (!Number.isFinite(size) || size < 2) break;
      offset += 2 + size;
    }
    return { format: "JPEG" };
  }
  return { format: ext ? ext.slice(1).toUpperCase() : "image" };
}

function describeImage(filePath: string, sizeBytes: number): string {
  try {
    const dims = imageDimensions(filePath);
    const size = dims.width && dims.height ? `${dims.width}x${dims.height}` : "dimensions unavailable";
    return [
      `[Image file: ${filePath}]`,
      `Format: ${dims.format}`,
      `Size: ${sizeBytes} bytes`,
      `Dimensions: ${size}`,
      "This is not text, so read_file returns metadata instead of binary bytes.",
      "Recovery: inspect the image in the Web Console preview/browser, or ask the user what visual detail matters if model vision is required.",
    ].join("\n");
  } catch (error) {
    return [
      `[Image file: ${filePath}]`,
      `Size: ${sizeBytes} bytes`,
      "This is not text, so read_file returns metadata instead of binary bytes.",
      `Image metadata error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n");
  }
}

function describePdf(filePath: string, sizeBytes: number): string {
  const buffer = readFileSync(filePath, { flag: "r" });
  const head = buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024)).toString("latin1");
  const version = head.match(/%PDF-([0-9.]+)/)?.[1] ?? "unknown";
  const pageCount = new Set([...head.matchAll(/(\d+)\s+\d+\s+obj\s*<<[^>]*\/Type\s*\/Page\b/g)].map((match) => match[1])).size
    || [...head.matchAll(/\/Type\s*\/Page\b/g)].length;
  return [
    `[PDF file: ${filePath}]`,
    `PDF version: ${version}`,
    `Size: ${sizeBytes} bytes`,
    `Approximate pages: ${pageCount || "unknown"}`,
    "This is not plain text, so read_file returns document metadata instead of raw PDF bytes.",
    "Recovery: use a PDF/document extraction tool or open the file in the Web Console preview when page text or visual layout is needed.",
  ].join("\n");
}

async function readLargeTextRange(filePath: string, startLine: number, limit: number): Promise<{ text: string; endLine: number; hasMore: boolean }> {
  const effectiveLimit = Math.max(1, Math.min(Math.floor(limit), MAX_STREAMED_LINES));
  const start = Math.max(1, Math.floor(startLine));
  const end = start + effectiveLimit - 1;
  const collected: string[] = [];
  let lineNo = 1;
  let carry = "";
  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    const text = carry + chunk;
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (lineNo >= start && lineNo <= end) collected.push(line);
      lineNo++;
      if (lineNo > end + 1) {
        return {
          text: collected.join("\n"),
          endLine: Math.min(end, lineNo - 1),
          hasMore: true,
        };
      }
    }
  }
  if (carry || lineNo >= start) {
    if (lineNo >= start && lineNo <= end) collected.push(carry);
  }
  return {
    text: collected.join("\n"),
    endLine: Math.min(end, lineNo),
    hasMore: false,
  };
}

function summarizeNotebook(filePath: string, sizeBytes: number): string | { output: string; isError: true } {
  if (sizeBytes > MAX_NOTEBOOK_SUMMARY_BYTES) {
    return toolError([
      "Notebook is too large for read_file notebook summary.",
      `Path: ${filePath}`,
      `Size: ${sizeBytes} bytes`,
      `Limit: ${MAX_NOTEBOOK_SUMMARY_BYTES} bytes`,
      "Recovery: use a notebook-specific tool, grep for specific symbols, or ask the user which cells matter.",
    ].join("\n"));
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
    const preview = cells.slice(0, 20).map((cell, index) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
      const oneLine = source.replace(/\s+/g, " ").trim();
      return `- cell ${index + 1} ${cell.cell_type ?? "unknown"}: ${oneLine.slice(0, 180)}${oneLine.length > 180 ? "..." : ""}`;
    });
    return [
      `[Jupyter notebook: ${filePath}]`,
      `Size: ${sizeBytes} bytes`,
      `Cells: ${cells.length}`,
      preview.length > 0 ? "Cell preview:" : "No cells found.",
      ...preview,
      cells.length > preview.length ? `... ${cells.length - preview.length} more cell(s) omitted.` : "",
      "Recovery: use a notebook-specific editor for structural edits; read_file summarizes notebooks to avoid unsafe raw JSON editing.",
    ].filter(Boolean).join("\n");
  } catch (error) {
    return toolError([
      "Failed to parse Jupyter notebook JSON.",
      `Path: ${filePath}`,
      `Reason: ${error instanceof Error ? error.message : String(error)}`,
      "Recovery: inspect the file as text only if you are sure it is valid JSON, or use a notebook-specific tool.",
    ].join("\n"));
  }
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
  sessionId: string,
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
  const readFileState = readFileStateForContext(context);
  const offset = (args.offset as number) ?? 1;
  const limit = args.limit as number | undefined;
  const hasExplicitRange = typeof args.offset === "number" || typeof args.limit === "number";

  if (isBlockedDevicePath(filePath)) {
    return {
      output: [
        "Tool sandbox blocked special device file read.",
        "Tool: read_file",
        "Requested action: fs.read",
        `Requested path: ${filePath}`,
        "Reason: This path is a special device or kernel pseudo-file that can block forever, stream unbounded bytes, or expose unsafe system memory.",
        "Recovery: Read a normal project file, or ask the user for the specific data you need.",
      ].join("\n"),
      isError: true,
    };
  }

  if (!existsSync(filePath)) {
    const suggestion = suggestSimilar(filePath);
    return toolError(`File does not exist: ${filePath}.${suggestion}\nRecovery: check the path with glob, or read the suggested file if it is correct.`);
  }

  const stat = statSync(filePath);

  if (stat.isDirectory()) {
    return toolError(`Cannot read '${filePath}': it is a directory.\nRecovery: use glob to list files, or read a specific file inside this directory.`);
  }

  const ext = fileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    return describeImage(filePath, stat.size);
  }
  if (ext === ".pdf") {
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    return describePdf(filePath, stat.size);
  }
  if (ext === ".ipynb") {
    if (stat.size <= MAX_NOTEBOOK_SUMMARY_BYTES) {
      const notebookText = readTextFile(filePath);
      readFileState.set(filePath, {
        content: notebookText.content,
        mtimeMs: Math.floor(stat.mtimeMs),
        encoding: notebookText.encoding,
        hadBom: notebookText.hadBom,
        lineEnding: notebookText.lineEnding,
      });
    }
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    return summarizeNotebook(filePath, stat.size);
  }

  if (stat.size === 0) {
    const textFile = readTextFile(filePath);
    const nextState: Parameters<typeof readFileState.set>[1] = {
      content: "",
      mtimeMs: Math.floor(stat.mtimeMs),
      encoding: textFile.encoding,
      hadBom: textFile.hadBom,
      lineEnding: textFile.lineEnding,
      offset,
      isPartialView: offset > 1 || limit !== undefined,
    };
    if (limit !== undefined) nextState.limit = limit;
    readFileState.set(filePath, nextState);
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    return "<system-reminder>This file exists but is empty.</system-reminder>";
  }

  if (isBinaryByExtension(filePath)) {
    return toolError(`This tool cannot read binary files. The file appears to be a binary ${ext || "unknown"} file.\nRecovery: use a domain-specific reader, artifact preview, or ask the user which content from this file is needed.`);
  }

  if (stat.size > MAX_SIZE_BYTES) {
    if (!hasExplicitRange) {
      return toolError([
        "File exceeds maximum allowed size for a full read.",
        `Path: ${filePath}`,
        `Size: ${stat.size} bytes`,
        `Maximum full-read size: ${MAX_SIZE_BYTES} bytes`,
        "Recovery: use grep/file_search to find relevant sections, or call read_file again with offset and limit to stream a bounded line range.",
      ].join("\n"));
    }
    const effectiveLimit = Math.min(limit ?? MAX_STREAMED_LINES, MAX_STREAMED_LINES);
    const range = await readLargeTextRange(filePath, offset, effectiveLimit);
    const mtimeMs = Math.floor(stat.mtimeMs);
    readFileState.set(filePath, {
      content: "",
      mtimeMs,
      offset,
      limit: effectiveLimit,
      isPartialView: true,
    });
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    const numbered = addLineNumbers(range.text, offset);
    const reminder = range.hasMore
      ? `\n<system-reminder>Large file streamed in partial mode. Showing lines ${offset}-${range.endLine}. Read the next ${effectiveLimit} lines using offset=${range.endLine + 1} and limit=${effectiveLimit}. Partial large-file reads do not satisfy read-before-edit; use targeted edit tools only after reading the full file or a smaller extracted file.</system-reminder>`
      : "\n<system-reminder>Large file streamed in partial mode. Partial large-file reads do not satisfy read-before-edit; use grep or split the file before editing.</system-reminder>";
    return `${numbered || "(no lines in requested range)"}${reminder}${CYBER_REMINDER}`;
  }

  const textFile = readTextFile(filePath);
  const content = textFile.content;
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
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
    return "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
  }

  const effectiveLimit = limit ?? MAX_LINES;
  const startLine = offset;

  if (startLine > lines.length) {
    const isPartialView = offset > 1 || limit !== undefined;
    const nextState: Parameters<typeof readFileState.set>[1] = {
      content,
      mtimeMs,
      encoding: textFile.encoding,
      hadBom: textFile.hadBom,
      lineEnding: textFile.lineEnding,
      offset: startLine,
      isPartialView,
    };
    nextState.limit = effectiveLimit;
    readFileState.set(filePath, nextState);
    await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");
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
    encoding: textFile.encoding,
    hadBom: textFile.hadBom,
    lineEnding: textFile.lineEnding,
    offset,
    isPartialView,
  };
  if (limit !== undefined) nextState.limit = limit;
  readFileState.set(filePath, nextState);
  await notifyWorkspaceFileTouched(sessionId, filePath, context, "read");

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
