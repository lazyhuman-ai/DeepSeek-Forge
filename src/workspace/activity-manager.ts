import { randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  ActivityKind,
  ActivityStatus,
  ArtifactPointer,
  Diagnostic,
  DiagnosticEvent,
  DiffEvent,
  EditCheckpoint,
  EvidenceEvent,
  EvidenceReference,
  PermissionGrantEvent,
  PermissionGrantKind,
  SessionEvent,
  ShellTaskEvent,
  StructuredDiff,
  TodoEvent,
  TodoItem,
  VerificationEvent,
  WorktreeEvent,
} from "../streams/event-types.js";

export type ActivityItem = {
  seq: number;
  timestamp: string;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
};

export type ActivityChange = {
  filePath: string;
  operation: DiffEvent["operation"];
  additions: number;
  deletions: number;
  seq: number;
  summary: string;
};

export type WorkspaceActivityState = {
  sessionId: string;
  branchId?: string;
  todos: TodoItem[];
  changes: ActivityChange[];
  diagnostics: Diagnostic[];
  checks: VerificationEvent[];
  evidence: EvidenceEvent[];
  artifacts: ArtifactPointer[];
  shellTasks: ShellTaskEvent[];
  worktree?: WorktreeEvent;
  permissionGrants: PermissionGrantEvent[];
  recent: ActivityItem[];
};

export type WorkspaceActivityManagerOptions = {
  nextSeq: () => number;
  now: () => string;
  appendSessionEvent: (sessionId: string, event: SessionEvent) => void;
};

function branchMatches(event: SessionEvent, branchId?: string): boolean {
  return branchId === undefined || event.branchId === undefined || event.branchId === branchId;
}

function eventSession(event: Pick<SessionEvent, "sessionId">): string {
  return event.sessionId;
}

function latestByFile(events: DiffEvent[]): ActivityChange[] {
  const byFile = new Map<string, ActivityChange>();
  for (const event of events) {
    byFile.set(event.filePath, {
      filePath: event.filePath,
      operation: event.operation,
      additions: event.additions,
      deletions: event.deletions,
      seq: event.seq,
      summary: event.summary,
    });
  }
  return [...byFile.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function latestByTask(events: ShellTaskEvent[]): ShellTaskEvent[] {
  const byTask = new Map<string, ShellTaskEvent>();
  for (const event of events) byTask.set(event.taskId, event);
  return [...byTask.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .slice(-20);
}

export function buildWorkspaceActivityState(
  sessionId: string,
  events: SessionEvent[],
  branchId?: string,
): WorkspaceActivityState {
  const scoped = events.filter((event) => event.sessionId === sessionId && branchMatches(event, branchId));
  const todo = [...scoped].reverse().find((event): event is TodoEvent => event.type === "todo_event");
  const diffs = scoped.filter((event): event is DiffEvent => event.type === "diff_event");
  const diagnostics = [...scoped].reverse().find((event): event is DiagnosticEvent => event.type === "diagnostic_event");
  const checks = scoped.filter((event): event is VerificationEvent => event.type === "verification_event").slice(-10);
  const evidence = scoped.filter((event): event is EvidenceEvent => event.type === "evidence_event").slice(-30);
  const artifacts = scoped.filter((event): event is ArtifactPointer => event.type === "artifact_pointer").slice(-30);
  const shellTasks = latestByTask(scoped.filter((event): event is ShellTaskEvent => event.type === "shell_task_event"));
  const worktree = [...scoped].reverse().find((event): event is WorktreeEvent => event.type === "worktree_event");
  const permissionGrants = scoped
    .filter((event): event is PermissionGrantEvent => event.type === "permission_grant_event")
    .slice(-20);
  const activityEvents = scoped
    .filter((event): event is ActivityEvent => event.type === "activity_event")
    .slice(-12)
    .map((event) => ({
      seq: event.seq,
      timestamp: event.timestamp,
      kind: event.activityKind,
      status: event.status,
      title: event.title,
      message: event.message,
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
    }));

  return {
    sessionId,
    ...(branchId !== undefined ? { branchId } : {}),
    todos: todo?.items ?? [],
    changes: latestByFile(diffs),
    diagnostics: diagnostics?.diagnostics ?? [],
    checks,
    evidence,
    artifacts,
    shellTasks,
    ...(worktree !== undefined ? { worktree } : {}),
    permissionGrants,
    recent: activityEvents,
  };
}

export function buildWorkspaceActivitySummary(
  sessionId: string,
  events: SessionEvent[],
  branchId?: string,
): string {
  const state = buildWorkspaceActivityState(sessionId, events, branchId);
  const scoped = events.filter((event) => event.sessionId === sessionId && branchMatches(event, branchId));
  const lines: string[] = [];
  const activeTodos = state.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  if (activeTodos.length > 0) {
    lines.push(`Plan: ${activeTodos.map((todo) => `${todo.status === "in_progress" ? "*" : "-"} ${todo.content}`).join(" | ")}`);
  }
  if (state.changes.length > 0) {
    lines.push(`Changes: ${state.changes.map((change) => `${change.filePath} (+${change.additions}/-${change.deletions})`).join(", ")}`);
  }
  const latestChangeSeq = state.changes.reduce((max, change) => Math.max(max, change.seq), 0);
  const latestActivityChange = [...scoped].reverse().find((event): event is ActivityEvent => (
    event.type === "activity_event" && event.activityKind === "change"
  ));
  const latestWorkspaceChangeSeq = Math.max(latestChangeSeq, latestActivityChange?.seq ?? 0);
  if (latestActivityChange && latestActivityChange.seq > latestChangeSeq) {
    lines.push(`Changes: ${latestActivityChange.message}`);
  }
  const latestPassingCheck = [...state.checks].reverse().find((check) => check.status === "passed");
  const latestFailedCheck = [...state.checks].reverse().find((check) => check.status === "failed");
  if (latestWorkspaceChangeSeq > 0 && (!latestPassingCheck || latestPassingCheck.seq < latestWorkspaceChangeSeq)) {
    lines.push("Readiness: workspace changes are newer than the latest passing check; run verify_workspace or workspace_review before finalizing.");
  }
  const errors = state.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = state.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  if (errors.length > 0 || warnings.length > 0) {
    lines.push(`Diagnostics: ${errors.length} errors, ${warnings.length} warnings`);
  }
  const latestCheck = state.checks[state.checks.length - 1];
  if (latestCheck) lines.push(`Latest check: ${latestCheck.command} ${latestCheck.status} (${latestCheck.summary})`);
  const latestEvidence = state.evidence[state.evidence.length - 1];
  if (latestEvidence) {
    lines.push(`Latest evidence: ${latestEvidence.status} ${latestEvidence.step} (${latestEvidence.evidenceId})`);
  }
  const latestArtifact = state.artifacts[state.artifacts.length - 1];
  if (latestArtifact) {
    lines.push(`Latest artifact: ${latestArtifact.artifactId} (${latestArtifact.mimeType}, ${latestArtifact.sizeBytes} bytes)`);
  }
  if (latestFailedCheck && (!latestPassingCheck || latestFailedCheck.seq > latestPassingCheck.seq)) {
    lines.push(`Readiness: latest check failed (${latestFailedCheck.command}); inspect and fix before finalizing.`);
  }
  const runningTasks = state.shellTasks.filter((task) => task.status === "running");
  if (runningTasks.length > 0) lines.push(`Background tasks: ${runningTasks.map((task) => task.taskId).join(", ")}`);
  if (state.worktree && state.worktree.path) lines.push(`Worktree: ${state.worktree.path}${state.worktree.branch ? ` (${state.worktree.branch})` : ""}`);
  return lines.join("\n");
}

export class WorkspaceActivityManager {
  #nextSeq: () => number;
  #now: () => string;
  #appendSessionEvent: (sessionId: string, event: SessionEvent) => void;

  constructor(options: WorkspaceActivityManagerOptions) {
    this.#nextSeq = options.nextSeq;
    this.#now = options.now;
    this.#appendSessionEvent = options.appendSessionEvent;
  }

  recordActivity(input: {
    sessionId: string;
    branchId?: string;
    activityKind: ActivityKind;
    status: ActivityStatus;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
  }): ActivityEvent {
    const event: ActivityEvent = {
      type: "activity_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      activityKind: input.activityKind,
      status: input.status,
      title: input.title,
      message: input.message,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    this.#appendSessionEvent(input.sessionId, event);
    return event;
  }

  recordTodos(sessionId: string, items: TodoItem[], branchId?: string): TodoEvent {
    const event: TodoEvent = {
      type: "todo_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId,
      ...(branchId !== undefined ? { branchId } : {}),
      items,
      message: `${items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length} open task(s)`,
    };
    this.#appendSessionEvent(sessionId, event);
    return event;
  }

  recordDiff(sessionId: string, diff: StructuredDiff, branchId?: string, checkpoint?: EditCheckpoint): DiffEvent {
    const event: DiffEvent = {
      type: "diff_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId,
      ...(branchId !== undefined ? { branchId } : {}),
      filePath: diff.filePath,
      operation: diff.operation,
      additions: diff.additions,
      deletions: diff.deletions,
      summary: `${diff.operation} ${diff.filePath} (+${diff.additions}/-${diff.deletions})`,
      diff,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    };
    this.#appendSessionEvent(sessionId, event);
    return event;
  }

  recordDiagnostics(input: {
    sessionId: string;
    branchId?: string;
    source: string;
    diagnostics: Diagnostic[];
    failed?: boolean;
    message?: string;
  }): DiagnosticEvent {
    const event: DiagnosticEvent = {
      type: "diagnostic_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      source: input.source,
      status: input.failed ? "failed" : input.diagnostics.length === 0 ? "clean" : "issues",
      diagnostics: input.diagnostics,
      message: input.message ?? (
        input.failed
          ? `${input.source} diagnostics failed`
          : input.diagnostics.length === 0
            ? `${input.source} diagnostics are clean`
            : `${input.source} reported ${input.diagnostics.length} issue(s)`
      ),
    };
    this.#appendSessionEvent(input.sessionId, event);
    return event;
  }

  recordVerification(input: {
    sessionId: string;
    branchId?: string;
    command: string;
    status: VerificationEvent["status"];
    exitCode?: number;
    summary: string;
    artifactId?: string;
  }): VerificationEvent {
    const event: VerificationEvent = {
      type: "verification_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      command: input.command,
      status: input.status,
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      summary: input.summary,
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
    };
    this.#appendSessionEvent(input.sessionId, event);
    return event;
  }

  recordEvidence(input: {
    sessionId: string;
    branchId?: string;
    evidenceId?: string;
    step: string;
    todoId?: string;
    status: EvidenceEvent["status"];
    evidence: EvidenceReference[];
    matchedSeqs: number[];
    message: string;
  }): EvidenceEvent {
    const event: EvidenceEvent = {
      type: "evidence_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      evidenceId: input.evidenceId ?? randomUUID(),
      step: input.step,
      ...(input.todoId !== undefined ? { todoId: input.todoId } : {}),
      status: input.status,
      evidence: input.evidence,
      matchedSeqs: [...new Set(input.matchedSeqs)].sort((a, b) => a - b),
      message: input.message,
    };
    this.#appendSessionEvent(input.sessionId, event);
    return event;
  }

  recordShellTask(input: Omit<ShellTaskEvent, "type" | "seq" | "timestamp">): ShellTaskEvent {
    const event: ShellTaskEvent = {
      type: "shell_task_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      ...input,
    };
    this.#appendSessionEvent(eventSession(input), event);
    return event;
  }

  recordWorktree(input: Omit<WorktreeEvent, "type" | "seq" | "timestamp">): WorktreeEvent {
    const event: WorktreeEvent = {
      type: "worktree_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      ...input,
    };
    this.#appendSessionEvent(eventSession(input), event);
    return event;
  }

  recordPermissionGrant(input: {
    sessionId: string;
    branchId?: string;
    grantId?: string;
    grantKind: PermissionGrantKind;
    action: PermissionGrantEvent["action"];
    scope: PermissionGrantEvent["scope"];
    message: string;
    expiresAt?: string;
  }): PermissionGrantEvent {
    const event: PermissionGrantEvent = {
      type: "permission_grant_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      grantId: input.grantId ?? randomUUID(),
      grantKind: input.grantKind,
      action: input.action,
      scope: input.scope,
      message: input.message,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.#appendSessionEvent(input.sessionId, event);
    return event;
  }
}
