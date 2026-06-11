import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readTextFile, writeTextFile } from "../text-file-io.js";
import { maybeRecordPassiveTypeScriptDiagnostics } from "./passive-diagnostics.js";
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
    toolName: "write_file",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const readFileState = readFileStateForContext(context);
  const content = String(args.content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const fileExists = existsSync(filePath);
  const existingText = fileExists ? readTextFile(filePath) : undefined;
  const beforeContent = existingText?.content ?? "";

  if (fileExists) {
    const state = readFileState.get(filePath);
    if (!state || state.isPartialView) {
      return toolError("File has not been read yet. Read it first before writing to it.");
    }
    const currentContent = readTextFile(filePath).content;
    if (currentContent !== state.content) {
      return toolError("File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.");
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // TOCTOU re-check after mkdir
  if (fileExists) {
    const state = readFileState.get(filePath);
    if (state) {
      const currentContent = readTextFile(filePath).content;
      if (currentContent !== state.content) {
        return toolError("File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.");
      }
    }
  }

  const state = readFileState.get(filePath);
  writeTextFile(filePath, content, {
    encoding: state?.encoding ?? existingText?.encoding ?? "utf8",
    hadBom: state?.hadBom ?? existingText?.hadBom ?? false,
    lineEnding: state?.lineEnding ?? existingText?.lineEnding ?? "\n",
  });

  const newMtime = Math.floor(statSync(filePath).mtimeMs);
  readFileState.set(filePath, {
    content,
    mtimeMs: newMtime,
    encoding: state?.encoding ?? existingText?.encoding ?? "utf8",
    hadBom: state?.hadBom ?? existingText?.hadBom ?? false,
    lineEnding: state?.lineEnding ?? existingText?.lineEnding ?? "\n",
  });

  const operation = fileExists ? "updated" : "created";
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, beforeContent, content, operation),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: fileExists,
      beforeContent,
      afterContent: content,
      ...(existingText !== undefined ? { beforeText: existingText } : {}),
    }),
  );
  maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent: fileExists ? beforeContent : null,
    afterContent: content,
    operation,
  }, context);

  if (fileExists) {
    return `File updated: ${filePath}`;
  }
  return `File created: ${filePath}`;
}

export const writeFileTool: ExecutableToolDefinition = buildTool({
  name: "write_file",
  description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read_file tool first to read the file's contents.
- ALWAYS prefer the edit_file tool for modifying existing files — it only sends the diff.
- Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.`,
  params: {
    file_path: {
      type: "string",
      description: "The absolute path to the file to write (must be absolute, not relative)",
    },
    content: {
      type: "string",
      description: "The content to write to the file",
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
