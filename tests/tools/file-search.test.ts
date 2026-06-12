import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileSearchTool } from "../../src/tools/built-in/file-search.js";
import { PathSandbox } from "../../src/sandbox/path-sandbox.js";

const tmpDir = resolve("tests/tmp/file-search");

function tmpPath(path: string): string {
  return resolve(tmpDir, path);
}

beforeEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpPath("src/services"), { recursive: true });
  mkdirSync(tmpPath("src/components"), { recursive: true });
  writeFileSync(tmpPath("src/services/user-profile-service.ts"), "export const userProfile = true;\n");
  writeFileSync(tmpPath("src/components/UserCard.tsx"), "export function UserCard() { return null; }\n");
  writeFileSync(tmpPath("README.md"), "# DeepSeek-Forge\n");
});

describe("file_search", () => {
  it("fuzzy-searches workspace file paths", async () => {
    const result = await fileSearchTool.handler(
      { query: "usr prof svc", path: tmpDir },
      "s1",
    );

    expect(String(result)).toContain("user-profile-service.ts");
    expect(String(result)).toContain("fuzzy");
  });

  it("supports glob include filters", async () => {
    const result = await fileSearchTool.handler(
      { query: "user", path: tmpDir, include: "**/*.tsx" },
      "s1",
    );

    expect(String(result)).toContain("UserCard.tsx");
    expect(String(result)).not.toContain("user-profile-service.ts");
  });

  it("defaults to the session project root", async () => {
    const result = await fileSearchTool.handler(
      { query: "readme" },
      "s1",
      { projectRoot: tmpDir },
    );

    expect(String(result)).toContain("README.md");
  });

  it("uses PathSandbox for explicit search paths", async () => {
    const result = await fileSearchTool.handler(
      { query: "passwd", path: "/etc" },
      "s1",
      { pathSandbox: new PathSandbox({ projectRoot: tmpDir }) },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("outside the allowed workspace roots");
  });
});
