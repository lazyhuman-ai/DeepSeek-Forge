import { existsSync, statSync } from "node:fs";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readTextFile, writeTextFile } from "../text-file-io.js";
import { maybeRecordPassiveTypeScriptDiagnostics } from "./passive-diagnostics.js";
import { buildEditCheckpoint } from "./edit-checkpoint.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";

type PatchLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

type PatchHunk = {
  oldStart: number;
  lines: PatchLine[];
};

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseUnifiedPatch(patch: string): PatchHunk[] | string {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line === "") continue;
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      current = { oldStart: Number(hunkMatch[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      return `Patch contains non-hunk content before a hunk header: ${line}`;
    }
    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === " ") current.lines.push({ kind: "context", text });
    else if (prefix === "-") current.lines.push({ kind: "remove", text });
    else if (prefix === "+") current.lines.push({ kind: "add", text });
    else if (line === "\\ No newline at end of file") {
      continue;
    } else {
      return `Unsupported patch line: ${line}`;
    }
  }
  return hunks.length > 0 ? hunks : "Patch contains no hunks.";
}

type ApplyPatchResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

function applyHunks(beforeText: string, hunks: PatchHunk[]): ApplyPatchResult {
  const source = beforeText.length === 0 ? [] : beforeText.split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldIndex = hunk.oldStart - 1;
    if (oldIndex < cursor || oldIndex > source.length) {
      return { ok: false, message: `Patch hunk starts at invalid line ${hunk.oldStart}.` };
    }
    output.push(...source.slice(cursor, oldIndex));
    cursor = oldIndex;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      const actual = source[cursor];
      if (actual !== line.text) {
        return { ok: false, message: `Patch context mismatch at line ${cursor + 1}. Expected: ${line.text} Actual: ${actual ?? "<end of file>"}` };
      }
      if (line.kind === "context") output.push(actual);
      cursor++;
    }
  }
  output.push(...source.slice(cursor));
  return { ok: true, content: output.join("\n") };
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "write",
    toolName: "apply_patch_file",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const patch = typeof args.patch === "string" ? args.patch : "";
  if (!patch.trim()) return { output: "patch is required.", isError: true };
  if (!existsSync(filePath)) return { output: `File does not exist: ${filePath}.`, isError: true };

  const readFileState = readFileStateForContext(context);
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return { output: "File has not been read yet. Read it first before patching.", isError: true };
  }
  const fileText = readTextFile(filePath);
  const beforeContent = fileText.content;
  if (beforeContent !== state.content) {
    return {
      output: "File has been modified since read, either by the user or by a linter. Read it again before attempting to patch.",
      isError: true,
    };
  }

  const parsed = parseUnifiedPatch(patch);
  if (typeof parsed === "string") return { output: parsed, isError: true };
  const applied = applyHunks(beforeContent, parsed);
  if (!applied.ok) return { output: applied.message, isError: true };
  if (applied.content === beforeContent) return { output: "Patch made no changes.", isError: true };

  writeTextFile(filePath, applied.content, {
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });
  readFileState.set(filePath, {
    content: applied.content,
    mtimeMs: Math.floor(statSync(filePath).mtimeMs),
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, beforeContent, applied.content, "updated"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent,
      afterContent: applied.content,
      beforeText: fileText,
    }),
  );
  maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent,
    afterContent: applied.content,
    operation: "updated",
  }, context);
  return `Patch applied: ${filePath}.`;
}

export const applyPatchFileTool: ExecutableToolDefinition = buildTool({
  name: "apply_patch_file",
  description: "Applies a single-file unified patch to a workspace file. The file must have been read in this project/session/branch first.",
  params: {
    file_path: {
      type: "string",
      description: "Absolute path to the file to patch.",
    },
    patch: {
      type: "string",
      description: "Single-file unified patch with @@ hunks.",
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
