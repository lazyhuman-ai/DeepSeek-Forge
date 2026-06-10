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
  delete process.env.CLAUDE_CODE_EXECPATH;
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

  it("supports files and count output modes", async () => {
    writeFileSync(tmpPath("a.ts"), "foo\nfoo\nbar");
    writeFileSync(tmpPath("b.ts"), "bar\nfoo");

    const files = await grepTool.handler(
      { pattern: "foo", path: tmpDir, output_mode: "files" },
      "s1",
    );
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");

    const counts = await grepTool.handler(
      { pattern: "foo", path: tmpDir, output_mode: "count" },
      "s1",
    );
    expect(counts).toContain("a.ts:2");
    expect(counts).toContain("b.ts:1");
  });

  it("supports paged content output", async () => {
    writeFileSync(tmpPath("many.ts"), Array.from({ length: 8 }, (_v, i) => `const foo${i} = ${i};`).join("\n"));

    const result = await grepTool.handler(
      { pattern: "foo", path: tmpDir, head_limit: 2, offset: 3 },
      "s1",
    );
    expect(result).toContain("foo3");
    expect(result).toContain("foo4");
    expect(result).not.toContain("foo0");
  });

  it("passes patterns as argv instead of shell fragments", async () => {
    writeFileSync(tmpPath("safe.ts"), "const literal = \"foo; rm -rf /\";");

    const result = await grepTool.handler(
      { pattern: "foo; rm -rf /", path: tmpDir },
      "s1",
    );

    expect(result).toContain("safe.ts");
    expect(result).toContain("foo; rm -rf /");
  });

  it("handles regex patterns", async () => {
    writeFileSync(tmpPath("code.ts"), "const x1 = 1;\nconst x2 = 2;\nconst y = 3;");
    const result = await grepTool.handler(
      { pattern: "const x\\d", path: tmpDir },
      "s1",
    );
    expect(result).toContain("const x1");
    expect(result).toContain("const x2");
    expect(result).not.toContain("const y");
  });

  it("defaults to the session project root when path is omitted", async () => {
    writeFileSync(tmpPath("project.ts"), "const projectOnly = true;");

    const result = await grepTool.handler(
      { pattern: "projectOnly" },
      "s1",
      { projectRoot: tmpDir },
    );

    expect(result).toContain("project.ts");
    expect(result).toContain("projectOnly");
  });

  it("does not treat the Claude executable path as ripgrep", async () => {
    process.env.CLAUDE_CODE_EXECPATH = "/bin/false";
    writeFileSync(tmpPath("code.ts"), "const forgeSearch = true;");

    const result = await grepTool.handler(
      { pattern: "forgeSearch", path: tmpDir },
      "s1",
    );

    expect(result).toContain("code.ts");
    expect(result).toContain("forgeSearch");
  });
});
