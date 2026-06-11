import { describe, expect, it } from "vitest";
import { buildContext } from "../src/agent/context-window-builder.js";
import type { SessionEvent, StructuredDiff } from "../src/streams/event-types.js";
import {
  buildWorkspaceActivityState,
  buildWorkspaceActivitySummary,
  WorkspaceActivityManager,
} from "../src/workspace/activity-manager.js";
import { validateStepEvidence } from "../src/workspace/evidence.js";
import { workspaceReviewTool } from "../src/tools/built-in/workspace-review.js";
import { buildStructuredDiff } from "../src/workspace/diff.js";
import { todoWriteTool } from "../src/tools/built-in/todo-write.js";

function manager(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => "2026-06-09T00:00:00.000Z",
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

describe("WorkspaceActivityManager", () => {
  it("records and summarizes scoped todos, diffs, diagnostics, checks, tasks, and grants", () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordTodos("s1", [{ id: "t1", content: "Fix type errors", status: "in_progress" }], "main");
    const diff: StructuredDiff = {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 2,
      deletions: 1,
      hunks: [],
    };
    activity.recordDiff("s1", diff, "main");
    activity.recordDiagnostics({
      sessionId: "s1",
      branchId: "main",
      source: "typescript",
      diagnostics: [{ severity: "error", message: "Cannot find name x", filePath: "/repo/src/app.ts", line: 1 }],
    });
    activity.recordVerification({
      sessionId: "s1",
      branchId: "main",
      command: "npm run typecheck",
      status: "failed",
      exitCode: 2,
      summary: "1 error",
    });
    events.push({
      type: "artifact_pointer",
      seq: 99,
      timestamp: "2026-06-09T00:00:00.000Z",
      sessionId: "s1",
      branchId: "main",
      artifactId: "artifact_1",
      mimeType: "text/plain",
      sizeBytes: 128,
    });
    activity.recordShellTask({
      sessionId: "s1",
      branchId: "main",
      taskId: "task_1",
      action: "started",
      command: "npm run dev",
      status: "running",
      message: "dev server started",
    });
    activity.recordPermissionGrant({
      sessionId: "s1",
      branchId: "main",
      grantKind: "workspace_edits",
      action: "created",
      scope: "session",
      message: "workspace edits allowed",
    });

    const state = buildWorkspaceActivityState("s1", events, "main");
    expect(state.todos).toHaveLength(1);
    expect(state.changes).toEqual([
      expect.objectContaining({ filePath: "/repo/src/app.ts", additions: 2, deletions: 1 }),
    ]);
    expect(state.diagnostics).toHaveLength(1);
    expect(state.checks[0]?.status).toBe("failed");
    expect(state.artifacts[0]?.artifactId).toBe("artifact_1");
    expect(state.shellTasks[0]?.status).toBe("running");
    expect(state.permissionGrants[0]?.grantKind).toBe("workspace_edits");
    expect(buildWorkspaceActivitySummary("s1", events, "main")).toContain("Diagnostics: 1 errors");
    expect(buildWorkspaceActivitySummary("s1", events, "main")).toContain("latest check failed");
  });

  it("renders activity events into model context", () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordTodos("s1", [{ id: "t1", content: "Run checks", status: "pending" }]);
    activity.recordVerification({
      sessionId: "s1",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      summary: "all tests passed",
    });

    const context = buildContext(events);
    expect(context.map((message) => message.content).join("\n")).toContain("[Workspace plan]");
    expect(context.map((message) => message.content).join("\n")).toContain("[Check: passed]");
  });

  it("summarizes each shell task by its latest status", () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordShellTask({
      sessionId: "s1",
      taskId: "task_1",
      action: "started",
      command: "npm run dev",
      status: "running",
      message: "dev server started",
    });
    activity.recordShellTask({
      sessionId: "s1",
      taskId: "task_1",
      action: "completed",
      command: "npm run dev",
      status: "completed",
      message: "dev server completed",
    });
    activity.recordShellTask({
      sessionId: "s1",
      taskId: "task_2",
      action: "started",
      command: "npm run watch",
      status: "running",
      message: "watch started",
    });

    const state = buildWorkspaceActivityState("s1", events);

    expect(state.shellTasks).toHaveLength(2);
    expect(state.shellTasks).toContainEqual(expect.objectContaining({
      taskId: "task_1",
      status: "completed",
    }));
    expect(state.shellTasks).toContainEqual(expect.objectContaining({
      taskId: "task_2",
      status: "running",
    }));
  });

  it("builds separate hunks for separated edits", () => {
    const before = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve",
      "thirteen",
      "fourteen",
      "fifteen",
      "sixteen",
      "seventeen",
      "eighteen",
      "nineteen",
      "twenty",
    ].join("\n");
    const after = before
      .replace("two", "TWO")
      .replace("nineteen", "NINETEEN");

    const diff = buildStructuredDiff("/repo/file.txt", before, after);

    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
    expect(diff.hunks.length).toBeGreaterThan(1);
  });

  it("workspace_review fails when changes are newer than checks and passes after verification", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });

    const unverified = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect((unverified as { isError?: boolean }).isError).toBe(true);
    expect(String((unverified as { output?: unknown }).output)).toContain("newer than the latest passing check");

    activity.recordVerification({
      sessionId: "s1",
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      summary: "clean",
    });

    const verified = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect(String(verified)).toContain("Workspace review: passed");
  });

  it("workspace_review does not treat its own gate todo as unresolved work", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });
    activity.recordVerification({
      sessionId: "s1",
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      summary: "clean",
    });
    activity.recordTodos("s1", [
      { id: "review", content: "Run workspace_review to confirm readiness", status: "in_progress" },
    ]);

    const reviewed = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect(String(reviewed)).toContain("Workspace review: passed");
    expect(String(reviewed)).toContain("workspace_review gate todo");
  });

  it("accepts passed workspace_review activity as explicit verification evidence", () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordActivity({
      sessionId: "s1",
      activityKind: "verification",
      status: "completed",
      title: "Workspace review",
      message: "Workspace activity review found no unresolved issues.",
      payload: { ready: true },
    });

    const validation = validateStepEvidence({
      step: "Complete todos and run workspace_review",
      todoId: "review",
      evidence: [{ kind: "verification", command: "workspace_review" }],
      events,
    });

    expect(validation.ok).toBe(true);
    expect(validation.matchedSeqs).toEqual([1]);
  });

  it("activity summary warns when changes are newer than the latest passing check", () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordVerification({
      sessionId: "s1",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      summary: "clean before edit",
    });
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });

    const summary = buildWorkspaceActivitySummary("s1", events);

    expect(summary).toContain("workspace changes are newer than the latest passing check");
    expect(summary).toContain("verify_workspace or workspace_review");
  });

  it("workspace_review treats LSP diagnostics as lightweight and still requires strong verification", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });
    activity.recordDiagnostics({
      sessionId: "s1",
      source: "typescript-language-service",
      diagnostics: [],
    });
    activity.recordVerification({
      sessionId: "s1",
      command: "typescript-language-service",
      status: "passed",
      exitCode: 0,
      summary: "TypeScript language service clean",
    });

    const lightweight = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect((lightweight as { isError?: boolean }).isError).toBe(true);
    expect(String((lightweight as { output?: unknown }).output)).toContain("strong verification check");
    expect(String((lightweight as { output?: unknown }).output)).toContain("LSP diagnostics alone are not enough");

    activity.recordVerification({
      sessionId: "s1",
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      summary: "clean",
    });

    const strong = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect(String(strong)).toContain("Workspace review: passed");
  });

  it("workspace_review accepts language-native safe verification as strong evidence", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/main.go",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });
    activity.recordVerification({
      sessionId: "s1",
      command: "cd /repo && go test ./... 2>&1",
      status: "passed",
      exitCode: 0,
      summary: "ok ./...",
    });

    const review = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect(String(review)).toContain("Workspace review: passed");
    expect(String(review)).toContain("Latest strong verification: passed cd /repo && go test ./... 2>&1");
  });

  it("workspace_review flags failed diagnostics even when no diagnostic items were parsed", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 1,
      hunks: [],
    });
    activity.recordDiagnostics({
      sessionId: "s1",
      source: "typescript-language-service",
      diagnostics: [],
      failed: true,
      message: "TypeScript language service failed: no project files",
    });
    activity.recordVerification({
      sessionId: "s1",
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      summary: "clean",
    });

    const review = await workspaceReviewTool.handler({}, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect((review as { isError?: boolean }).isError).toBe(true);
    const output = String((review as { output?: unknown }).output);
    expect(output).toContain("Latest diagnostics failed");
    expect(output).toContain("Recommended next actions:");
  });

  it("todo_write enforces one active task and reminds about missing verification", async () => {
    const multiple = await todoWriteTool.handler({
      items: [
        { content: "Edit A", status: "in_progress" },
        { content: "Edit B", status: "in_progress" },
      ],
    }, "s1");

    expect((multiple as { isError?: boolean }).isError).toBe(true);
    expect(String((multiple as { output?: unknown }).output)).toContain("Only one todo item may be in_progress");

    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordDiff("s1", {
      filePath: "/repo/src/app.ts",
      operation: "updated",
      additions: 1,
      deletions: 0,
      hunks: [],
    });

    const completed = await todoWriteTool.handler({
      items: [{ content: "Finish edit", status: "completed" }],
    }, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect((completed as { isError?: boolean }).isError).toBe(true);
    expect(String((completed as { output?: unknown }).output)).toContain("Verification reminder");
  });

  it("todo_write reminds the agent to rerun workspace_review after closing todos that previously blocked readiness", async () => {
    const events: SessionEvent[] = [];
    const activity = manager(events);
    activity.recordActivity({
      sessionId: "s1",
      activityKind: "verification",
      status: "failed",
      title: "Workspace review",
      message: "Workspace activity review found 1 issue(s).",
      payload: {
        ready: false,
        issues: ["1 todo item(s) are still open."],
      },
    });

    const completed = await todoWriteTool.handler({
      items: [{ content: "Close final review todo", status: "completed" }],
    }, "s1", {
      readThread: () => events,
      workspaceActivity: activity,
    });

    expect((completed as { isError?: boolean }).isError).toBe(true);
    expect(String((completed as { output?: unknown }).output)).toContain("Workspace review reminder");
    expect(String((completed as { output?: unknown }).output)).toContain("Run workspace_review again before finalizing");
  });
});
