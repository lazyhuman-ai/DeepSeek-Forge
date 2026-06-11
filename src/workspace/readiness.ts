import type {
  ActivityEvent,
  DiagnosticEvent,
  SessionEvent,
  VerificationEvent,
} from "../streams/event-types.js";
import { buildWorkspaceActivityState } from "./activity-manager.js";
import { isSafeWorkspaceVerificationCommand } from "./verification-commands.js";
import type { HostVerifyCheck } from "./host-checks.js";

export type WorkspaceReadinessIssue = {
  reason: string;
  nextAction: string;
};

export type WorkspaceReadinessResult = {
  ready: boolean;
  status: "passed" | "needs_attention";
  output: string;
  issues: WorkspaceReadinessIssue[];
  nextActions: string[];
  summary: {
    changedFiles: number;
    openTodos: number;
    diagnosticErrors: number;
    diagnosticWarnings: number;
    runningTasks: number;
    latestCheck?: string;
    latestStrongVerification?: string;
    latestWorkspaceChangeSeq: number;
    unverifiedChanges: boolean;
    missingStrongVerification: boolean;
    staleDiagnostics: boolean;
    missingHostChecks: string[];
  };
};

function branchMatches(event: SessionEvent, branchId?: string): boolean {
  return branchId === undefined || event.branchId === undefined || event.branchId === branchId;
}

function scopedEvents(events: SessionEvent[], sessionId: string, branchId?: string): SessionEvent[] {
  return events.filter((event) => event.sessionId === sessionId && branchMatches(event, branchId));
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
    .replace(/\s+/g, " ")
    .trim();
}

function commandMatches(actual: string, expected: string): boolean {
  return normalizeVerificationCommand(actual) === normalizeVerificationCommand(expected);
}

function isStrongVerificationCommand(command: string): boolean {
  return isSafeWorkspaceVerificationCommand(normalizeVerificationCommand(command));
}

function changeRequiresStrongVerification(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?|[cm]js|py|rs|go|swift|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|hh|m|mm)$/i.test(filePath) ||
    /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|Package\.swift|pom\.xml|build\.gradle(?:\.kts)?|Makefile|makefile|requirements(?:-[^/]+)?\.txt|uv\.lock|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/i.test(filePath);
}

function latestEvent<T extends SessionEvent>(events: T[], predicate: (event: T) => boolean): T | undefined {
  return [...events].reverse().find(predicate);
}

function issueLine(issue: string): string {
  return `- ${issue}`;
}

function isWorkspaceReviewSelfTodo(content: string): boolean {
  return /\bworkspace[_ -]?review\b|review\s+workspace|review\s+work|readiness\s+gate/i.test(content);
}

function isFinalReadinessGateActivity(event: ActivityEvent): boolean {
  return event.title === "Workspace review" || event.title === "Workspace final readiness gate";
}

export function evaluateWorkspaceReadiness(input: {
  sessionId: string;
  events: SessionEvent[];
  branchId?: string;
  hostChecks?: HostVerifyCheck[];
}): WorkspaceReadinessResult {
  const events = scopedEvents(input.events, input.sessionId, input.branchId);
  const state = buildWorkspaceActivityState(input.sessionId, events, input.branchId);
  const latestDiffSeq = latestSeq(events, "diff_event");
  const latestActivityChange = [...events].reverse().find((event): event is ActivityEvent => (
    event.type === "activity_event" &&
    event.activityKind === "change" &&
    !isFinalReadinessGateActivity(event)
  ));
  const latestWorkspaceChangeSeq = Math.max(latestDiffSeq, latestActivityChange?.seq ?? 0);
  const latestDiagnostic = latestEvent(events, (event) => event.type === "diagnostic_event");
  const latestCheck = state.checks[state.checks.length - 1];
  const latestStrongCheck = [...state.checks].reverse().find((check) => isStrongVerificationCommand(check.command));
  const errors = state.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = state.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const runningTasks = state.shellTasks.filter((task) => task.status === "running");
  const openTodos = state.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  const blockingOpenTodos = openTodos.filter((todo) => !isWorkspaceReviewSelfTodo(todo.content));
  const latestFailedActivity = [...events].reverse().find((event): event is ActivityEvent => (
    event.type === "activity_event" &&
    event.status === "failed" &&
    !isFinalReadinessGateActivity(event)
  ));
  const hostChecks = input.hostChecks ?? [];
  const codeOrHostCheckedChange = latestWorkspaceChangeSeq > 0 && (
    hostChecks.length > 0 ||
    state.changes.some((change) => changeRequiresStrongVerification(change.filePath)) ||
    (state.changes.length === 0 && latestActivityChange !== undefined)
  );
  const unverifiedChanges = codeOrHostCheckedChange && (!latestCheck || latestCheck.seq < latestWorkspaceChangeSeq || latestCheck.status !== "passed");
  const missingStrongVerification = codeOrHostCheckedChange && (
    !latestStrongCheck ||
    latestStrongCheck.seq < latestWorkspaceChangeSeq ||
    latestStrongCheck.status !== "passed"
  );
  const staleDiagnostics = latestWorkspaceChangeSeq > 0 && latestDiagnostic !== undefined && latestDiagnostic.seq < latestWorkspaceChangeSeq;
  const missingHostChecks = hostChecks
    .filter((check) => latestWorkspaceChangeSeq > 0)
    .filter((check) => !state.checks.some((event) => (
      event.status === "passed" &&
      event.seq > latestWorkspaceChangeSeq &&
      commandMatches(event.command, check.command)
    )));

  const issues: WorkspaceReadinessIssue[] = [];
  const pushIssue = (reason: string, nextAction: string): void => {
    issues.push({ reason, nextAction });
  };

  if (blockingOpenTodos.length > 0) {
    pushIssue(
      `${blockingOpenTodos.length} todo item(s) are still open.`,
      "Complete, update, or cancel the remaining todo items.",
    );
  }
  if (latestDiagnostic?.type === "diagnostic_event" && latestDiagnostic.status === "failed") {
    pushIssue(
      `Latest diagnostics failed: ${latestDiagnostic.message}.`,
      "Run an applicable diagnostic or verification command and fix any reported errors.",
    );
  }
  if (errors.length > 0) {
    pushIssue(
      `${errors.length} diagnostic error(s) remain.`,
      "Fix diagnostic errors, then rerun diagnostics or workspace verification.",
    );
  }
  if (latestCheck?.status === "failed") {
    pushIssue(
      `Latest check failed: ${latestCheck.command}.`,
      `Fix the failure from ${latestCheck.command}, then rerun the check.`,
    );
  }
  if (unverifiedChanges) {
    pushIssue(
      "Workspace changes are newer than the latest passing check.",
      "Run verify_workspace or an equivalent safe check after the latest diff.",
    );
  }
  if (missingStrongVerification) {
    pushIssue(
      "Workspace changes need a strong verification check after the latest diff. LSP diagnostics alone are not enough.",
      "Use verify_workspace as the default strong check; use bash only for a specific safe check that verify_workspace cannot detect.",
    );
  }
  if (staleDiagnostics) {
    pushIssue(
      "Diagnostics are older than the latest workspace diff.",
      "Refresh diagnostics after the latest file changes.",
    );
  }
  if (runningTasks.length > 0) {
    pushIssue(
      `${runningTasks.length} background task(s) are still running.`,
      "Use task_output to inspect running tasks, or task_kill if they should stop.",
    );
  }
  if (latestFailedActivity?.type === "activity_event") {
    pushIssue(
      `Latest failed activity: ${latestFailedActivity.title} - ${latestFailedActivity.message}`,
      "Resolve the failed activity or explain why it is no longer relevant.",
    );
  }
  for (const check of missingHostChecks) {
    pushIssue(
      `Required host check is missing or stale after the latest workspace change: ${check.command} (${check.source}:${check.line}).`,
      `Run ${check.command} after the latest change, or update the project host check if it is no longer valid.`,
    );
  }

  const nextActions = [...new Set(issues.map((issue) => issue.nextAction))];
  const ready = issues.length === 0;
  const status = ready ? "passed" : "needs_attention";
  const lines = [
    `Workspace review: ${status}`,
    `Readiness: ${ready ? "ready for final response" : "not ready for final response"}`,
    "",
    `Changed files: ${state.changes.length}`,
    ...state.changes.slice(0, 20).map((change) => `- ${change.filePath} (+${change.additions}/-${change.deletions})`),
    state.changes.length > 20 ? `- ... ${state.changes.length - 20} more changed file(s)` : "",
    latestActivityChange && latestActivityChange.seq > latestDiffSeq ? `Workspace change activity: ${latestActivityChange.message}` : "",
    "",
    `Todos: ${state.todos.length} total, ${openTodos.length} open${blockingOpenTodos.length !== openTodos.length ? ` (${openTodos.length - blockingOpenTodos.length} workspace_review gate todo)` : ""}`,
    `Evidence receipts: ${state.evidence.length}`,
    `Diagnostics: ${errors.length} errors, ${warnings.length} warnings`,
    `Latest check: ${latestCheck ? `${latestCheck.status} ${latestCheck.command} - ${latestCheck.summary}` : "none"}`,
    `Latest strong verification: ${latestStrongCheck ? `${latestStrongCheck.status} ${latestStrongCheck.command} - ${latestStrongCheck.summary}` : "none"}`,
    hostChecks.length > 0 ? `Project host checks: ${hostChecks.map((check) => check.command).join(" | ")}` : "",
    runningTasks.length > 0 ? `Running tasks: ${runningTasks.map((task) => task.taskId).join(", ")}` : "",
    "",
    ready ? "No unresolved workspace issues found from durable activity state." : "Issues to resolve:",
    ...issues.map((issue) => issueLine(issue.reason)),
    nextActions.length > 0 ? "" : "",
    nextActions.length > 0 ? "Recommended next actions:" : "",
    ...nextActions.map(issueLine),
  ].filter(Boolean);

  const summary: WorkspaceReadinessResult["summary"] = {
    changedFiles: state.changes.length,
    openTodos: blockingOpenTodos.length,
    diagnosticErrors: errors.length,
    diagnosticWarnings: warnings.length,
    runningTasks: runningTasks.length,
    latestWorkspaceChangeSeq,
    unverifiedChanges,
    missingStrongVerification,
    staleDiagnostics,
    missingHostChecks: missingHostChecks.map((check) => check.command),
  };
  if (latestCheck) summary.latestCheck = latestCheck.command;
  if (latestStrongCheck) summary.latestStrongVerification = latestStrongCheck.command;

  return {
    ready,
    status,
    output: lines.join("\n"),
    issues,
    nextActions,
    summary,
  };
}
