import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { PermissionGrantKind } from "../../streams/event-types.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

const WORKSPACE_AUTOPILOT_GRANTS: PermissionGrantKind[] = ["workspace_edits", "safe_commands"];

function grantScope(value: unknown): "session" | "branch" {
  return value === "branch" ? "branch" : "session";
}

function shouldGrantAutopilot(value: unknown): boolean {
  return value !== false;
}

function createMissingWorkspaceAutopilotGrants(
  sessionId: string,
  context: ToolExecutionContext | undefined,
  scope: "session" | "branch",
): PermissionGrantKind[] {
  const broker = context?.permissionBroker;
  if (!broker) return [];

  const existing = new Set(
    broker.listPermissionGrants(sessionId)
      .filter((grant) => grant.scope === scope)
      .filter((grant) => scope !== "branch" || grant.branchId === context?.branchId)
      .map((grant) => grant.grantKind),
  );
  const created: PermissionGrantKind[] = [];
  for (const grantKind of WORKSPACE_AUTOPILOT_GRANTS) {
    if (existing.has(grantKind)) continue;
    const grant = broker.createPermissionGrant({
      sessionId,
      grantKind,
      scope,
      ...(scope === "branch" && context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    });
    context?.workspaceActivity?.recordPermissionGrant({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      grantId: grant.grantId,
      grantKind,
      action: "created",
      scope,
      message: `Permission grant created by plan approval: ${grantKind} (${scope})`,
    });
    created.push(grantKind);
  }
  return created;
}

async function enterHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  context?.permissionBroker?.setPlanMode(sessionId, true);
  const reason = typeof args.reason === "string" && args.reason.trim()
    ? args.reason.trim()
    : "The task needs analysis and a proposed plan before workspace changes.";
  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    activityKind: "plan",
    status: "running",
    title: "Plan mode",
    message: reason,
    payload: { mode: "entered" },
  });
  return [
    "Plan mode entered.",
    "You may inspect files, search, query LSP, inspect git diff, update todos, or ask the user.",
    "You may not edit files, run shell commands, launch runtimes, install packages, or change persistent state until you call exit_plan_mode.",
    `Reason: ${reason}`,
  ].join("\n");
}

async function exitHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const plan = typeof args.plan === "string" ? args.plan.trim() : "";
  if (!plan) {
    return {
      output: "plan is required. Provide the concise execution plan that was approved or is ready to execute.",
      isError: true,
    };
  }
  context?.permissionBroker?.setPlanMode(sessionId, false);
  const autopilot = shouldGrantAutopilot(args.grant_workspace_autopilot);
  const scope = grantScope(args.grant_scope);
  const grants = autopilot
    ? createMissingWorkspaceAutopilotGrants(sessionId, context, scope)
    : [];
  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    activityKind: "plan",
    status: "completed",
    title: "Plan mode exited",
    message: plan,
    payload: { mode: "exited", grantWorkspaceAutopilot: autopilot, grantScope: scope, grants },
  });
  return [
    "Plan mode exited.",
    autopilot
      ? `Workspace autopilot is ${grants.length > 0 ? "enabled" : "already enabled"} for ${scope}-scoped edits and safe checks. Sandbox hard blocks, explicit deny rules, package installs, external runtimes, network writes, and destructive actions are still not bypassed.`
      : "Workspace-changing tools are available again and still go through normal permissions and sandbox.",
    "Execution plan:",
    plan,
  ].join("\n");
}

export const enterPlanModeTool: ExecutableToolDefinition = buildTool({
  name: "enter_plan_mode",
  description: "Enters read-only planning mode for complex work. While active, the agent can inspect and plan but cannot edit files or run commands.",
  params: {
    reason: {
      type: "string",
      description: "Why this task should enter planning mode before execution.",
      optional: true,
    },
  },
  handler: enterHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: [],
});

export const exitPlanModeTool: ExecutableToolDefinition = buildTool({
  name: "exit_plan_mode",
  description: "Exits read-only planning mode with a concise execution plan. Normal permissions and sandbox still apply after exit.",
  params: {
    plan: {
      type: "string",
      description: "Concise execution plan to carry out after leaving plan mode.",
    },
    grant_workspace_autopilot: {
      type: "boolean",
      description: "Whether to create safe workspace_edits and safe_commands grants after leaving plan mode. Defaults to true.",
      optional: true,
    },
    grant_scope: {
      type: "string",
      description: "session or branch. Defaults to session.",
      optional: true,
    },
  },
  handler: exitHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: [],
});
