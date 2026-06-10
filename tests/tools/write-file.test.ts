import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileTool } from "../../src/tools/built-in/write-file.js";
import { readFileState } from "../../src/tools/read-file-state.js";

const tmpDir = resolve("tests/tmp/write-file");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
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

describe("write_file", () => {
  it("creates a new file", async () => {
    const result = await writeFileTool.handler(
      { file_path: tmpPath("new.txt"), content: "hello world" },
      "s1",
    );
    expect(result).toContain("File created");
    expect(existsSync(tmpPath("new.txt"))).toBe(true);
    expect(readFileSync(tmpPath("new.txt"), "utf-8")).toBe("hello world");
  });

  it("overwrites an existing file after read", async () => {
    writeFileSync(tmpPath("existing.txt"), "old content");
    const mtime = Math.floor(statSync(tmpPath("existing.txt")).mtimeMs);
    readFileState.set(tmpPath("existing.txt"), {
      content: "old content",
      mtimeMs: mtime,
    });

    const result = await writeFileTool.handler(
      { file_path: tmpPath("existing.txt"), content: "new content" },
      "s1",
    );
    expect(result).toContain("File updated");
    expect(readFileSync(tmpPath("existing.txt"), "utf-8")).toBe("new content");
  });

  it("rejects write when file not read first", async () => {
    writeFileSync(tmpPath("unread.txt"), "content");
    const result = await writeFileTool.handler(
      { file_path: tmpPath("unread.txt"), content: "new" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("File has not been read yet");
  });

  it("rejects write when file modified since read", async () => {
    writeFileSync(tmpPath("stale.txt"), "version 2");
    // Simulate stale read state with DIFFERENT content
    readFileState.set(tmpPath("stale.txt"), {
      content: "version 1",
      mtimeMs: 0,
    });
    const result = await writeFileTool.handler(
      { file_path: tmpPath("stale.txt"), content: "version 3" },
      "s1",
    );
    expectToolError(result);
    expect(outputOf(result)).toContain("File has been modified since read");
  });

  it("creates parent directories automatically", async () => {
    const deepPath = tmpPath("a/b/c/deep.txt");
    await writeFileTool.handler(
      { file_path: deepPath, content: "deep" },
      "s1",
    );
    expect(existsSync(deepPath)).toBe(true);
    expect(readFileSync(deepPath, "utf-8")).toBe("deep");
  });

  it("normalizes CRLF to LF", async () => {
    await writeFileTool.handler(
      { file_path: tmpPath("crlf.txt"), content: "line1\r\nline2\r\nline3" },
      "s1",
    );
    const written = readFileSync(tmpPath("crlf.txt"), "utf-8");
    expect(written).not.toContain("\r");
    expect(written).toBe("line1\nline2\nline3");
  });
});
