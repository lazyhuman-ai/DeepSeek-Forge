import { existsSync, statSync } from "node:fs";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileStateForContext } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readTextFile, writeTextFile } from "../text-file-io.js";
import { maybeRecordPassiveTypeScriptDiagnostics } from "./passive-diagnostics.js";
import { buildEditCheckpoint } from "./edit-checkpoint.js";
import { findActualString, preserveQuoteStyle } from "./edit-string-utils.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

type EditInstruction = {
  oldString: string;
  newString: string;
  replaceAll: boolean;
};

function parseEdits(value: unknown): EditInstruction[] | string {
  if (!Array.isArray(value) || value.length === 0) return "edits must be a non-empty array.";
  const edits: EditInstruction[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `edits[${index}] must be an object.`;
    const item = raw as Record<string, unknown>;
    const oldString = typeof item.old_string === "string" ? item.old_string : "";
    const newString = typeof item.new_string === "string" ? item.new_string : "";
    if (!oldString) return `edits[${index}].old_string is required.`;
    if (oldString === newString) return `edits[${index}] is a no-op: old_string and new_string are identical.`;
    edits.push({
      oldString,
      newString,
      replaceAll: item.replace_all === true,
    });
  }
  return edits;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "write",
    toolName: "multi_edit_file",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const parsed = parseEdits(args.edits);
  if (typeof parsed === "string") return { output: parsed, isError: true };

  if (!existsSync(filePath)) return { output: `File does not exist: ${filePath}.`, isError: true };
  const stat = statSync(filePath);
  if (stat.size > MAX_EDIT_FILE_SIZE) {
    return { output: `File is too large to edit (${stat.size} bytes).`, isError: true };
  }

  const readFileState = readFileStateForContext(context);
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return { output: "File has not been read yet. Read it first before editing.", isError: true };
  }
  const fileText = readTextFile(filePath);
  const beforeContent = fileText.content;
  if (beforeContent !== state.content) {
    return {
      output: "File has been modified since read, either by the user or by a linter. Read it again before attempting to edit.",
      isError: true,
    };
  }

  let updatedContent = beforeContent;
  let replacements = 0;
  for (let index = 0; index < parsed.length; index++) {
    const edit = parsed[index]!;
    const actualOld = findActualString(updatedContent, edit.oldString);
    if (!actualOld) {
      return { output: `edits[${index}] string to replace not found.\nString: ${edit.oldString}`, isError: true };
    }
    const matches = updatedContent.split(actualOld).length - 1;
    if (matches > 1 && !edit.replaceAll) {
      return {
        output: `edits[${index}] found ${matches} matches but replace_all is false. Provide more context or set replace_all to true.`,
        isError: true,
      };
    }
    const newString = preserveQuoteStyle(edit.oldString, actualOld, edit.newString);
    replacements += edit.replaceAll ? matches : 1;
    updatedContent = edit.replaceAll
      ? updatedContent.replaceAll(actualOld, () => newString)
      : updatedContent.replace(actualOld, () => newString);
  }

  if (updatedContent === beforeContent) {
    return { output: "No changes were made to the file.", isError: true };
  }

  writeTextFile(filePath, updatedContent, {
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });
  readFileState.set(filePath, {
    content: updatedContent,
    mtimeMs: Math.floor(statSync(filePath).mtimeMs),
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, beforeContent, updatedContent, "updated"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent,
      afterContent: updatedContent,
      beforeText: fileText,
    }),
  );
  maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent,
    afterContent: updatedContent,
    operation: "updated",
  }, context);

  return `File edited: ${filePath}. Applied ${parsed.length} edit instruction(s), ${replacements} replacement(s).`;
}

export const multiEditFileTool: ExecutableToolDefinition = buildTool({
  name: "multi_edit_file",
  description: "Atomically applies multiple exact string replacements to one file. The file must have been read in the current project/session/branch first.",
  params: {
    file_path: {
      type: "string",
      description: "Absolute path to the file to modify.",
    },
    edits: {
      type: "array",
      description: "Ordered exact replacement instructions.",
      items: {
        type: "object",
        description: "Replacement instruction",
        properties: {
          old_string: { type: "string", description: "Existing text to replace." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace all matches.", optional: true },
        },
      },
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
