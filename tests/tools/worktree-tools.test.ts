import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import {
  commitWorktreeTool,
  enterWorktreeTool,
  exitWorktreeTool,
  mergeWorktreeTool,
} from "../../src/tools/built-in/worktree-tools.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";
import type { ToolExecutionContext } from "../../src/agent/tool-executor.js";

const tmpDir = resolve("tests/tmp/worktree-tools");
const repoDir = resolve(tmpDir, "repo");

function git(args: string[], cwd = repoDir): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
    },
  });
}

function gitStatus(cwd = repoDir): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
    },
  });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  mkdirSync(repoDir, { recursive: true });
  git(["init"]);
  git(["config", "user.email", "forgeagent@example.test"]);
  git(["config", "user.name", "DeepSeek-Forge Test"]);
  writeFileSync(resolve(repoDir, "README.md"), "hello\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  const sibling = resolve(dirname(repoDir), "repo.worktrees");
  if (existsSync(sibling)) rmSync(sibling, { recursive: true, force: true });
});

describe("worktree tools", () => {
  it("creates a sibling worktree, records activity, and switches current tool context", async () => {
    const events: SessionEvent[] = [];
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    const result = await enterWorktreeTool.handler({ branch: "forge/test-work" }, "s1", context);

    expect(String(result)).toContain("Worktree created");
    expect(context.projectRoot).toContain("repo.worktrees/forge_test-work");
    expect(existsSync(resolve(context.projectRoot!, "README.md"))).toBe(true);
    expect(readFileSync(resolve(context.projectRoot!, "README.md"), "utf-8")).toBe("hello\n");
    expect(events.some((event) => event.type === "worktree_event" && event.action === "entered")).toBe(true);

    const exit = await exitWorktreeTool.handler({ path: context.projectRoot }, "s1", context);
    expect(String(exit)).toContain("Worktree removed");
    expect(existsSync(context.projectRoot!)).toBe(false);
  });

  it("refuses to remove a dirty worktree unless discard_changes is explicit", async () => {
    const events: SessionEvent[] = [];
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    await enterWorktreeTool.handler({ branch: "forge/dirty-work" }, "s1", context);
    const worktreePath = context.projectRoot!;
    writeFileSync(resolve(worktreePath, "notes.txt"), "important local work\n");

    const rejected = await exitWorktreeTool.handler({ path: worktreePath }, "s1", context);
    expect(rejected).toMatchObject({ isError: true });
    expect(String((rejected as { output: string }).output)).toContain("Refusing to remove worktree");
    expect(String((rejected as { output: string }).output)).toContain("notes.txt");
    expect(existsSync(worktreePath)).toBe(true);
    expect(events.some((event) => event.type === "worktree_event" && event.action === "failed")).toBe(true);

    const removed = await exitWorktreeTool.handler({ path: worktreePath, discard_changes: true }, "s1", context);
    expect(String(removed)).toContain("Worktree removed");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses to remove an unverifiable non-git path", async () => {
    const events: SessionEvent[] = [];
    const plainDir = resolve(tmpDir, "plain-dir");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(resolve(plainDir, "data.txt"), "not a git worktree\n");
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    const result = await exitWorktreeTool.handler({ path: plainDir }, "s1", context);

    expect(result).toMatchObject({ isError: true });
    expect(String((result as { output: string }).output)).toContain("cannot prove it is safe");
    expect(String((result as { output: string }).output)).toContain("not the worktree root");
    expect(existsSync(plainDir)).toBe(true);
  });

  it("refuses dirty worktree merge and merges a clean committed worktree branch", async () => {
    const events: SessionEvent[] = [];
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    await enterWorktreeTool.handler({ branch: "forge/merge-work" }, "s1", context);
    const worktreePath = context.projectRoot!;
    writeFileSync(resolve(worktreePath, "feature.txt"), "draft\n");

    const dirty = await mergeWorktreeTool.handler({ path: worktreePath, target_path: repoDir }, "s1", context);
    expect(dirty).toMatchObject({ isError: true });
    expect(String((dirty as { output: string }).output)).toContain("Cannot merge worktree with uncommitted");

    git(["add", "feature.txt"], worktreePath);
    git(["commit", "-m", "add feature"], worktreePath);
    const clean = await mergeWorktreeTool.handler({ path: worktreePath, target_path: repoDir }, "s1", context);

    expect(String(clean)).toContain("Worktree merged");
    expect(readFileSync(resolve(repoDir, "feature.txt"), "utf-8")).toBe("draft\n");
    expect(events.some((event) => event.type === "worktree_event" && event.action === "merged")).toBe(true);
  });

  it("commits dirty worktree changes and records durable commit activity", async () => {
    const events: SessionEvent[] = [];
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    await enterWorktreeTool.handler({ branch: "forge/commit-work" }, "s1", context);
    const worktreePath = context.projectRoot!;
    writeFileSync(resolve(worktreePath, "feature.txt"), "ready\n");

    const committed = await commitWorktreeTool.handler({ message: "add feature" }, "s1", context);

    expect(String(committed)).toContain("Worktree committed");
    expect(String(committed)).toContain("Commit:");
    expect(gitStatus(worktreePath)).toEqual([]);
    const event = events.find((candidate) => candidate.type === "worktree_event" && candidate.action === "committed");
    expect(event).toBeTruthy();
    expect(event?.type === "worktree_event" ? event.message : "").toContain("feature.txt");
  });

  it("returns a readable error when committing an unchanged worktree", async () => {
    const events: SessionEvent[] = [];
    const context: ToolExecutionContext = {
      projectRoot: repoDir,
      workspaceActivity: activity(events),
    };

    await enterWorktreeTool.handler({ branch: "forge/no-commit-work" }, "s1", context);
    const result = await commitWorktreeTool.handler({ message: "empty" }, "s1", context);

    expect(result).toMatchObject({ isError: true });
    expect(String((result as { output: string }).output)).toContain("no changes");
  });
});
