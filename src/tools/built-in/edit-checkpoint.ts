import { createHash } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { DiffEvent, EditCheckpoint } from "../../streams/event-types.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readFileStateForContext } from "../read-file-state.js";
import type { LineEnding, TextEncoding, TextFileRead } from "../text-file-io.js";
import { readTextFile, writeTextFile } from "../text-file-io.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath } from "./path-helper.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";

const MAX_CHECKPOINT_CONTENT_BYTES = 512 * 1024;

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildEditCheckpoint(input: {
  beforeExists: boolean;
  beforeContent: string;
  afterContent: string;
  beforeText?: TextFileRead;
}): EditCheckpoint {
  const checkpoint: EditCheckpoint = {
    kind: "file_snapshot",
    beforeExists: input.beforeExists,
    afterHash: contentHash(input.afterContent),
  };
  const beforeBytes = Buffer.byteLength(input.beforeContent, "utf8");
  if (input.beforeExists && beforeBytes > MAX_CHECKPOINT_CONTENT_BYTES) {
    checkpoint.snapshotSkipped = true;
    checkpoint.skipReason = `Previous content was ${beforeBytes} bytes, above checkpoint limit ${MAX_CHECKPOINT_CONTENT_BYTES}.`;
    return checkpoint;
  }
  if (input.beforeExists) checkpoint.previousContent = input.beforeContent;
  if (input.beforeText?.encoding !== undefined) checkpoint.previousEncoding = input.beforeText.encoding;
  if (input.beforeText?.hadBom !== undefined) checkpoint.previousHadBom = input.beforeText.hadBom;
  if (input.beforeText?.lineEnding !== undefined) checkpoint.previousLineEnding = input.beforeText.lineEnding;
  return checkpoint;
}

function latestCheckpoint(
  events: DiffEvent[],
  filePath: string,
): DiffEvent | undefined {
  return [...events].reverse().find((event) => event.filePath === filePath && event.checkpoint !== undefined);
}

function asEncoding(value: unknown): TextEncoding | undefined {
  return value === "utf8" || value === "utf16le" ? value : undefined;
}

function asLineEnding(value: unknown): LineEnding | undefined {
  return value === "\n" || value === "\r\n" ? value : undefined;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "write",
    toolName: "revert_file_change",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const force = args.force === true;
  const events = (context?.readThread?.(sessionId) ?? []).filter((event): event is DiffEvent => event.type === "diff_event");
  const latest = latestCheckpoint(events, filePath);
  if (!latest?.checkpoint) {
    return {
      output: `No reversible edit checkpoint found for ${filePath} in this session branch.\nRecovery: inspect git_diff or the file history outside ForgeAgent, then apply an explicit edit if needed.`,
      isError: true,
    };
  }
  const checkpoint = latest.checkpoint;
  if (checkpoint.snapshotSkipped) {
    return {
      output: [
        `Latest checkpoint for ${filePath} cannot be reverted automatically.`,
        `Reason: ${checkpoint.skipReason ?? "previous content was not saved"}`,
        "Recovery: use git_diff, version control, or an explicit edit to restore the file.",
      ].join("\n"),
      isError: true,
    };
  }

  const exists = existsSync(filePath);
  const currentText = exists ? readTextFile(filePath) : undefined;
  const currentContent = currentText?.content ?? "";
  if (exists && !force && contentHash(currentContent) !== checkpoint.afterHash) {
    return {
      output: [
        "Refusing to revert because the file changed after the checkpoint.",
        `File: ${filePath}`,
        "Recovery: read the file, inspect the latest changes, then retry with force=true only if you intentionally want to discard those newer changes.",
      ].join("\n"),
      isError: true,
    };
  }

  if (!checkpoint.beforeExists) {
    if (exists) unlinkSync(filePath);
    readFileStateForContext(context).delete(filePath);
    context?.workspaceActivity?.recordDiff(
      sessionId,
      buildStructuredDiff(filePath, currentContent, "", "deleted"),
      context?.branchId,
    );
    await notifyWorkspaceFileChanged(sessionId, {
      filePath,
      beforeContent: currentContent,
      afterContent: "",
      operation: "deleted",
    }, context);
    return `Reverted created file by deleting: ${filePath}`;
  }

  const previousContent = checkpoint.previousContent;
  if (previousContent === undefined) {
    return {
      output: `Checkpoint for ${filePath} is missing previous content.\nRecovery: use git_diff, version control, or an explicit edit to restore the file.`,
      isError: true,
    };
  }
  writeTextFile(filePath, previousContent, {
    encoding: asEncoding(checkpoint.previousEncoding) ?? currentText?.encoding ?? "utf8",
    hadBom: checkpoint.previousHadBom ?? currentText?.hadBom ?? false,
    lineEnding: asLineEnding(checkpoint.previousLineEnding) ?? currentText?.lineEnding ?? "\n",
  });
  const newState = {
    content: previousContent,
    mtimeMs: Math.floor(statSync(filePath).mtimeMs),
    encoding: asEncoding(checkpoint.previousEncoding) ?? currentText?.encoding ?? "utf8",
    hadBom: checkpoint.previousHadBom ?? currentText?.hadBom ?? false,
    lineEnding: asLineEnding(checkpoint.previousLineEnding) ?? currentText?.lineEnding ?? "\n",
  };
  readFileStateForContext(context).set(filePath, newState);
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, currentContent, previousContent, "updated"),
    context?.branchId,
  );
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent: currentContent,
    afterContent: previousContent,
    operation: "updated",
  }, context);
  return `Reverted latest ForgeAgent edit checkpoint for: ${filePath}`;
}

export const revertFileChangeTool: ExecutableToolDefinition = buildTool({
  name: "revert_file_change",
  description: "Reverts the latest reversible ForgeAgent edit checkpoint for a workspace file in the current session/branch. Refuses to clobber newer changes unless force=true.",
  params: {
    file_path: {
      type: "string",
      description: "Absolute path to the file to revert.",
    },
    force: {
      type: "boolean",
      description: "Discard newer file changes after the checkpoint. Use only when the user explicitly wants to revert anyway.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
