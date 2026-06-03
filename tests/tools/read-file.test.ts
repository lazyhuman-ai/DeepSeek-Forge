import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFileTool } from "../../src/tools/built-in/read-file.js";
import { readFileState } from "../../src/tools/read-file-state.js";

const tmpDir = resolve("tests/tmp/read-file");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
}

beforeEach(() => {
  readFileState.clear();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  readFileState.clear();
});

describe("read_file", () => {
  it("reads a file with line numbers", async () => {
    writeFileSync(tmpPath("hello.txt"), "line one\nline two\nline three");
    const result = await readFileTool.handler(
      { file_path: tmpPath("hello.txt") },
      "s1",
    );
    expect(result).toContain("1\tline one");
    expect(result).toContain("2\tline two");
    expect(result).toContain("3\tline three");
  });

  it("returns error for non-existent file", async () => {
    const result = await readFileTool.handler(
      { file_path: tmpPath("nope.txt") },
      "s1",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain("File does not exist");
  });

  it("returns error for directories", async () => {
    const result = await readFileTool.handler(
      { file_path: tmpDir },
      "s1",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Cannot read");
    expect(result as string).toContain("directory");
  });

  it("handles empty files", async () => {
    writeFileSync(tmpPath("empty.txt"), "");
    const result = await readFileTool.handler(
      { file_path: tmpPath("empty.txt") },
      "s1",
    );
    expect(result).toContain("empty");
  });

  it("handles offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(tmpPath("numbers.txt"), lines.join("\n"));
    const result = await readFileTool.handler(
      { file_path: tmpPath("numbers.txt"), offset: 3, limit: 2 },
      "s1",
    );
    const text = result as string;
    expect(text).toContain("3\tline 3");
    expect(text).toContain("4\tline 4");
    expect(text).not.toContain("line 1");
    expect(text).not.toContain("line 5");
  });

  it("truncation message when output exceeds limit", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    writeFileSync(tmpPath("long.txt"), lines.join("\n"));
    const result = await readFileTool.handler(
      { file_path: tmpPath("long.txt"), offset: 95, limit: 3 },
      "s1",
    );
    const text = result as string;
    expect(text).toContain("truncated");
  });

  it("offset beyond file length gives warning", async () => {
    writeFileSync(tmpPath("short.txt"), "only one line");
    const result = await readFileTool.handler(
      { file_path: tmpPath("short.txt"), offset: 10, limit: 5 },
      "s1",
    );
    expect(result).toContain("Warning");
    expect(result).toContain("shorter than the provided offset");
  });

  it("deduplicates identical reads", async () => {
    writeFileSync(tmpPath("dedup.txt"), "content here");
    const r1 = await readFileTool.handler(
      { file_path: tmpPath("dedup.txt") },
      "s1",
    );
    const r2 = await readFileTool.handler(
      { file_path: tmpPath("dedup.txt") },
      "s1",
    );
    expect(r1).toContain("content here");
    expect(r2).toContain("File unchanged since last read");
  });

  it("rejects binary files by extension", async () => {
    writeFileSync(tmpPath("image.png"), Buffer.alloc(100));
    const result = await readFileTool.handler(
      { file_path: tmpPath("image.png") },
      "s1",
    );
    expect(result).toContain("binary");
    expect(result).toContain(".png");
  });

  it("rejects files exceeding max size", async () => {
    const big = Buffer.alloc(300 * 1024);
    writeFileSync(tmpPath("big.txt"), big);
    const result = await readFileTool.handler(
      { file_path: tmpPath("big.txt") },
      "s1",
    );
    expect(result).toContain("exceeds maximum allowed size");
  });
});
