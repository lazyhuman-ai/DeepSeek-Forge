export type SessionStatus = "idle" | "running" | "waiting_user" | "sleeping" | "blocked" | "archived";

export type Session = {
  id: string;
  title: string;
  status: SessionStatus;
  muted: boolean;
  dangerouslyAllowAllTools?: boolean;
  projectId?: string;
  workspacePath?: string;
  activeBranchId?: string;
  branches?: Record<string, SessionBranch>;
  createdAt: string;
  updatedAt: string;
  latestSeq?: number;
  latestAgentResultSeq?: number;
  unread?: boolean;
};

export type SessionBranch = {
  id: string;
  parentBranchId?: string;
  forkFromSeq?: number;
  variantOfSeq?: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
};

export type DeviceState = {
  deviceId: string;
  selectedProjectId?: string;
  selectedSessionId?: string;
  selectedBranchBySession?: Record<string, string>;
  sessionReadSeq: Record<string, number>;
  mutedSessionIds: string[];
  notificationSettings: {
    enabled: boolean;
    lastNotifiedSeq: number;
  };
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  status: "active" | "archived" | "missing";
  trustState: "trusted" | "untrusted";
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
};

export type BranchVariant = {
  branchId: string;
  userMessageSeq: number;
  sourceSeq: number;
  textPreview: string;
  createdAt: string;
};

export type BranchVariantGroup = {
  sourceSeq: number;
  variants: BranchVariant[];
};

export type SessionBranchState = {
  activeBranchId: string;
  branches: SessionBranch[];
  variantGroups: BranchVariantGroup[];
};

export type SetupStatus = {
  provider: {
    provider: "deepseek";
    configured: boolean;
    source: "local_config" | "env" | "missing";
    apiKeyMasked: string | null;
    baseUrl: string;
    model: string;
    contextWindowTokens: number;
    updatedAt?: string;
  };
};

export type SessionUsageSummary = {
  sessionId: string;
  records: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  currentContextSource?: "provider_usage" | "local_estimate";
  cacheHitRateNow?: number;
  cacheHitRateAverage?: number;
  cost?: number;
  currency?: string;
  estimated?: boolean;
};

export type HtmlFilePreview = {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
};

export type UploadedSessionFile = {
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
};

export type TerminalOutputEvent = {
  seq: number;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  data: string;
};

export type TerminalSession = {
  id: string;
  pid?: number;
  shell: string;
  cwd: string;
  status: "running" | "exited";
  createdAt: string;
  updatedAt: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  signal: string | null;
  events: TerminalOutputEvent[];
  nextSeq: number;
};

export type WebridgeHealth = {
  enabled?: boolean;
  state?: "online" | "stale" | "offline" | string;
  message?: string;
  clients?: Array<Record<string, unknown>>;
};

export type SkillStatus = {
  active?: number;
  generated?: number;
  invalid?: number;
  quarantined?: number;
  disabled?: number;
  manifestPath?: string;
};

export type MemoryStatus = {
  state: string;
  queuedExtractions: number;
  pendingProposals: number;
};

export type McpServerStatus = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http" | "sse";
  launchMode: "eager" | "background" | "lazy";
  trust: "trusted" | "untrusted" | "quarantined";
  state: "disabled" | "configured" | "connecting" | "connected" | "degraded" | "needs_auth" | "failed";
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  lastConnectedAt?: string;
  lastError?: string;
  authUrl?: string;
  cacheAgeMs?: number;
  stderrTail?: string;
};

export type McpStatusSummary = {
  state: "idle" | "degraded" | "needs_auth" | "failed" | "connected";
  servers: McpServerStatus[];
  enabled: number;
  connected: number;
  degraded: number;
  needsAuth: number;
  tools: number;
  events: number;
};

export type McpToolMetadata = {
  serverId: string;
  serverName: string;
  originalName: string;
  safeName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

export type ExtensionKind = "skill" | "mcp_server" | "bundle";

export type ExtensionCandidate = {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string;
  description: string;
  source: string;
  sourceLabel: string;
  trust: "official" | "curated" | "trusted" | "community" | "untrusted" | "quarantined" | "local";
  installed: boolean;
  enabled: boolean;
  status: "available" | "installed" | "active" | "disabled" | "quarantined" | "invalid";
  capabilities: string[];
  riskSummary: string;
  installInput: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  recommended?: boolean;
  setupRequired?: boolean;
  reviewState?: "safe" | "warning" | "blocked" | "setup_required";
  reviewAction?: "none" | "trust_enable" | "fix_required" | "setup_required";
  postInstall?: string;
  lock?: Record<string, unknown>;
  registrySourceId?: string;
};

export type ExtensionRegistrySource = {
  id: string;
  kind: "builtin" | "file" | "http" | "github";
  name: string;
  enabled: boolean;
  url?: string;
  path?: string;
  trust: ExtensionCandidate["trust"];
  trustUnsigned?: boolean;
  addedAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
};

export type ExtensionEventRecord = {
  seq: number;
  timestamp: string;
  detail: string;
  message: string;
  extensionId?: string;
  kind?: ExtensionKind;
  sourceId?: string;
  payload?: Record<string, unknown>;
};

export type ExtensionStatus = {
  skills: {
    status: SkillStatus;
    sources: Array<Record<string, unknown>>;
    entries: Array<Record<string, unknown>>;
  };
  mcp: {
    servers: McpServerStatus[];
    tools: McpToolMetadata[];
    catalog: Array<Record<string, unknown>>;
  };
  counts: {
    installed: number;
    enabled: number;
    quarantined: number;
    invalid: number;
  };
  registry: {
    sources: ExtensionRegistrySource[];
    entries: Array<Record<string, unknown>>;
    locks: Array<Record<string, unknown>>;
    events: ExtensionEventRecord[];
    diagnostics: string[];
  };
};

export type ExtensionInstallResult = {
  kind: ExtensionKind;
  id: string;
  name: string;
  status: "installed" | "active" | "quarantined" | "invalid";
  message: string;
};

export type McpElicitationRequest = {
  id: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
  status: "pending";
  expiresAt: string;
};

export type Diagnostics = {
  app: string;
  version: string;
  setup: SetupStatus;
  provider: null | {
    provider: string;
    model: string;
    contextWindowTokens?: number;
    requiresUsage?: boolean;
  };
  sessions: {
    total: number;
    statuses: Record<string, number>;
  };
  permissions: {
    pending: number;
  };
  mcp: McpStatusSummary;
  webridge: WebridgeHealth;
  memory: MemoryStatus;
  skills: {
    status: SkillStatus;
    evolution: Record<string, unknown>;
  };
};

export type NetworkUrls = {
  localUrl: string;
  lanUrls: string[];
  tailnetUrls: string[];
  remoteUrls: string[];
  recommendedRemoteUrl?: string;
  preferredUrl: string;
  remoteAccessStatus: "local_only" | "lan_ready" | "tailscale_ready" | "custom_remote_ready";
};

export type TailscaleOptimizationStatus = {
  installed: boolean;
  running: boolean;
  optimized: boolean;
  needsOptimization: boolean;
  canOptimize: boolean;
  tailscaleIps: string[];
  health: string[];
  prefs?: {
    acceptDns?: boolean;
    acceptRoutes?: boolean;
    corpDns?: boolean;
    routeAll?: boolean;
  };
  message: string;
};

export type RemoteAccessStatus = {
  coreId: string;
  desktopName: string;
  app: string;
  version: string;
  protocolVersion: number;
  networkUrls: NetworkUrls;
  tailscale: TailscaleOptimizationStatus;
};

export type PermissionRequest = {
  id: string;
  sessionId?: string;
  toolUseId?: string;
  toolName: string;
  action: string;
  subject: string;
  message: string;
  reason: string;
  status: "pending";
  expiresAt: string;
};

export type ActivityKind =
  | "plan"
  | "change"
  | "diagnostic"
  | "verification"
  | "shell_task"
  | "worktree"
  | "artifact"
  | "browser"
  | "mcp"
  | "permission"
  | "failure";

export type ActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "info";

export type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

export type StructuredDiff = {
  filePath: string;
  operation: "created" | "updated" | "deleted";
  additions: number;
  deletions: number;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
};

export type DiagnosticItem = {
  filePath?: string;
  line?: number;
  character?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
  code?: string;
};

export type WorkspaceActivityState = {
  sessionId: string;
  branchId?: string;
  todos: TodoItem[];
  changes: Array<{
    filePath: string;
    operation: "created" | "updated" | "deleted";
    additions: number;
    deletions: number;
    seq: number;
    summary: string;
  }>;
  diagnostics: DiagnosticItem[];
  checks: Extract<SessionEvent, { type: "verification_event" }>[];
  evidence: Extract<SessionEvent, { type: "evidence_event" }>[];
  shellTasks: Extract<SessionEvent, { type: "shell_task_event" }>[];
  artifacts: Extract<SessionEvent, { type: "artifact_pointer" }>[];
  worktree?: Extract<SessionEvent, { type: "worktree_event" }>;
  permissionGrants: Extract<SessionEvent, { type: "permission_grant_event" }>[];
  recent: Array<{
    seq: number;
    timestamp: string;
    kind: ActivityKind;
    status: ActivityStatus;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
  }>;
};

export type SessionEvent =
  | { type: "user_message"; seq: number; timestamp: string; branchId?: string; text: string; variantOfSeq?: number }
  | { type: "assistant_message"; seq: number; timestamp: string; branchId?: string; text: string }
  | { type: "assistant_delta"; seq: number; timestamp: string; branchId?: string; text: string }
  | { type: "tool_call"; seq: number; timestamp: string; branchId?: string; toolName: string; args: Record<string, unknown>; toolUseId?: string }
  | { type: "tool_result"; seq: number; timestamp: string; sessionId?: string; branchId?: string; toolName: string; result: unknown; isError: boolean; toolUseId?: string }
  | { type: "permission_request"; seq: number; timestamp: string; branchId?: string; permissionRequestId: string; toolName: string; action: string; subject: string; message: string; reason: string; status: "pending"; expiresAt: string }
  | { type: "permission_response"; seq: number; timestamp: string; branchId?: string; permissionRequestId: string; toolName: string; decision: string; status: string; message: string }
  | { type: "activity_event"; seq: number; timestamp: string; branchId?: string; activityKind: ActivityKind; status: ActivityStatus; title: string; message: string; payload?: Record<string, unknown> }
  | { type: "todo_event"; seq: number; timestamp: string; branchId?: string; items: TodoItem[]; message: string }
  | { type: "diff_event"; seq: number; timestamp: string; branchId?: string; filePath: string; operation: "created" | "updated" | "deleted"; additions: number; deletions: number; summary: string; diff?: StructuredDiff }
  | { type: "diagnostic_event"; seq: number; timestamp: string; branchId?: string; source: string; status: "clean" | "issues" | "failed"; diagnostics: DiagnosticItem[]; message: string }
  | { type: "verification_event"; seq: number; timestamp: string; branchId?: string; command: string; status: "running" | "passed" | "failed"; exitCode?: number; summary: string; artifactId?: string }
  | { type: "evidence_event"; seq: number; timestamp: string; branchId?: string; evidenceId: string; step: string; todoId?: string; status: "passed" | "failed"; evidence: Array<{ kind: "verification" | "diff" | "files" | "diagnostics" | "subagent" | "manual"; seq?: number; command?: string; path?: string; note?: string }>; matchedSeqs: number[]; message: string }
  | { type: "shell_task_event"; seq: number; timestamp: string; branchId?: string; taskId: string; action: "started" | "output" | "completed" | "failed" | "killed"; command: string; status: "running" | "completed" | "failed" | "killed"; message: string; outputPreview?: string; exitCode?: number }
  | { type: "worktree_event"; seq: number; timestamp: string; branchId?: string; action: "entered" | "committed" | "exited" | "kept" | "removed" | "merged" | "failed"; path?: string; branch?: string; message: string }
  | { type: "permission_grant_event"; seq: number; timestamp: string; branchId?: string; grantId: string; grantKind: "workspace_edits" | "safe_commands" | "package_install" | "external_runtime" | "network_write" | "destructive_action"; action: "created" | "revoked" | "expired"; scope: "session" | "project" | "branch"; message: string; expiresAt?: string }
  | { type: "runtime_event"; seq: number; timestamp: string; branchId?: string; runtimeKind: string; detail: string; message: string }
  | { type: "branch_event"; seq: number; timestamp: string; branchId?: string; sourceBranchId: string; sourceUserMessageSeq: number; variantOfSeq: number; newBranchId: string; message: string }
  | { type: "artifact_pointer"; seq: number; timestamp: string; branchId?: string; artifactId: string; mimeType: string; sizeBytes: number }
  | { type: "usage_event"; seq: number; timestamp: string; branchId?: string; usageRecordId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; contextWindowTokens?: number; contextUsedPercent?: number; cacheHitTokens?: number; cacheMissTokens?: number; reasoningTokens?: number; cost?: number; currency?: string; cachePrefixChanged?: boolean; cachePrefixReasons?: string[]; cacheHitRate?: number; estimated: boolean; message: string }
  | { type: "context_usage_event"; seq: number; timestamp: string; branchId?: string; source: "local_estimate"; inputTokens: number; contextWindowTokens: number; contextUsedPercent: number; estimated: true; message: string }
  | { type: "skill_used"; seq: number; timestamp: string; branchId?: string; skillName: string; filePath: string; message: string }
  | { type: "skill_event"; seq: number; timestamp: string; branchId?: string; action: string; message: string }
  | { type: "mcp_elicitation_request"; seq: number; timestamp: string; branchId?: string; elicitationId: string; serverId: string; serverName: string; message: string; requestedSchema?: Record<string, unknown>; status: "pending"; expiresAt: string }
  | { type: "mcp_elicitation_response"; seq: number; timestamp: string; branchId?: string; elicitationId: string; serverId: string; serverName: string; action: "accept" | "decline" | "cancel" | "timeout"; message: string }
  | { type: "compaction_block"; seq: number; timestamp: string; branchId?: string; coversEvents: [number, number]; summary: string }
  | { type: "trigger_event"; seq: number; timestamp: string; branchId?: string; triggerKind: string; payload: Record<string, unknown> };
