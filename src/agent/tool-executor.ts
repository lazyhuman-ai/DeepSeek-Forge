import type { PermissionBroker, ToolRequestSource } from "../permissions/tool-policy.js";
import type { PathSandbox } from "../sandbox/path-sandbox.js";

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
  permissionBroker?: PermissionBroker;
  pathSandbox?: PathSandbox;
  projectRoot?: string;
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
