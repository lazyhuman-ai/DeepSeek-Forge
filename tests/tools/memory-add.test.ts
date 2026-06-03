import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { memoryAddTool } from "../../src/tools/built-in/memory-add.js";
import { setMemoryStoreForTools } from "../../src/tools/built-in/memory-shared.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const testDir = resolve("tests/tmp/memory-add");

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  const store = new MemoryStore(testDir);
  setMemoryStoreForTools(store);
});

afterEach(() => {
  setMemoryStoreForTools(null);
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("memory_add", () => {
  it("saves a memory entry", async () => {
    const result = await memoryAddTool.handler(
      { content: "User prefers TypeScript strict mode", kind: "fact", tags: ["preference"] },
      "s1",
    );
    expect(result).toContain("Memory saved");
    expect(result).toContain("project");
    expect(result).toContain("preference");
  });

  it("defaults to project type", async () => {
    const result = await memoryAddTool.handler(
      { content: "Some info" },
      "s1",
    );
    expect(result).toContain("Memory saved");
    expect(result).toContain("project");
  });

  it("rejects empty content", async () => {
    const result = await memoryAddTool.handler(
      { content: "", kind: "fact" },
      "s1",
    );
    expect(result).toContain("Cannot save empty memory");
  });

  it("handles missing store gracefully", async () => {
    setMemoryStoreForTools(null);
    const result = await memoryAddTool.handler(
      { content: "test" },
      "s1",
    );
    expect(result).toContain("Memory store is not available");
  });

  it("persists across searches", async () => {
    await memoryAddTool.handler(
      { content: "The sky is blue", kind: "fact", tags: ["sky"] },
      "s1",
    );
    // The memory should be in the store now
    const store = new MemoryStore(testDir);
    const results = store.search("sky");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("The sky is blue");
  });
});
