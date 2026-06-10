import type { SessionEvent } from "../../streams/event-types.js";
import { buildWorkspaceActivityState } from "../../workspace/activity-manager.js";
import { isSafeWorkspaceVerificationCommand } from "../../workspace/verification-commands.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";

function scopedEvents(events: SessionEvent[], sessionId: string, branchId?: string): SessionEvent[] {
  return events.filter((event) => (
    event.sessionId === sessionId &&
    (branchId === undefined || event.branchId === undefined || event.branchId === branchId)
  ));
}

function latestSeq(events: SessionEvent[], type: SessionEvent["type"]): number {
  return Math.max(0, ...events.filter((event) => event.type === type).map((event) => event.seq));
}

function unwrapLeadingCd(command: string): string {
  const trimmed = command.trim();
  const match = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/s.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeVerificationCommand(command: string): string {
  return unwrapLeadingCd(command)
    .replace(/\s+2>\s*&1\s*$/u, "")
    .replace(/\s+2>\s*\/dev\/null\s*$/u, "")
    .trim();
}

function isStrongVerificationCommand(command: string): boolean {
  return isSafeWorkspaceVerificationCommand(normalizeVerificationCommand(command));
}

function latestEvent<T extends SessionEvent>(events: T[], predicate: (event: T) => boolean): T | undefined {
  return [...events].reverse().find(predicate);
}

function issueLine(issue: string): string {
  return `- ${issue}`;
}

async function handler(
  _args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const events = scopedEvents(context?.readThread?.(sessionId) ?? [], sessionId, context?.branchId);
  const state = buildWorkspaceActivityState(sessionId, events, context?.branchId);
  const latestDiffSeq = latestSeq(events, "diff_event");
  const latestDiagnostic = latestEvent(events, (event) => event.type === "diagnostic_event");
  const latestCheck = state.checks[state.checks.length - 1];
  const latestStrongCheck = [...state.checks].reverse().find((check) => isStrongVerificationCommand(check.command));
  const errors = state.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = state.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const runningTasks = state.shellTasks.filter((task) => task.status === "running");
  const openTodos = state.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  const latestFailedActivity = latestEvent(events, (event) => (
    event.type === "activity_event" &&
    event.status === "failed" &&
    event.title !== "Workspace review"
  ));
  const unverifiedChanges = latestDiffSeq > 0 && (!latestCheck || latestCheck.seq < latestDiffSeq || latestCheck.status !== "passed");
  const missingStrongVerification = latestDiffSeq > 0 && (
    !latestStrongCheck ||
    latestStrongCheck.seq < latestDiffSeq ||
    latestStrongCheck.status !== "passed"
  );
  const staleDiagnostics = latestDiffSeq > 0 && latestDiagnostic !== undefined && latestDiagnostic.seq < latestDiffSeq;

  const issues: string[] = [];
  const nextActions: string[] = [];
  if (openTodos.length > 0) issues.push(`${openTodos.length} todo item(s) are still open.`);
  if (openTodos.length > 0) nextActions.push("Complete, update, or cancel the remaining todo items.");
  if (latestDiagnostic?.type === "diagnostic_event" && latestDiagnostic.status === "failed") {
    issues.push(`Latest diagnostics failed: ${latestDiagnostic.message}.`);
    nextActions.push("Run an applicable diagnostic or verification command and fix any reported errors.");
  }
  if (errors.length > 0) {
    issues.push(`${errors.length} diagnostic error(s) remain.`);
    nextActions.push("Fix diagnostic errors, then rerun diagnostics or workspace verification.");
  }
  if (latestCheck?.status === "failed") {
    issues.push(`Latest check failed: ${latestCheck.command}.`);
    nextActions.push(`Fix the failure from ${latestCheck.command}, then rerun the check.`);
  }
  if (unverifiedChanges) issues.push("Workspace changes are newer than the latest passing check.");
  if (unverifiedChanges) nextActions.push("Run verify_workspace or an equivalent safe check after the latest diff.");
  if (missingStrongVerification) {
    issues.push("Workspace changes need a strong verification check after the latest diff. Run verify_workspace or a bash test/typecheck/check/build/lint command; LSP diagnostics alone are not enough.");
    nextActions.push("Use verify_workspace as the default strong check; use bash only for a specific safe check that verify_workspace cannot detect.");
  }
  if (staleDiagnostics) issues.push("Diagnostics are older than the latest workspace diff.");
  if (staleDiagnostics) nextActions.push("Refresh diagnostics after the latest file changes.");
  if (runningTasks.length > 0) {
    issues.push(`${runningTasks.length} background task(s) are still running.`);
    nextActions.push("Use task_output to inspect running tasks, or task_kill if they should stop.");
  }
  if (latestFailedActivity?.type === "activity_event") {
    issues.push(`Latest failed activity: ${latestFailedActivity.title} - ${latestFailedActivity.message}`);
    nextActions.push("Resolve the failed activity or explain why it is no longer relevant.");
  }
  const uniqueNextActions = [...new Set(nextActions)];

  const ready = issues.length === 0;
  const status = ready ? "passed" : "needs_attention";
  const lines = [
    `Workspace review: ${status}`,
    `Readiness: ${ready ? "ready for final response" : "not ready for final response"}`,
    "",
    `Changed files: ${state.changes.length}`,
    ...state.changes.slice(0, 20).map((change) => `- ${change.filePath} (+${change.additions}/-${change.deletions})`),
    state.changes.length > 20 ? `- ... ${state.changes.length - 20} more changed file(s)` : "",
    "",
    `Todos: ${state.todos.length} total, ${openTodos.length} open`,
    `Diagnostics: ${errors.length} errors, ${warnings.length} warnings`,
    `Latest check: ${latestCheck ? `${latestCheck.status} ${latestCheck.command} - ${latestCheck.summary}` : "none"}`,
    `Latest strong verification: ${latestStrongCheck ? `${latestStrongCheck.status} ${latestStrongCheck.command} - ${latestStrongCheck.summary}` : "none"}`,
    runningTasks.length > 0 ? `Running tasks: ${runningTasks.map((task) => task.taskId).join(", ")}` : "",
    "",
    ready ? "No unresolved workspace issues found from durable activity state." : "Issues to resolve:",
    ...issues.map(issueLine),
    uniqueNextActions.length > 0 ? "" : "",
    uniqueNextActions.length > 0 ? "Recommended next actions:" : "",
    ...uniqueNextActions.map(issueLine),
  ].filter(Boolean);

  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
    activityKind: "verification",
    status: issues.length === 0 ? "completed" : "failed",
    title: "Workspace review",
    message: issues.length === 0
      ? "Workspace activity review found no unresolved issues."
      : `Workspace activity review found ${issues.length} issue(s).`,
    payload: {
      ready,
      changedFiles: state.changes.length,
      openTodos: openTodos.length,
      diagnosticErrors: errors.length,
      diagnosticWarnings: warnings.length,
      latestCheck: latestCheck?.command,
      latestStrongVerification: latestStrongCheck?.command,
      unverifiedChanges,
      missingStrongVerification,
      staleDiagnostics,
      runningTasks: runningTasks.length,
      issues,
      nextActions: uniqueNextActions,
    },
  });

  const output = lines.join("\n");
  return issues.length === 0 ? output : { output, isError: true };
}

export const workspaceReviewTool: ExecutableToolDefinition = buildTool({
  name: "workspace_review",
  description: "Reviews durable workspace activity before finalizing work. It checks open todos, changed files, diagnostics, verification checks, worktree state, and running background tasks.",
  params: {},
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
});
