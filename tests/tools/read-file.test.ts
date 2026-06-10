import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFileTool } from "../../src/tools/built-in/read-file.js";
import { ReadFileState, readFileState } from "../../src/tools/read-file-state.js";

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
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("File does not exist");
    expect(String((result as { output?: unknown }).output)).toContain("Recovery:");
  });

  it("returns error for directories", async () => {
    const result = await readFileTool.handler(
      { file_path: tmpDir },
      "s1",
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("Cannot read");
    expect(String((result as { output?: unknown }).output)).toContain("directory");
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

  it("describes image files instead of treating them as unreadable text", async () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(32, 16);
    png.writeUInt32BE(16, 20);
    writeFileSync(tmpPath("image.png"), png);
    const result = await readFileTool.handler(
      { file_path: tmpPath("image.png") },
      "s1",
    );
    expect(String(result)).toContain("[Image file:");
    expect(String(result)).toContain("Format: PNG");
    expect(String(result)).toContain("Dimensions: 32x16");
  });

  it("describes PDFs with approximate metadata instead of returning raw bytes", async () => {
    writeFileSync(tmpPath("doc.pdf"), "%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF");
    const result = await readFileTool.handler(
      { file_path: tmpPath("doc.pdf") },
      "s1",
    );

    expect(String(result)).toContain("[PDF file:");
    expect(String(result)).toContain("PDF version: 1.7");
    expect(String(result)).toContain("Approximate pages:");
  });

  it("summarizes Jupyter notebooks without pretending to be a notebook editor", async () => {
    writeFileSync(tmpPath("notebook.ipynb"), JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "Some notes"] },
        { cell_type: "code", source: "print('hello')" },
      ],
    }));
    const result = await readFileTool.handler(
      { file_path: tmpPath("notebook.ipynb") },
      "s1",
    );

    expect(String(result)).toContain("[Jupyter notebook:");
    expect(String(result)).toContain("Cells: 2");
    expect(String(result)).toContain("cell 2 code");
  });

  it("rejects unsupported binary files by extension with a recoverable tool error", async () => {
    writeFileSync(tmpPath("archive.zip"), Buffer.alloc(100));
    const result = await readFileTool.handler(
      { file_path: tmpPath("archive.zip") },
      "s1",
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("binary .zip");
    expect(String((result as { output?: unknown }).output)).toContain("Recovery:");
  });

  it("rejects files exceeding max size", async () => {
    const big = Buffer.alloc(300 * 1024);
    writeFileSync(tmpPath("big.txt"), big);
    const result = await readFileTool.handler(
      { file_path: tmpPath("big.txt") },
      "s1",
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("exceeds maximum allowed size");
  });

  it("blocks special device files with a readable recovery message", async () => {
    const result = await readFileTool.handler(
      { file_path: "/dev/zero" },
      "s1",
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("special device file");
    expect(String((result as { output?: unknown }).output)).toContain("Recovery:");
  });

  it("keeps read state bounded and normalizes path keys", () => {
    const state = new ReadFileState({ maxEntries: 2, maxContentBytes: 100 });
    state.set("./tests/tmp/read-file/a.txt", { content: "a", mtimeMs: 1 });
    state.set("tests/tmp/read-file/b.txt", { content: "b", mtimeMs: 1 });
    expect(state.get("tests/tmp/read-file/a.txt")?.content).toBe("a");
    state.set("tests/tmp/read-file/c.txt", { content: "c", mtimeMs: 1 });

    expect(state.size()).toBe(2);
    expect(state.get("tests/tmp/read-file/b.txt")).toBeUndefined();
    expect(state.get("tests/tmp/read-file/a.txt")?.content).toBe("a");
    expect(state.get("tests/tmp/read-file/c.txt")?.content).toBe("c");
  });
});
