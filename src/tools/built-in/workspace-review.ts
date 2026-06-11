import { evaluateWorkspaceReadiness } from "../../workspace/readiness.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";

async function handler(
  _args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const events = context?.readThread?.(sessionId) ?? [];
  const readiness = evaluateWorkspaceReadiness({
    sessionId,
    events,
    ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
    ...(context?.hostChecks !== undefined ? { hostChecks: context.hostChecks } : {}),
  });

  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
    activityKind: "verification",
    status: readiness.ready ? "completed" : "failed",
    title: "Workspace review",
    message: readiness.ready
      ? "Workspace activity review found no unresolved issues."
      : `Workspace activity review found ${readiness.issues.length} issue(s).`,
    payload: {
      ready: readiness.ready,
      ...readiness.summary,
      issues: readiness.issues.map((issue) => issue.reason),
      nextActions: readiness.nextActions,
    },
  });

  return readiness.ready ? readiness.output : { output: readiness.output, isError: true };
}

export const workspaceReviewTool: ExecutableToolDefinition = buildTool({
  name: "workspace_review",
  description: "Reviews durable workspace activity before finalizing work. It checks open todos, evidence receipts, changed files, diagnostics, verification checks, project host checks, worktree state, and running background tasks.",
  params: {},
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
});
