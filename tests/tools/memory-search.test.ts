import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { memorySearchTool } from "../../src/tools/built-in/memory-search.js";
import { setMemoryStoreForTools } from "../../src/tools/built-in/memory-shared.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const testDir = resolve("tests/tmp/memory-search");

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

describe("memory_search", () => {
  it("returns no results for empty store", async () => {
    const result = await memorySearchTool.handler(
      { query: "nothing" },
      "s1",
    );
    expect(result).toContain("No memories found");
  });

  it("finds memories by content", async () => {
    const store = new MemoryStore(testDir);
    store.store({
      sessionId: "s1",
      kind: "fact",
      content: "User loves dark mode",
      tags: ["preference"],
    });
    setMemoryStoreForTools(store);

    const result = await memorySearchTool.handler(
      { query: "dark mode" },
      "s1",
    );
    expect(result).toContain("dark mode");
    expect(result).toContain("Found 1 memories");
  });

  it("finds memories by tag", async () => {
    const store = new MemoryStore(testDir);
    store.store({
      sessionId: "s1",
      kind: "fact",
      content: "Some content",
      tags: ["important", "urgent"],
    });
    setMemoryStoreForTools(store);

    const result = await memorySearchTool.handler(
      { query: "urgent" },
      "s1",
    );
    expect(result).toContain("Found 1 memories");
    expect(result).toContain("Some content");
  });

  it("handles empty query", async () => {
    const result = await memorySearchTool.handler(
      { query: "" },
      "s1",
    );
    expect(result).toContain("Search query cannot be empty");
  });

  it("handles missing store gracefully", async () => {
    setMemoryStoreForTools(null);
    const result = await memorySearchTool.handler(
      { query: "test" },
      "s1",
    );
    expect(result).toContain("Memory store is not available");
  });
});
