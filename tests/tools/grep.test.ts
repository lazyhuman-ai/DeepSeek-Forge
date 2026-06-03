import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { grepTool } from "../../src/tools/built-in/grep.js";

const tmpDir = resolve("tests/tmp/grep");

function tmpPath(name: string): string {
  return resolve(tmpDir, name);
}

beforeEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  // cleanup handled by beforeEach
});

describe("grep", () => {
  it("finds matching lines in files", async () => {
    writeFileSync(tmpPath("code.ts"), "const foo = 1;\nconst bar = 2;\nconst fooBar = 3;");
    const result = await grepTool.handler(
      { pattern: "foo", path: tmpDir },
      "s1",
    );
    expect(result).toContain("foo");
    expect(result).toContain("code.ts");
  });

  it("returns no matches when pattern not found", async () => {
    writeFileSync(tmpPath("code.ts"), "const x = 1;");
    const result = await grepTool.handler(
      { pattern: "xyzzy_not_found", path: tmpDir },
      "s1",
    );
    expect(result).toBe("No matches found.");
  });

  it("supports case-insensitive search", async () => {
    writeFileSync(tmpPath("code.ts"), "const HELLO = 1;");
    const result = await grepTool.handler(
      { pattern: "hello", path: tmpDir, case_insensitive: true },
      "s1",
    );
    expect(result).toContain("HELLO");
  });

  it("supports include filter", async () => {
    writeFileSync(tmpPath("a.ts"), "const foo = 1;");
    writeFileSync(tmpPath("b.js"), "const foo = 2;");
    const result = await grepTool.handler(
      { pattern: "foo", path: tmpDir, include: "*.ts" },
      "s1",
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.js");
  });

  it("handles regex patterns", async () => {
    writeFileSync(tmpPath("code.ts"), "const x1 = 1;\nconst x2 = 2;\nconst y = 3;");
    const result = await grepTool.handler(
      { pattern: "const x\\\\d", path: tmpDir },
      "s1",
    );
    expect(result).toContain("const x1");
    expect(result).toContain("const x2");
    expect(result).not.toContain("const y");
  });
});
