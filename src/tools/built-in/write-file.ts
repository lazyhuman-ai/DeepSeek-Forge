import { writeFileSync, existsSync, statSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { readFileState } from "../read-file-state.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
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
  const content = normalizeLineEndings(args.content as string);

  const fileExists = existsSync(filePath);

  if (fileExists) {
    const state = readFileState.get(filePath);
    if (!state) {
      return "File has not been read yet. Read it first before writing to it.";
    }
    const currentContent = readFileSync(filePath, "utf-8");
    if (currentContent !== state.content) {
      return "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
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
      const currentContent = readFileSync(filePath, "utf-8");
      if (currentContent !== state.content) {
        return "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
      }
    }
  }

  writeFileSync(filePath, content, "utf-8");

  const newMtime = Math.floor(statSync(filePath).mtimeMs);
  readFileState.set(filePath, {
    content,
    mtimeMs: newMtime,
  });

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
