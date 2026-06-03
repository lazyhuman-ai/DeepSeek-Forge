import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { memoryGetTool } from "../../src/tools/built-in/memory-get.js";
import { setMemoryStoreForTools } from "../../src/tools/built-in/memory-shared.js";

const testDir = resolve("tests/tmp/memory-get");

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  setMemoryStoreForTools(new MemoryStore(testDir));
});

afterEach(() => {
  setMemoryStoreForTools(null);
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("memory_get", () => {
  it("reads a memory excerpt by id", async () => {
    const store = new MemoryStore(testDir);
    const entry = store.store({
      type: "project",
      title: "Architecture decision",
      content: "Tool errors should flow back to the agent as readable text.",
      tags: ["errors"],
    });
    setMemoryStoreForTools(store);

    const result = await memoryGetTool.handler({ id: entry.id }, "s1");

    expect(result).toContain(`Memory ${entry.id}`);
    expect(result).toContain("Tool errors should flow back");
  });

  it("reads a memory excerpt by source path", async () => {
    const store = new MemoryStore(testDir);
    const entry = store.store({
      type: "procedure",
      title: "Debug flow",
      content: "Run typecheck before npm test.",
      tags: ["debug"],
    });
    setMemoryStoreForTools(store);

    const result = await memoryGetTool.handler({ path: store.relativePath(entry.path) }, "s1");

    expect(result).toContain("Run typecheck before npm test");
  });

  it("rejects traversal paths", async () => {
    const result = await memoryGetTool.handler({ path: "../secret.md" }, "s1");

    expect(result).toContain("not found or not allowed");
  });

  it("supports offsets for large memories", async () => {
    const store = new MemoryStore(testDir);
    const entry = store.store({
      type: "episode",
      title: "Long episode",
      content: "0123456789".repeat(20),
      tags: [],
    });
    setMemoryStoreForTools(store);

    const result = await memoryGetTool.handler({ id: entry.id, offset: 0, limit: 80 }, "s1");

    expect(result).toContain("Memory truncated");
  });
});
