import { existsSync, statSync, unlinkSync } from "node:fs";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readTextFile } from "../text-file-io.js";
import { buildEditCheckpoint } from "./edit-checkpoint.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";

function toolError(output: string): { output: string; isError: true } {
  return { output, isError: true };
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "write",
    toolName: "delete_file",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;

  if (!existsSync(filePath)) {
    return toolError(`File does not exist: ${filePath}.`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return toolError([
      "delete_file only deletes ordinary files.",
      `Path: ${filePath}`,
      "Recovery: use dedicated tools for directories, or ask the user before using a shell command for a broader removal.",
    ].join("\n"));
  }

  const readFileState = readFileStateForContext(context);
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return toolError("File has not been read yet. Read it first before deleting so ForgeAgent can record a reversible checkpoint.");
  }

  const fileText = readTextFile(filePath);
  const beforeContent = fileText.content;
  if (beforeContent !== state.content) {
    return toolError("File has been modified since read, either by the user or by a linter. Read it again before attempting to delete it.");
  }

  unlinkSync(filePath);
  readFileState.delete(filePath);
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, beforeContent, "", "deleted"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent,
      afterContent: "",
      beforeText: fileText,
    }),
  );
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent,
    afterContent: "",
    operation: "deleted",
  }, context);

  return `File deleted: ${filePath}. Use revert_file_change if this deletion should be undone.`;
}

export const deleteFileTool: ExecutableToolDefinition = buildTool({
  name: "delete_file",
  description: "Deletes a workspace file after it has been read in the current project/session/branch, recording a reversible diff checkpoint. Prefer this over shell rm.",
  params: {
    file_path: {
      type: "string",
      description: "Absolute path to the file to delete.",
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
