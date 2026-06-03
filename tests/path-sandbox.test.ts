import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PathSandbox } from "../src/sandbox/path-sandbox.js";
import { writeFileTool } from "../src/tools/built-in/write-file.js";

const root = resolve("tests/tmp/path-sandbox/root");
const outside = resolve("tests/tmp/path-sandbox/outside");
const scratch = resolve("tests/tmp/path-sandbox/scratch");

describe("PathSandbox", () => {
  beforeEach(() => {
    rmSync(resolve("tests/tmp/path-sandbox"), { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(scratch, { recursive: true });
  });

  afterEach(() => {
    rmSync(resolve("tests/tmp/path-sandbox"), { recursive: true, force: true });
  });

  it("allows paths inside configured roots", () => {
    const sandbox = new PathSandbox({ projectRoot: root, scratchRoot: scratch });
    const result = sandbox.resolvePath(resolve(root, "src/file.txt"), "write", "write_file", "fs.write");
    expect(result.ok).toBe(true);
  });

  it("blocks paths outside configured roots with readable recovery text", () => {
    const sandbox = new PathSandbox({ projectRoot: root, scratchRoot: scratch });
    const result = sandbox.resolvePath(resolve(outside, "secret.txt"), "write", "write_file", "fs.write");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Tool sandbox blocked filesystem access.");
      expect(result.message).toContain("Tool: write_file");
      expect(result.message).toContain("Requested action: fs.write");
      expect(result.message).toContain("Allowed roots:");
      expect(result.message).toContain("Recovery:");
    }
  });

  it("blocks symlink escapes", () => {
    const link = resolve(root, "link-out");
    symlinkSync(outside, link, "dir");
    const sandbox = new PathSandbox({ projectRoot: root, scratchRoot: scratch });
    const result = sandbox.resolvePath(resolve(link, "secret.txt"), "write", "write_file", "fs.write");
    expect(result.ok).toBe(false);
  });

  it("file tools return sandbox failures as structured tool errors", async () => {
    const sandbox = new PathSandbox({ projectRoot: root, scratchRoot: scratch });
    writeFileSync(resolve(root, "already-read.txt"), "old");
    const result = await writeFileTool.handler(
      { file_path: resolve(outside, "blocked.txt"), content: "x" },
      "s1",
      { pathSandbox: sandbox },
    );
    expect(result).toMatchObject({
      isError: true,
    });
    expect(String((result as { output: string }).output)).toContain("Tool sandbox blocked filesystem access.");
    expect(existsSync(resolve(outside, "blocked.txt"))).toBe(false);
  });
});
