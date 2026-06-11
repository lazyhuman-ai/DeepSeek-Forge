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
import { findActualString, preserveQuoteStyle } from "./edit-string-utils.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

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
    toolName: "edit_file",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  const readFileState = readFileStateForContext(context);
  const oldString = args.old_string as string;
  let newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  // Error 1: no-op
  if (oldString === newString) {
    return toolError("No changes to make: old_string and new_string are exactly the same.");
  }

  // Empty old_string creates a missing file, and fills an existing empty file.
  // This matches the ergonomic Claude Code behavior while still rejecting
  // accidental overwrites of non-empty files.
  if (!oldString && existsSync(filePath)) {
    if (filePath.endsWith(".ipynb")) {
      return toolError("File is a Jupyter Notebook. Use notebook_edit to edit .ipynb files structurally at the cell level.");
    }
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_EDIT_FILE_SIZE) {
        return toolError(`File is too large to edit (${stat.size} bytes). Maximum editable file size is 1 GiB.`);
      }
    } catch {
      // stat failed, continue anyway
    }
    const existingText = readTextFile(filePath);
    if (existingText.content.length > 0) {
      return toolError("Cannot create new file — file already exists and is not empty. Read it first, then use edit_file with a non-empty old_string or write_file to overwrite.");
    }
    writeTextFile(filePath, newString, {
      encoding: existingText.encoding,
      hadBom: existingText.hadBom,
      lineEnding: existingText.lineEnding,
    });
    readFileState.set(filePath, {
      content: newString,
      mtimeMs: Math.floor(statSync(filePath).mtimeMs),
      encoding: existingText.encoding,
      hadBom: existingText.hadBom,
      lineEnding: existingText.lineEnding,
    });
    context?.workspaceActivity?.recordDiff(
      sessionId,
      buildStructuredDiff(filePath, "", newString, "updated"),
      context?.branchId,
      buildEditCheckpoint({
        beforeExists: true,
        beforeContent: "",
        afterContent: newString,
        beforeText: existingText,
      }),
    );
    maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
    await notifyWorkspaceFileChanged(sessionId, {
      filePath,
      beforeContent: "",
      afterContent: newString,
      operation: "updated",
    }, context);
    return `File edited: ${filePath}.`;
  }

  if (!oldString && !existsSync(filePath)) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeTextFile(filePath, newString, {
      encoding: "utf8",
      hadBom: false,
      lineEnding: "\n",
    });
    readFileState.set(filePath, {
      content: newString,
      mtimeMs: Math.floor(statSync(filePath).mtimeMs),
      encoding: "utf8",
      hadBom: false,
      lineEnding: "\n",
    });
    context?.workspaceActivity?.recordDiff(
      sessionId,
      buildStructuredDiff(filePath, "", newString, "created"),
      context?.branchId,
      buildEditCheckpoint({
        beforeExists: false,
        beforeContent: "",
        afterContent: newString,
      }),
    );
    maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
    await notifyWorkspaceFileChanged(sessionId, {
      filePath,
      beforeContent: null,
      afterContent: newString,
      operation: "created",
    }, context);
    return `File created: ${filePath}.`;
  }

  // Error 4: file doesn't exist
  if (!existsSync(filePath)) {
    const dir = dirname(filePath);
    try {
      const { readdirSync: ls } = await import("node:fs");
      const base = filePath.slice(filePath.lastIndexOf("/") + 1);
      const entries = ls(dir);
      let best = "";
      let bestDist = Infinity;
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        let dist = 0;
        for (let i = 0; i < Math.min(base.length, entry.length); i++) {
          if (base[i] !== entry[i]) dist++;
        }
        dist += Math.abs(base.length - entry.length);
        if (dist < bestDist && dist < base.length / 2 + 2) {
          bestDist = dist;
          best = entry;
        }
      }
      const suggestion = best ? ` Did you mean ${best}?` : "";
      return toolError(`File does not exist: ${filePath}.${suggestion}`);
    } catch {
      return toolError(`File does not exist: ${filePath}.`);
    }
  }

  // Error 10: file too large
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_EDIT_FILE_SIZE) {
      return toolError(`File is too large to edit (${stat.size} bytes). Maximum editable file size is 1 GiB.`);
    }
  } catch {
    // stat failed, continue anyway
  }

  // Error 6: not read yet
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return toolError("File has not been read yet. Read it first before editing.");
  }

  // Error 7: modified since read
  const fileText = readTextFile(filePath);
  const fileContent = fileText.content;
  if (fileContent !== state.content) {
    return toolError("File has been modified since read, either by the user or by a linter. Read it again before attempting to edit.");
  }

  // Error 5: .ipynb
  if (filePath.endsWith(".ipynb")) {
    return toolError("File is a Jupyter Notebook. Use notebook_edit to edit .ipynb files structurally at the cell level.");
  }

  // Error 8: string not found
  const actualOldString = findActualString(fileContent, oldString);
  if (!actualOldString) {
    return toolError(`String to replace not found in file.\nString: ${oldString}`);
  }
  newString = preserveQuoteStyle(oldString, actualOldString, newString);

  const matches = fileContent.split(actualOldString).length - 1;

  // Error 9: multiple matches but replace_all is false
  if (matches > 1 && !replaceAll) {
    return toolError(`Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`);
  }

  // Apply the edit
  let updatedContent: string;
  if (replaceAll) {
    updatedContent = fileContent.replaceAll(actualOldString, () => newString);
  } else {
    updatedContent = fileContent.replace(actualOldString, () => newString);
  }

  // Verify edit actually changed something
  if (updatedContent === fileContent) {
    return toolError("No changes were made to the file.");
  }

  writeTextFile(filePath, updatedContent, {
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });

  const newMtime = Math.floor(statSync(filePath).mtimeMs);
  readFileState.set(filePath, {
    content: updatedContent,
    mtimeMs: newMtime,
    encoding: state.encoding ?? fileText.encoding,
    hadBom: state.hadBom ?? fileText.hadBom,
    lineEnding: state.lineEnding ?? fileText.lineEnding,
  });

  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, fileContent, updatedContent, "updated"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent: fileContent,
      afterContent: updatedContent,
      beforeText: fileText,
    }),
  );
  maybeRecordPassiveTypeScriptDiagnostics({ sessionId, filePath, context });
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent: fileContent,
    afterContent: updatedContent,
    operation: "updated",
  }, context);

  if (replaceAll) {
    return `Successfully replaced ${matches} occurrence(s) of the string in ${filePath}.`;
  }
  return `File edited: ${filePath}.`;
}

export const editFileTool: ExecutableToolDefinition = buildTool({
  name: "edit_file",
  description: `Performs exact string replacements in files.

Usage:
- You must use the read_file tool at least once in the conversation before editing.
- When editing text from read_file output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix.
- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.
- Use replace_all for replacing and renaming strings across the file.`,
  params: {
    file_path: {
      type: "string",
      description: "The absolute path to the file to modify",
    },
    old_string: {
      type: "string",
      description: "The text to replace",
    },
    new_string: {
      type: "string",
      description: "The text to replace it with (must be different from old_string)",
    },
    replace_all: {
      type: "boolean",
      description:
        "Replace all occurrences of old_string (default false)",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
