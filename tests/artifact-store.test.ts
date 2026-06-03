import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";

const TEST_BASE = ".forge/test-artifacts";

describe("ArtifactStore", () => {
  let store: ArtifactStore;

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  function newStore(): ArtifactStore {
    return new ArtifactStore(TEST_BASE);
  }

  it("store returns ArtifactInfo with correct metadata", () => {
    store = newStore();
    const info = store.store("s1", "hello world", "text/plain");

    expect(info.sessionId).toBe("s1");
    expect(info.mimeType).toBe("text/plain");
    expect(info.sizeBytes).toBe(11);
    expect(info.artifactId).toBeDefined();
    expect(info.createdAt).toBeDefined();
  });

  it("retrieve returns stored data", () => {
    store = newStore();
    const info = store.store("s1", "hello", "text/plain");

    const data = store.retrieve(info.artifactId);
    expect(data?.toString()).toBe("hello");
  });

  it("stores and retrieves Buffer data", () => {
    store = newStore();
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const info = store.store("s1", buf, "application/octet-stream");

    expect(info.sizeBytes).toBe(4);
    const retrieved = store.retrieve(info.artifactId);
    expect(retrieved).toEqual(buf);
  });

  it("stores and retrieves string data", () => {
    store = newStore();
    const info = store.store("s1", '{"key":"value"}', "application/json");

    const data = store.retrieve(info.artifactId);
    expect(data?.toString()).toBe('{"key":"value"}');
  });

  it("getInfo returns metadata", () => {
    store = newStore();
    const stored = store.store("s1", "data", "text/plain");

    const info = store.getInfo(stored.artifactId);
    expect(info).not.toBeNull();
    expect(info!.artifactId).toBe(stored.artifactId);
    expect(info!.sizeBytes).toBe(4);
  });

  it("getInfo returns null for non-existent artifact", () => {
    store = newStore();
    expect(store.getInfo("nonexistent")).toBeNull();
  });

  it("retrieve returns null for non-existent artifact", () => {
    store = newStore();
    expect(store.retrieve("nonexistent")).toBeNull();
  });

  it("delete removes artifact files", () => {
    store = newStore();
    const info = store.store("s1", "temporary", "text/plain");

    const deleted = store.delete(info.artifactId);
    expect(deleted).toBe(true);
    expect(store.retrieve(info.artifactId)).toBeNull();
    expect(store.getInfo(info.artifactId)).toBeNull();
  });

  it("delete returns false for non-existent artifact", () => {
    store = newStore();
    expect(store.delete("nonexistent")).toBe(false);
  });

  it("listBySession returns artifacts for a session", () => {
    store = newStore();
    store.store("s1", "a", "text/plain");
    store.store("s1", "b", "text/plain");
    store.store("s2", "c", "text/plain");

    expect(store.listBySession("s1")).toHaveLength(2);
    expect(store.listBySession("s2")).toHaveLength(1);
    expect(store.listBySession("s3")).toHaveLength(0);
  });

  it("artifacts are independent across sessions", () => {
    store = newStore();
    const info1 = store.store("s1", "secret", "text/plain");
    const info2 = store.store("s2", "public", "text/plain");

    expect(info1.artifactId).not.toBe(info2.artifactId);
    expect(store.retrieve(info1.artifactId)?.toString()).toBe("secret");
    expect(store.retrieve(info2.artifactId)?.toString()).toBe("public");
  });
});
