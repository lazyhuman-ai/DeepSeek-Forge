import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { gitDiffTool } from "../../src/tools/built-in/git-diff.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";

const tmpDir = resolve("tests/tmp/git-diff");

function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: tmpDir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
    },
  });
}

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
  mkdirSync(tmpDir, { recursive: true });
  git(["init"]);
  git(["config", "user.email", "forgeagent@example.test"]);
  git(["config", "user.name", "DeepSeek-Forge Test"]);
  writeFileSync(resolve(tmpDir, "app.ts"), "export const value = 1;\n");
  git(["add", "app.ts"]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("git_diff", () => {
  it("returns bounded repo-level diff and records activity", async () => {
    writeFileSync(resolve(tmpDir, "app.ts"), "export const value = 2;\n");
    writeFileSync(resolve(tmpDir, "notes.txt"), "new\n");
    const events: SessionEvent[] = [];

    const result = await gitDiffTool.handler({ max_bytes: 20_000 }, "s1", {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    });

    const text = String(result);
    expect(text).toContain("Status:");
    expect(text).toContain("M app.ts");
    expect(text).toContain("notes.txt");
    expect(text).toContain("-export const value = 1;");
    expect(text).toContain("+export const value = 2;");
    expect(events.some((event) => (
      event.type === "activity_event" &&
      event.activityKind === "analysis" &&
      event.title === "Git workspace diff"
    ))).toBe(true);
  });
});
