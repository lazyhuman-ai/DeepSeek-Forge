import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { codeMapTool } from "../../src/tools/built-in/code-map.js";
import { dependencyGraphTool } from "../../src/tools/built-in/dependency-graph.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";

const tmpDir = resolve("tests/tmp/workspace-navigation-tools");

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

beforeEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(resolve(tmpDir, "src/lib"), { recursive: true });
  writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  writeFileSync(resolve(tmpDir, "src/lib/math.ts"), [
    "export function double(value: number): number {",
    "  return value * 2;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(resolve(tmpDir, "src/app.ts"), [
    "import { double } from './lib/math';",
    "import fs from 'node:fs';",
    "",
    "export const answer = double(21);",
    "void fs;",
    "",
  ].join("\n"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("workspace navigation tools", () => {
  it("builds a bounded code map with representative symbols", async () => {
    const events: SessionEvent[] = [];

    const result = await codeMapTool.handler({ path: tmpDir }, "s1", {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    });

    expect(String(result)).toContain("Code map for");
    expect(String(result)).toContain("TypeScript: 2");
    expect(String(result)).toContain("package.json");
    expect(String(result)).toContain("function double");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      title: "Code map",
      status: "completed",
    }));
  });

  it("builds a dependency graph with internal and external edges", async () => {
    const events: SessionEvent[] = [];

    const result = await dependencyGraphTool.handler({ path: tmpDir }, "s1", {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    });

    expect(String(result)).toContain("Dependency graph for");
    expect(String(result)).toContain("src/app.ts -> src/lib/math.ts");
    expect(String(result)).toContain("node:fs");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      title: "Dependency graph",
      status: "completed",
    }));
  });
});
