import { rmSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { readArtifactTool } from "../../src/tools/built-in/read-artifact.js";
import { setArtifactStoreForTools } from "../../src/tools/built-in/artifact-shared.js";

const BASE = ".forge/test-read-artifact";

describe("read_artifact tool", () => {
  let store: ArtifactStore;

  beforeEach(() => {
    rmSync(BASE, { recursive: true, force: true });
    store = new ArtifactStore(BASE);
    setArtifactStoreForTools(store);
  });

  afterEach(() => {
    setArtifactStoreForTools(null);
  });

  it("reads a text artifact slice for the same session", async () => {
    const info = store.store("s1", "hello world", "text/plain");

    const result = await readArtifactTool.handler(
      { artifact_id: info.artifactId, offset: 6, limit: 5 },
      "s1",
    );

    expect(result).toContain(`[Artifact ${info.artifactId}`);
    expect(result).toContain("world");
  });

  it("rejects cross-session artifact reads", async () => {
    const info = store.store("s1", "secret", "text/plain");

    const result = await readArtifactTool.handler(
      { artifact_id: info.artifactId },
      "s2",
    );

    expect(result).toEqual({
      output: `Artifact ${info.artifactId} belongs to a different session.`,
      isError: true,
    });
  });

  it("returns a readable error for binary artifacts", async () => {
    const info = store.store("s1", Buffer.from([1, 2, 3]), "application/octet-stream");

    const result = await readArtifactTool.handler(
      { artifact_id: info.artifactId },
      "s1",
    );

    expect(result).toEqual({
      output: `Artifact ${info.artifactId} is application/octet-stream (3 bytes) and cannot be read as text by read_artifact.`,
      isError: true,
    });
  });
});
