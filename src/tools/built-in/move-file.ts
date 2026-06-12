import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext, type FileState } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { readTextFile, type TextFileRead } from "../text-file-io.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { buildEditCheckpoint } from "./edit-checkpoint.js";
import { notifyWorkspaceFileChanged, notifyWorkspaceFileTouched } from "./workspace-file-hooks.js";

function toolError(output: string): { output: string; isError: true } {
  return { output, isError: true };
}

function assertFreshRead(
  filePath: string,
  state: FileState | undefined,
  role: "source" | "destination",
): { ok: true; text: TextFileRead } | { ok: false; output: string } {
  if (!state || state.isPartialView) {
    return {
      ok: false,
      output: `${role === "source" ? "Source" : "Destination"} file has not been fully read yet. Read it first before moving so DeepSeek-Forge can detect stale content and record a reversible checkpoint.`,
    };
  }
  const text = readTextFile(filePath);
  if (text.content !== state.content) {
    return {
      ok: false,
      output: `${role === "source" ? "Source" : "Destination"} file has been modified since read, either by the user or by another tool. Read it again before attempting to move or overwrite it.`,
    };
  }
  return { ok: true, text };
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const from = resolveToolPath({ file_path: args.from_path ?? args.old_path ?? args.source_path }, context, {
    argName: "file_path",
    access: "read",
    toolName: "move_file",
    action: "fs.read",
  });
  if (!from.ok) return from;
  const to = resolveToolPath({ file_path: args.to_path ?? args.new_path ?? args.destination_path }, context, {
    argName: "file_path",
    access: "write",
    toolName: "move_file",
    action: "fs.write",
  });
  if (!to.ok) return to;

  if (from.path === to.path) {
    return toolError([
      "move_file made no changes because source and destination are the same path.",
      `Path: ${from.path}`,
      "Recovery: choose a different destination path.",
    ].join("\n"));
  }

  if (!existsSync(from.path)) {
    return toolError(`Source path does not exist: ${from.path}`);
  }

  const sourceStat = statSync(from.path);
  const destinationExists = existsSync(to.path);
  if (destinationExists && args.overwrite !== true) {
    return toolError([
      "Destination already exists.",
      `Source: ${from.path}`,
      `Destination: ${to.path}`,
      "Recovery: choose a different destination or call move_file with overwrite=true after confirming replacement is intended.",
    ].join("\n"));
  }
  if (sourceStat.isDirectory()) {
    if (destinationExists) {
      return toolError([
        "move_file will not overwrite an existing destination with a directory move.",
        `Source: ${from.path}`,
        `Destination: ${to.path}`,
        "Recovery: choose an empty destination, or ask the user before using shell commands for a broader directory replacement.",
      ].join("\n"));
    }
    mkdirSync(dirname(to.path), { recursive: true });
    renameSync(from.path, to.path);
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "change",
      status: "completed",
      title: "Directory moved",
      message: `Directory moved from ${from.path} to ${to.path}`,
      payload: { fromPath: from.path, toPath: to.path },
    });
    return [
      "Directory moved.",
      `From: ${from.path}`,
      `To: ${to.path}`,
      "No file-level diff was recorded because the source was a directory; inspect git_diff or workspace_review before finalizing.",
    ].join("\n");
  }
  if (!sourceStat.isFile()) {
    return toolError([
      "move_file only moves ordinary files or directories.",
      `Source: ${from.path}`,
      "Recovery: use a dedicated tool or ask the user before using shell commands for special files.",
    ].join("\n"));
  }

  const readFileState = readFileStateForContext(context);
  const sourceFresh = assertFreshRead(from.path, readFileState.get(from.path), "source");
  if (!sourceFresh.ok) return toolError(sourceFresh.output);
  const beforeText = sourceFresh.text;
  const beforeContent = beforeText.content;
  let destinationBefore: string | null = null;
  let destinationText: TextFileRead | undefined;
  if (destinationExists) {
    const destinationStat = statSync(to.path);
    if (!destinationStat.isFile()) {
      return toolError([
        "Destination exists but is not an ordinary file.",
        `Destination: ${to.path}`,
        "Recovery: choose another destination, or ask the user before using shell commands for a broader replacement.",
      ].join("\n"));
    }
    const destinationFresh = assertFreshRead(to.path, readFileState.get(to.path), "destination");
    if (!destinationFresh.ok) return toolError(destinationFresh.output);
    destinationText = destinationFresh.text;
    destinationBefore = destinationText.content;
  }
  mkdirSync(dirname(to.path), { recursive: true });
  renameSync(from.path, to.path);
  const afterContent = beforeContent;

  readFileState.delete(from.path);
  readFileState.set(to.path, {
    content: afterContent,
    mtimeMs: Math.floor(statSync(to.path).mtimeMs),
    encoding: beforeText.encoding,
    hadBom: beforeText.hadBom,
    lineEnding: beforeText.lineEnding,
  });

  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(from.path, beforeContent, "", "deleted"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent,
      afterContent: "",
      beforeText,
    }),
  );
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(to.path, destinationBefore ?? "", afterContent, destinationBefore === null ? "created" : "updated"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: destinationBefore !== null,
      beforeContent: destinationBefore ?? "",
      afterContent,
      ...(destinationText !== undefined ? { beforeText: destinationText } : {}),
    }),
  );

  await notifyWorkspaceFileChanged(sessionId, {
    filePath: from.path,
    beforeContent,
    afterContent: "",
    operation: "deleted",
  }, context);
  await notifyWorkspaceFileChanged(sessionId, {
    filePath: to.path,
    beforeContent: destinationBefore,
    afterContent,
    operation: destinationBefore === null ? "created" : "updated",
  }, context);
  await notifyWorkspaceFileTouched(sessionId, to.path, context, "edit");

  return [
    "File moved.",
    `From: ${from.path}`,
    `To: ${to.path}`,
  ].join("\n");
}

export const moveFileTool: ExecutableToolDefinition = buildTool({
  name: "move_file",
  description: "Moves or renames a file or directory inside the workspace while recording durable diff/activity evidence. Prefer this over shell mv so DeepSeek-Forge can review and recover from changes.",
  params: {
    from_path: {
      type: "string",
      description: "Absolute source path to move or rename.",
    },
    to_path: {
      type: "string",
      description: "Absolute destination path.",
    },
    overwrite: {
      type: "boolean",
      description: "Overwrite an existing destination. Defaults to false.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.read", "fs.write"],
});
