import type { PermissionBroker, ToolRequestSource } from "../permissions/tool-policy.js";
import type { PathSandbox } from "../sandbox/path-sandbox.js";
import type { SessionEvent } from "../streams/event-types.js";
import type { WorkspaceActivityManager } from "../workspace/activity-manager.js";
import type { ModelProvider } from "./model-provider.js";

export type ToolExecResult = {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
};

export type ToolExecutionContext = {
  signal?: AbortSignal;
  toolUseId?: string;
  source?: ToolRequestSource;
  branchId?: string;
  toolExecutor?: ToolExecutor;
  toolsProvider?: () => import("../tools/schemas.js").ToolDefinition[];
  permissionBroker?: PermissionBroker;
  workspaceActivity?: WorkspaceActivityManager;
  modelProvider?: ModelProvider;
  pathSandbox?: PathSandbox;
  projectRoot?: string;
  readFileStateScope?: string;
  readThread?: (sessionId: string) => SessionEvent[];
  bashSandboxMode?: "disabled" | "best_effort" | "enforce";
};

export interface ToolExecutor {
  execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    context?: ToolExecutionContext,
  ): Promise<ToolExecResult>;
}
