import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { notebookEditTool } from "../../src/tools/built-in/notebook-edit.js";
import { readFileTool } from "../../src/tools/built-in/read-file.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";

const tmpDir = resolve("tests/tmp/notebook-edit");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
}

function outputOf(result: unknown): string {
  return String((result as { output?: unknown }).output ?? result);
}

function expectToolError(result: unknown): void {
  expect((result as { isError?: unknown }).isError).toBe(true);
}

function notebook(): Record<string, unknown> {
  return {
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
      {
        cell_type: "code",
        metadata: {},
        execution_count: 7,
        outputs: [{ output_type: "stream", name: "stdout", text: ["old\n"] }],
        source: ["value = 1\n", "print(value)\n"],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

beforeEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

describe("notebook_edit", () => {
  it("replaces a code cell structurally and clears stale outputs", async () => {
    const filePath = tmpPath("analysis.ipynb");
    const events: SessionEvent[] = [];
    writeFileSync(filePath, `${JSON.stringify(notebook(), null, 2)}\n`, "utf-8");
    await readFileTool.handler({ file_path: filePath }, "s1");

    const result = await notebookEditTool.handler(
      {
        file_path: filePath,
        operation: "replace_cell",
        cell_index: 1,
        cell_type: "code",
        source: "value = 42\nprint(value)\n",
      },
      "s1",
      {
        workspaceActivity: activity(events),
        workspaceHooks: { onFileChanged: () => undefined },
      },
    );

    expect(String(result)).toContain("Notebook replaced code cell");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { cells: Array<{ source: string[]; outputs?: unknown[]; execution_count?: unknown }> };
    expect(parsed.cells[1]!.source.join("")).toBe("value = 42\nprint(value)\n");
    expect(parsed.cells[1]!.outputs).toEqual([]);
    expect(parsed.cells[1]!.execution_count).toBeNull();
    expect(events.some((event) => event.type === "diff_event" && event.filePath === filePath)).toBe(true);
  });

  it("inserts and deletes cells without corrupting notebook JSON", async () => {
    const filePath = tmpPath("cells.ipynb");
    writeFileSync(filePath, `${JSON.stringify(notebook(), null, 2)}\n`, "utf-8");
    await readFileTool.handler({ file_path: filePath }, "s1");

    await notebookEditTool.handler(
      {
        file_path: filePath,
        operation: "insert_cell",
        cell_index: 1,
        cell_type: "markdown",
        source: "Inserted note\n",
      },
      "s1",
    );
    await notebookEditTool.handler(
      {
        file_path: filePath,
        operation: "delete_cell",
        cell_index: 0,
      },
      "s1",
    );

    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { cells: Array<{ cell_type: string; source: string[] }> };
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells[0]!.cell_type).toBe("markdown");
    expect(parsed.cells[0]!.source.join("")).toContain("Inserted note");
  });

  it("rejects non-notebook paths with a readable tool error", async () => {
    const filePath = tmpPath("plain.txt");
    writeFileSync(filePath, "plain");

    const result = await notebookEditTool.handler(
      {
        file_path: filePath,
        operation: "replace_cell",
        cell_index: 0,
        source: "x",
      },
      "s1",
    );

    expectToolError(result);
    expect(outputOf(result)).toContain("only edits .ipynb files");
  });
});
