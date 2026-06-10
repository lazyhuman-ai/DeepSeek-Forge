export type ToolParamType = "string" | "number" | "boolean" | "object" | "array";

export type ToolParamSchema = {
  type: ToolParamType;
  description: string;
  properties?: Record<string, ToolParamSchema>;
  items?: ToolParamSchema;
  optional?: boolean;
};

export type ToolCapability =
  | "fs.read"
  | "fs.write"
  | "process.exec"
  | "network.http"
  | "memory.read"
  | "memory.write"
  | "scheduler.read"
  | "scheduler.write"
  | "runtime.browser"
  | "artifact.read"
  | "user.prompt"
  | "mcp.tool"
  | "mcp.server.launch"
  | "mcp.resource.read"
  | "mcp.prompt.read"
  | "mcp.sampling"
  | "mcp.elicitation"
  | "extension.read"
  | "extension.install"
  | "extension.manage";

export type ToolHandler = (
  args: Record<string, unknown>,
  sessionId: string,
  context?: {
    signal?: AbortSignal;
    toolUseId?: string;
    source?: import("../permissions/tool-policy.js").ToolRequestSource;
    branchId?: string;
    toolExecutor?: import("../agent/tool-executor.js").ToolExecutor;
    toolsProvider?: () => ToolDefinition[];
    permissionBroker?: import("../permissions/tool-policy.js").PermissionBroker;
    workspaceActivity?: import("../workspace/activity-manager.js").WorkspaceActivityManager;
    modelProvider?: import("../agent/model-provider.js").ModelProvider;
    pathSandbox?: import("../sandbox/path-sandbox.js").PathSandbox;
    projectRoot?: string;
    readFileStateScope?: string;
    readThread?: (sessionId: string) => import("../streams/event-types.js").SessionEvent[];
    bashSandboxMode?: "disabled" | "best_effort" | "enforce";
  },
) => Promise<unknown>;

export type StructuredToolOutput = {
  output: unknown;
  isError: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  params: Record<string, ToolParamSchema>;
  parametersJsonSchema?: Record<string, unknown>;
  handler?: ToolHandler;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  capabilities?: ToolCapability[];
  anthropicServerType?: string;
  maxResultSizeChars?: number;
  source?: {
    kind: "builtin" | "mcp";
    serverId?: string;
    originalName?: string;
  };
};

export type ExecutableToolDefinition = ToolDefinition & {
  handler: ToolHandler;
};

export function buildTool<T extends ExecutableToolDefinition>(
  def: T,
): T & { isConcurrencySafe: boolean; isReadOnly: boolean } {
  return {
    isConcurrencySafe: false,
    isReadOnly: false,
    ...def,
  };
}
