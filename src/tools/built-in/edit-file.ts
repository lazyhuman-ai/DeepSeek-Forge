import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileState } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function normalizeQuotes(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]!;
    if (i % 2 === 0) {
      result += part.replace(/[ \t]+$/gm, "");
    } else {
      result += part;
    }
  }
  return result;
}

function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(
      searchIndex,
      searchIndex + searchString.length,
    );
  }
  return null;
}

function isMarkdown(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext);
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
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
  const oldString = args.old_string as string;
  let newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  // Error 1: no-op
  if (oldString === newString) {
    return "No changes to make: old_string and new_string are exactly the same.";
  }

  // Error 3: create via empty old_string but file exists
  if (!oldString && existsSync(filePath)) {
    return "Cannot create new file — file already exists. Use write_file to overwrite or edit_file with a non-empty old_string.";
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
      return `File does not exist: ${filePath}.${suggestion}`;
    } catch {
      return `File does not exist: ${filePath}.`;
    }
  }

  // Error 10: file too large
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_EDIT_FILE_SIZE) {
      return `File is too large to edit (${stat.size} bytes). Maximum editable file size is 1 GiB.`;
    }
  } catch {
    // stat failed, continue anyway
  }

  // Error 6: not read yet
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return "File has not been read yet. Read it first before editing.";
  }

  // Error 7: modified since read
  const fileContent = readFileSync(filePath, "utf-8");
  if (fileContent !== state.content) {
    return "File has been modified since read, either by the user or by a linter. Read it again before attempting to edit.";
  }

  // Error 5: .ipynb
  if (filePath.endsWith(".ipynb")) {
    return "File is a Jupyter Notebook. Use the NotebookEdit tool to edit .ipynb files.";
  }

  // Error 8: string not found
  const actualOldString = findActualString(fileContent, oldString);
  if (!actualOldString) {
    return `String to replace not found in file.\nString: ${oldString}`;
  }

  const matches = fileContent.split(actualOldString).length - 1;

  // Error 9: multiple matches but replace_all is false
  if (matches > 1 && !replaceAll) {
    return `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }

  // Strip trailing whitespace for non-markdown
  if (!isMarkdown(filePath)) {
    newString = stripTrailingWhitespace(newString);
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
    return "No changes were made to the file.";
  }

  writeFileSync(filePath, updatedContent, "utf-8");

  const newMtime = Math.floor(statSync(filePath).mtimeMs);
  readFileState.set(filePath, {
    content: updatedContent,
    mtimeMs: newMtime,
  });

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
