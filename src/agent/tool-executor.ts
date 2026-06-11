import type { PermissionBroker, ToolRequestSource } from "../permissions/tool-policy.js";
import type { PathSandbox } from "../sandbox/path-sandbox.js";
import type { SessionEvent } from "../streams/event-types.js";
import type { WorkspaceActivityManager } from "../workspace/activity-manager.js";
import type { HostVerifyCheck } from "../workspace/host-checks.js";
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
  dataDir?: string;
  readFileStateScope?: string;
  readThread?: (sessionId: string) => SessionEvent[];
  hostChecks?: HostVerifyCheck[];
  bashSandboxMode?: "disabled" | "best_effort" | "enforce";
  workspaceHooks?: {
    onFileTouched?: (input: {
      sessionId: string;
      branchId?: string;
      filePath: string;
      reason: "read" | "search" | "edit";
    }) => void | Promise<void>;
    onFileChanged?: (input: {
      sessionId: string;
      branchId?: string;
      filePath: string;
      beforeContent: string | null;
      afterContent: string;
      operation: "created" | "updated" | "deleted";
    }) => void | Promise<void>;
  };
};

export interface ToolExecutor {
  execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    context?: ToolExecutionContext,
  ): Promise<ToolExecResult>;
}
