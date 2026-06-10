import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { editFileTool } from "../../src/tools/built-in/edit-file.js";
import { readFileState } from "../../src/tools/read-file-state.js";

const tmpDir = resolve("tests/tmp/edit-file");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
}

function primeReadState(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const mtime = Math.floor(statSync(filePath).mtimeMs);
  readFileState.set(filePath, { content, mtimeMs: mtime });
}

function outputOf(result: unknown): string {
  return String((result as { output?: unknown }).output ?? result);
}

function expectToolError(result: unknown): void {
  expect((result as { isError?: unknown }).isError).toBe(true);
}

beforeEach(() => {
  readFileState.clear();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  readFileState.clear();
});

describe("edit_file", () => {
  it("replaces a single occurrence", async () => {
    writeFileSync(tmpPath("edit.txt"), "hello world");
    primeReadState(tmpPath("edit.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("edit.txt"), old_string: "world", new_string: "there" },
      "s1",
    );
    expect(result).toContain("File edited");
    expect(readFileSync(tmpPath("edit.txt"), "utf-8")).toBe("hello there");
  });

  it("replaces all occurrences with replace_all", async () => {
    writeFileSync(tmpPath("replace.txt"), "foo bar foo baz foo");
    primeReadState(tmpPath("replace.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("replace.txt"), old_string: "foo", new_string: "qux", replace_all: true },
      "s1",
    );
    expect(result).toContain("3 occurrence");
    expect(readFileSync(tmpPath("replace.txt"), "utf-8")).toBe("qux bar qux baz qux");
  });

  it("fails when old_string equals new_string", async () => {
    writeFileSync(tmpPath("noop.txt"), "test");
    primeReadState(tmpPath("noop.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("noop.txt"), old_string: "test", new_string: "test" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("No changes to make");
  });

  it("fails when old_string is empty and file exists", async () => {
    writeFileSync(tmpPath("exists.txt"), "content");
    primeReadState(tmpPath("exists.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("exists.txt"), old_string: "", new_string: "new" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("Cannot create new file");
  });

  it("fails when file does not exist", async () => {
    const result = await editFileTool.handler(
      { file_path: tmpPath("missing.txt"), old_string: "a", new_string: "b" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("File does not exist");
  });

  it("fails when file has not been read first", async () => {
    writeFileSync(tmpPath("unread.txt"), "content");
    const result = await editFileTool.handler(
      { file_path: tmpPath("unread.txt"), old_string: "content", new_string: "new" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("File has not been read yet");
  });

  it("fails when file was modified since read", async () => {
    writeFileSync(tmpPath("stale.txt"), "original");
    primeReadState(tmpPath("stale.txt"));
    // Modify the file on disk AFTER priming state
    writeFileSync(tmpPath("stale.txt"), "externally modified");
    const result = await editFileTool.handler(
      { file_path: tmpPath("stale.txt"), old_string: "original", new_string: "new" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("File has been modified since read");
  });

  it("fails when old_string is not found", async () => {
    writeFileSync(tmpPath("nomatch.txt"), "alpha beta gamma");
    primeReadState(tmpPath("nomatch.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("nomatch.txt"), old_string: "delta", new_string: "epsilon" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("String to replace not found in file");
  });

  it("fails when multiple matches and replace_all is false", async () => {
    writeFileSync(tmpPath("multi.txt"), "foo bar foo baz foo");
    primeReadState(tmpPath("multi.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("multi.txt"), old_string: "foo", new_string: "qux" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("Found 3 matches");
    expect(outputOf(result)).toContain("replace_all");
  });

  it("preserves trailing whitespace in non-markdown files", async () => {
    writeFileSync(tmpPath("code.ts"), "const x = 1;\nconst y = 2;");
    primeReadState(tmpPath("code.ts"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("code.ts"), old_string: "const y = 2;", new_string: "const z = 3;   " },
      "s1",
    );
    expect(result).toContain("File edited");
    expect(readFileSync(tmpPath("code.ts"), "utf-8")).toBe("const x = 1;\nconst z = 3;   ");
  });

  it("preserves trailing whitespace in markdown files", async () => {
    writeFileSync(tmpPath("readme.md"), "# Title\nOld line");
    primeReadState(tmpPath("readme.md"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("readme.md"), old_string: "Old line", new_string: "New line  " },
      "s1",
    );
    expect(result).toContain("File edited");
    expect(readFileSync(tmpPath("readme.md"), "utf-8")).toBe("# Title\nNew line  ");
  });

  it("handles special regex characters as literals", async () => {
    writeFileSync(tmpPath("regex.txt"), "a.b*c[d]e(f)g");
    primeReadState(tmpPath("regex.txt"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("regex.txt"), old_string: "a.b*c", new_string: "REPLACED" },
      "s1",
    );
    expect(result).toContain("File edited");
    expect(readFileSync(tmpPath("regex.txt"), "utf-8")).toBe("REPLACED[d]e(f)g");
  });

  it("preserves the file's curly quote style when matching normalized quotes", async () => {
    writeFileSync(tmpPath("quotes.md"), "Title: “old label” and ‘old note’");
    primeReadState(tmpPath("quotes.md"));
    const result = await editFileTool.handler(
      {
        file_path: tmpPath("quotes.md"),
        old_string: "\"old label\" and 'old note'",
        new_string: "\"new label\" and 'new note'",
      },
      "s1",
    );

    expect(result).toContain("File edited");
    expect(readFileSync(tmpPath("quotes.md"), "utf-8")).toBe("Title: “new label” and ‘new note’");
  });

  it("fails gracefully for ipynb files", async () => {
    writeFileSync(tmpPath("notebook.ipynb"), '{"cells": []}');
    primeReadState(tmpPath("notebook.ipynb"));
    const result = await editFileTool.handler(
      { file_path: tmpPath("notebook.ipynb"), old_string: "cells", new_string: "items" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("NotebookEdit");
  });
});
