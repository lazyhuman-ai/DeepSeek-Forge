import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { multiEditFileTool } from "../../src/tools/built-in/multi-edit-file.js";
import { editFileTool } from "../../src/tools/built-in/edit-file.js";
import { readFileTool } from "../../src/tools/built-in/read-file.js";
import { revertFileChangeTool } from "../../src/tools/built-in/edit-checkpoint.js";
import { writeFileTool } from "../../src/tools/built-in/write-file.js";
import { moveFileTool } from "../../src/tools/built-in/move-file.js";
import { readFileStateForScope, clearScopedReadFileStates } from "../../src/tools/read-file-state.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";
import { clearTypeScriptWorkspaceServices } from "../../src/workspace/typescript-service.js";

const tmpDir = resolve("tests/tmp/workspace-edit-tools");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
}

function prime(scope: string, filePath: string): void {
  readFileStateForScope(scope).set(filePath, {
    content: readFileSync(filePath, "utf-8"),
    mtimeMs: Math.floor(statSync(filePath).mtimeMs),
  });
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
  clearScopedReadFileStates();
  clearTypeScriptWorkspaceServices();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  clearScopedReadFileStates();
  clearTypeScriptWorkspaceServices();
});

describe("workspace edit tools", () => {
  it("keeps read state scoped by project/session/branch", async () => {
    const filePath = tmpPath("scoped.txt");
    writeFileSync(filePath, "alpha beta");
    prime("project:s1:main", filePath);

    const wrongScope = await multiEditFileTool.handler(
      { file_path: filePath, edits: [{ old_string: "alpha", new_string: "gamma" }] },
      "s1",
      { readFileStateScope: "project:s2:main" },
    );
    expect(String((wrongScope as { output?: unknown }).output ?? wrongScope)).toContain("File has not been read yet");
    expect(readFileSync(filePath, "utf-8")).toBe("alpha beta");

    const rightScope = await multiEditFileTool.handler(
      { file_path: filePath, edits: [{ old_string: "alpha", new_string: "gamma" }] },
      "s1",
      { readFileStateScope: "project:s1:main" },
    );
    expect(rightScope).toContain("File edited");
    expect(readFileSync(filePath, "utf-8")).toBe("gamma beta");
  });

  it("notifies workspace hooks when files are read and changed", async () => {
    const readPath = tmpPath("hook-read.txt");
    const writePath = tmpPath("hook-write.txt");
    writeFileSync(readPath, "alpha\n");
    const touched: Array<{ sessionId: string; filePath: string; reason: string }> = [];
    const changed: Array<{ sessionId: string; filePath: string; beforeContent: string | null; afterContent: string }> = [];

    await readFileTool.handler({ file_path: readPath }, "s1", {
      readFileStateScope: "project:s1:main",
      workspaceHooks: {
        onFileTouched: (input) => {
          touched.push(input);
        },
        onFileChanged: (input) => {
          changed.push(input);
        },
      },
    });
    await writeFileTool.handler({ file_path: writePath, content: "created\n" }, "s1", {
      readFileStateScope: "project:s1:main",
      workspaceHooks: {
        onFileTouched: (input) => {
          touched.push(input);
        },
        onFileChanged: (input) => {
          changed.push(input);
        },
      },
    });

    expect(touched).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        filePath: readPath,
        reason: "read",
      }),
    ]);
    expect(changed).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        filePath: writePath,
        beforeContent: null,
        afterContent: "created\n",
        operation: "created",
      }),
    ]);
  });

  it("applies multiple edits atomically and records one diff event", async () => {
    const events: SessionEvent[] = [];
    const filePath = tmpPath("multi.txt");
    writeFileSync(filePath, "one two three");
    prime("project:s1:main", filePath);

    const result = await multiEditFileTool.handler(
      {
        file_path: filePath,
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "three", new_string: "3" },
        ],
      },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        workspaceActivity: activity(events),
      },
    );

    expect(result).toContain("2 edit instruction");
    expect(readFileSync(filePath, "utf-8")).toBe("1 two 3");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "diff_event",
      filePath,
      additions: 1,
      deletions: 1,
      checkpoint: expect.objectContaining({
        kind: "file_snapshot",
        beforeExists: true,
      }),
    });
  });

  it("moves files through workspace activity instead of shell mv", async () => {
    const events: SessionEvent[] = [];
    const fromPath = tmpPath("old-name.ts");
    const toPath = tmpPath("new-name.ts");
    writeFileSync(fromPath, "export const value = 1;\n");
    prime("project:s1:main", fromPath);
    const changed: Array<{ filePath: string; operation: string; beforeContent: string | null; afterContent: string }> = [];

    const result = await moveFileTool.handler({ from_path: fromPath, to_path: toPath }, "s1", {
      branchId: "main",
      readFileStateScope: "project:s1:main",
      workspaceActivity: activity(events),
      workspaceHooks: {
        onFileChanged: (input) => {
          changed.push(input);
        },
      },
    });

    expect(String(result)).toContain("File moved");
    expect(existsSync(fromPath)).toBe(false);
    expect(readFileSync(toPath, "utf-8")).toBe("export const value = 1;\n");
    expect(events.filter((event) => event.type === "diff_event")).toHaveLength(2);
    expect(changed).toEqual([
      expect.objectContaining({ filePath: fromPath, operation: "deleted" }),
      expect.objectContaining({ filePath: toPath, operation: "created", beforeContent: null }),
    ]);
  });

  it("preserves curly quote style across multi-edit replacements", async () => {
    const filePath = tmpPath("quotes.md");
    writeFileSync(filePath, "A “first value”\nB ‘second value’");
    prime("project:s1:main", filePath);

    const result = await multiEditFileTool.handler(
      {
        file_path: filePath,
        edits: [
          { old_string: "\"first value\"", new_string: "\"updated value\"" },
          { old_string: "'second value'", new_string: "'other value'" },
        ],
      },
      "s1",
      { readFileStateScope: "project:s1:main" },
    );

    expect(result).toContain("2 edit instruction");
    expect(readFileSync(filePath, "utf-8")).toBe("A “updated value”\nB ‘other value’");
  });

  it("reverts the latest DeepSeek-Forge edit checkpoint for a file", async () => {
    const events: SessionEvent[] = [];
    const filePath = tmpPath("revert.txt");
    writeFileSync(filePath, "before\n");
    await readFileTool.handler({ file_path: filePath }, "s1", { readFileStateScope: "project:s1:main" });
    const manager = activity(events);

    await editFileTool.handler(
      { file_path: filePath, old_string: "before", new_string: "after" },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        workspaceActivity: manager,
      },
    );
    expect(readFileSync(filePath, "utf-8")).toBe("after\n");

    const result = await revertFileChangeTool.handler(
      { file_path: filePath },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        readThread: () => events,
        workspaceActivity: manager,
      },
    );

    expect(result).toContain("Reverted latest DeepSeek-Forge edit checkpoint");
    expect(readFileSync(filePath, "utf-8")).toBe("before\n");
    expect(events.filter((event) => event.type === "diff_event")).toHaveLength(2);
  });

  it("refuses to revert when the file changed after the checkpoint", async () => {
    const events: SessionEvent[] = [];
    const filePath = tmpPath("revert-stale.txt");
    writeFileSync(filePath, "before\n");
    await readFileTool.handler({ file_path: filePath }, "s1", { readFileStateScope: "project:s1:main" });
    const manager = activity(events);

    await editFileTool.handler(
      { file_path: filePath, old_string: "before", new_string: "after" },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        workspaceActivity: manager,
      },
    );
    writeFileSync(filePath, "user change\n");

    const result = await revertFileChangeTool.handler(
      { file_path: filePath },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        readThread: () => events,
        workspaceActivity: manager,
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("changed after the checkpoint");
    expect(readFileSync(filePath, "utf-8")).toBe("user change\n");
  });

  it("reverts a DeepSeek-Forge-created file by deleting it", async () => {
    const events: SessionEvent[] = [];
    const filePath = tmpPath("created.txt");
    const manager = activity(events);

    await writeFileTool.handler(
      { file_path: filePath, content: "created\n" },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        workspaceActivity: manager,
      },
    );
    expect(existsSync(filePath)).toBe(true);

    const result = await revertFileChangeTool.handler(
      { file_path: filePath },
      "s1",
      {
        branchId: "main",
        readFileStateScope: "project:s1:main",
        readThread: () => events,
        workspaceActivity: manager,
      },
    );

    expect(result).toContain("deleting");
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not write partial edits when a later edit fails", async () => {
    const filePath = tmpPath("atomic.txt");
    writeFileSync(filePath, "alpha beta gamma");
    prime("project:s1:main", filePath);

    const result = await multiEditFileTool.handler(
      {
        file_path: filePath,
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "missing", new_string: "MISSING" },
        ],
      },
      "s1",
      { readFileStateScope: "project:s1:main" },
    );

    expect(String((result as { output?: unknown }).output ?? result)).toContain("not found");
    expect(readFileSync(filePath, "utf-8")).toBe("alpha beta gamma");
  });

  it("preserves CRLF line endings while editing", async () => {
    const filePath = tmpPath("crlf.txt");
    writeFileSync(filePath, "alpha\r\nbeta\r\n");
    await readFileTool.handler({ file_path: filePath }, "s1", { readFileStateScope: "project:s1:main" });

    const result = await editFileTool.handler(
      { file_path: filePath, old_string: "beta", new_string: "gamma" },
      "s1",
      { readFileStateScope: "project:s1:main" },
    );

    expect(result).toContain("File edited");
    expect(readFileSync(filePath)).toEqual(Buffer.from("alpha\r\ngamma\r\n", "utf8"));
  });

  it("preserves UTF-16LE BOM while editing", async () => {
    const filePath = tmpPath("utf16.txt");
    writeFileSync(filePath, "\ufeffalpha\nbeta\n", "utf16le");
    await readFileTool.handler({ file_path: filePath }, "s1", { readFileStateScope: "project:s1:main" });

    const result = await editFileTool.handler(
      { file_path: filePath, old_string: "beta", new_string: "gamma" },
      "s1",
      { readFileStateScope: "project:s1:main" },
    );

    expect(result).toContain("File edited");
    const output = readFileSync(filePath);
    expect(output[0]).toBe(0xff);
    expect(output[1]).toBe(0xfe);
    expect(output.toString("utf16le")).toBe("\ufeffalpha\ngamma\n");
  });

  it("records passive TypeScript diagnostics after a TypeScript edit", async () => {
    writeFileSync(tmpPath("tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
      },
      include: ["src/**/*.ts"],
    }));
    mkdirSync(tmpPath("src"), { recursive: true });
    const filePath = tmpPath("src/app.ts");
    writeFileSync(filePath, "export const label: string = 'ok';\n");
    const events: SessionEvent[] = [];
    await readFileTool.handler({ file_path: filePath }, "s1", { readFileStateScope: "project:s1:main" });

    const result = await editFileTool.handler(
      { file_path: filePath, old_string: "'ok'", new_string: "42" },
      "s1",
      {
        projectRoot: tmpDir,
        readFileStateScope: "project:s1:main",
        workspaceActivity: activity(events),
      },
    );

    expect(result).toContain("File edited");
    const diagnosticEvent = events.find((event) => event.type === "diagnostic_event");
    expect(diagnosticEvent).toMatchObject({
      type: "diagnostic_event",
      status: "issues",
    });
    if (diagnosticEvent?.type === "diagnostic_event") {
      expect(diagnosticEvent.diagnostics).toContainEqual(expect.objectContaining({ code: "TS2322" }));
    }
  });
});
