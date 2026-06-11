import { existsSync, statSync } from "node:fs";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath, type ToolPathContext } from "./path-helper.js";
import { buildStructuredDiff } from "../../workspace/diff.js";
import { readTextFile, writeTextFile } from "../text-file-io.js";
import { buildEditCheckpoint } from "./edit-checkpoint.js";
import { notifyWorkspaceFileChanged } from "./workspace-file-hooks.js";
import { readFileStateForContext } from "../read-file-state.js";

const MAX_NOTEBOOK_EDIT_BYTES = 20 * 1024 * 1024;

type NotebookCell = {
  cell_type?: string;
  source?: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
};

type Notebook = {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
};

function toolError(output: string): { output: string; isError: true } {
  return { output, isError: true };
}

function sourceToLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split(/(?<=\n)/);
  return lines.length > 0 ? lines : [source];
}

function createCell(cellType: string, source: string): NotebookCell {
  const normalizedType = cellType === "markdown" ? "markdown" : "code";
  const cell: NotebookCell = {
    cell_type: normalizedType,
    metadata: {},
    source: sourceToLines(source),
  };
  if (normalizedType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

function summarize(operation: string, filePath: string, index: number, cellType?: string): string {
  const type = cellType ? ` ${cellType}` : "";
  const verb = operation === "replace_cell"
    ? "replaced"
    : operation === "insert_cell"
      ? "inserted"
      : operation === "delete_cell"
        ? "deleted"
        : operation;
  return `Notebook ${verb}${type} cell at index ${index} in ${filePath}.`;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolPathContext,
): Promise<unknown> {
  const resolvedPath = resolveToolPath(args, context, {
    argName: "file_path",
    access: "write",
    toolName: "notebook_edit",
    action: "fs.write",
  });
  if (!resolvedPath.ok) return resolvedPath;
  const filePath = resolvedPath.path;
  if (!filePath.endsWith(".ipynb")) {
    return toolError(`notebook_edit only edits .ipynb files. Path: ${filePath}`);
  }
  if (!existsSync(filePath)) return toolError(`Notebook does not exist: ${filePath}`);
  const stat = statSync(filePath);
  if (stat.size > MAX_NOTEBOOK_EDIT_BYTES) {
    return toolError(`Notebook is too large to edit safely (${stat.size} bytes). Limit: ${MAX_NOTEBOOK_EDIT_BYTES} bytes.`);
  }

  const operation = typeof args.operation === "string" ? args.operation : "";
  const cellIndex = typeof args.cell_index === "number" ? args.cell_index : -1;
  const source = typeof args.source === "string" ? args.source : "";
  const cellType = typeof args.cell_type === "string" ? args.cell_type : "code";
  if (!["replace_cell", "insert_cell", "delete_cell"].includes(operation)) {
    return toolError("operation must be replace_cell, insert_cell, or delete_cell.");
  }

  const fileText = readTextFile(filePath);
  const readFileState = readFileStateForContext(context);
  const state = readFileState.get(filePath);
  if (!state || state.isPartialView) {
    return toolError("Notebook has not been read yet. Read it first with read_file before editing.");
  }
  if (fileText.content !== state.content) {
    return toolError("Notebook has been modified since read, either by the user or by another tool. Read it again before attempting to edit.");
  }
  let notebook: Notebook;
  try {
    notebook = JSON.parse(fileText.content) as Notebook;
  } catch (error) {
    return toolError(`Notebook JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(notebook.cells)) return toolError("Notebook JSON is missing a cells array.");
  const cells = notebook.cells;

  if (operation === "insert_cell") {
    if (cellIndex < 0 || cellIndex > cells.length) {
      return toolError(`cell_index ${cellIndex} is out of range for insert. Valid range: 0..${cells.length}.`);
    }
    cells.splice(cellIndex, 0, createCell(cellType, source));
  } else if (operation === "replace_cell") {
    if (cellIndex < 0 || cellIndex >= cells.length) {
      return toolError(`cell_index ${cellIndex} is out of range for replace. Valid range: 0..${Math.max(0, cells.length - 1)}.`);
    }
    const previous = cells[cellIndex] ?? {};
    const normalizedType = cellType === "markdown" ? "markdown" : "code";
    const nextCell: NotebookCell = {
      ...previous,
      cell_type: normalizedType,
      source: sourceToLines(source),
    };
    if (normalizedType === "markdown") {
      delete nextCell.outputs;
      delete nextCell.execution_count;
    } else {
      nextCell.outputs = [];
      nextCell.execution_count = null;
    }
    cells[cellIndex] = nextCell;
  } else {
    if (cellIndex < 0 || cellIndex >= cells.length) {
      return toolError(`cell_index ${cellIndex} is out of range for delete. Valid range: 0..${Math.max(0, cells.length - 1)}.`);
    }
    cells.splice(cellIndex, 1);
  }

  const updatedContent = `${JSON.stringify(notebook, null, 2)}\n`;
  if (updatedContent === fileText.content) return toolError("No notebook changes were made.");
  writeTextFile(filePath, updatedContent, {
    encoding: fileText.encoding,
    hadBom: fileText.hadBom,
    lineEnding: fileText.lineEnding,
  });
  readFileState.set(filePath, {
    content: updatedContent,
    mtimeMs: Math.floor(statSync(filePath).mtimeMs),
    encoding: fileText.encoding,
    hadBom: fileText.hadBom,
    lineEnding: fileText.lineEnding,
  });
  context?.workspaceActivity?.recordDiff(
    sessionId,
    buildStructuredDiff(filePath, fileText.content, updatedContent, "updated"),
    context?.branchId,
    buildEditCheckpoint({
      beforeExists: true,
      beforeContent: fileText.content,
      afterContent: updatedContent,
      beforeText: fileText,
    }),
  );
  await notifyWorkspaceFileChanged(sessionId, {
    filePath,
    beforeContent: fileText.content,
    afterContent: updatedContent,
    operation: "updated",
  }, context);

  return summarize(operation, filePath, cellIndex, operation === "delete_cell" ? undefined : cellType);
}

export const notebookEditTool: ExecutableToolDefinition = buildTool({
  name: "notebook_edit",
  description: "Edits Jupyter notebooks structurally at the cell level while preserving valid .ipynb JSON and recording durable diff/activity evidence. Use this instead of edit_file for .ipynb files.",
  params: {
    file_path: {
      type: "string",
      description: "Absolute path to the .ipynb notebook inside the workspace.",
    },
    operation: {
      type: "string",
      description: "replace_cell, insert_cell, or delete_cell.",
    },
    cell_index: {
      type: "number",
      description: "Zero-based cell index. For insert_cell, this may equal the current number of cells.",
    },
    cell_type: {
      type: "string",
      description: "code or markdown. Required for replace_cell and insert_cell; ignored for delete_cell.",
      optional: true,
    },
    source: {
      type: "string",
      description: "New cell source for replace_cell or insert_cell.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.write"],
});
