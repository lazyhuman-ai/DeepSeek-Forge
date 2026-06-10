import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globTool } from "../../src/tools/built-in/glob.js";

const tmpDir = resolve("tests/tmp/glob");

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

describe("glob", () => {
  it("finds files matching a pattern", async () => {
    writeFileSync(tmpPath("a.ts"), "x");
    writeFileSync(tmpPath("b.ts"), "y");
    writeFileSync(tmpPath("c.js"), "z");

    const result = await globTool.handler(
      { pattern: "*.ts", path: tmpDir },
      "s1",
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.filenames).toContain("a.ts");
    expect(parsed.filenames).toContain("b.ts");
    expect(parsed.filenames).not.toContain("c.js");
    expect(parsed.numFiles).toBe(2);
  });

  it("returns no files for unmatched pattern", async () => {
    const result = await globTool.handler(
      { pattern: "*.py", path: tmpDir },
      "s1",
    );
    expect(result).toBe("No files found.");
  });

  it("recurses with ** pattern", async () => {
    mkdirSync(tmpPath("sub"));
    writeFileSync(tmpPath("root.ts"), "x");
    writeFileSync(tmpPath("sub/nested.ts"), "y");

    const result = await globTool.handler(
      { pattern: "**/*.ts", path: tmpDir },
      "s1",
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.filenames.length).toBeGreaterThanOrEqual(2);
  });

  it("defaults to the session project root when path is omitted", async () => {
    writeFileSync(tmpPath("project-only.ts"), "x");

    const result = await globTool.handler(
      { pattern: "*.ts" },
      "s1",
      { projectRoot: tmpDir },
    );

    const parsed = JSON.parse(result as string);
    expect(parsed.filenames).toContain("project-only.ts");
  });

  it("passes glob patterns as argv instead of shell fragments", async () => {
    writeFileSync(tmpPath("semi;colon.ts"), "x");

    const result = await globTool.handler(
      { pattern: "semi;*.ts", path: tmpDir },
      "s1",
    );

    const parsed = JSON.parse(result as string);
    expect(parsed.filenames).toContain("semi;colon.ts");
  });

  it("does not treat the Claude executable path as ripgrep", async () => {
    process.env.CLAUDE_CODE_EXECPATH = "/bin/false";
    writeFileSync(tmpPath("forge-index.ts"), "x");

    const result = await globTool.handler(
      { pattern: "*.ts", path: tmpDir },
      "s1",
    );

    const parsed = JSON.parse(result as string);
    expect(parsed.filenames).toContain("forge-index.ts");
  });
});
