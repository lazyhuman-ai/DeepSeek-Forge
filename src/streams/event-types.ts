// ── Session lifecycle ──

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_user"
  | "sleeping"
  | "blocked"
  | "archived";

export type StreamType =
  | "session_message"
  | "session_internal"
  | "core_system";

// ── Session entity ──

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

// ── Event base ──

type EventBase = {
  seq: number;
  timestamp: string;
  sessionId: string;
  branchId?: string;
};

// ── Session event variants ──

export type UserMessage = EventBase & {
  type: "user_message";
  text: string;
  variantOfSeq?: number;
};

export type AssistantMessage = EventBase & {
  type: "assistant_message";
  text: string;
  anthropicContent?: unknown[];
};

export type ToolCall = EventBase & {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  reasoningContent?: string;
  anthropicContent?: unknown[];
  toolUseId?: string;
};

export type ToolResult = EventBase & {
  type: "tool_result";
  toolName: string;
  result: unknown;
  isError: boolean;
  toolUseId?: string;
};

export type TriggerEvent = EventBase & {
  type: "trigger_event";
  triggerKind: "time" | "event" | "runtime" | "webhook" | "manual";
  payload: Record<string, unknown>;
};

export type RuntimeEvent = EventBase & {
  type: "runtime_event";
  runtimeKind: string;
  detail:
    | "connected"
    | "disconnected"
    | "degraded"
    | "recovered"
    | "failed"
    | "needs_auth"
    | "auth_started"
    | "auth_completed"
    | "catalog_changed"
    | "attached"
    | "detached"
    | "reattached"
    | "permission_mode";
  message: string;
  payload?: RuntimeEventPayload;
};

export type BranchEvent = EventBase & {
  type: "branch_event";
  sourceBranchId: string;
  sourceUserMessageSeq: number;
  variantOfSeq: number;
  newBranchId: string;
  message: string;
};

export type RuntimeTargetInfoPayload = {
  targetId: string;
  cdpSessionId: string;
};

export type RuntimeAttachmentPayload = {
  kind: "attachment";
  tabId: string;
  targetInfo: RuntimeTargetInfoPayload | null;
  previousTabId?: string;
  previousTargetInfo?: RuntimeTargetInfoPayload | null;
};

export type RuntimeBlockPayload = {
  kind: "runtime_block";
  blockedSession: boolean;
};

export type RuntimeRecoveredPayload = {
  kind: "runtime_recovered";
  recoveredSession: boolean;
};

export type RuntimeMcpPayload = {
  kind: "mcp";
  serverId?: string;
  serverName?: string;
  toolName?: string;
  transport?: string;
  status?: string;
  data?: Record<string, unknown>;
};

export type RuntimeEventPayload =
  | RuntimeAttachmentPayload
  | RuntimeBlockPayload
  | RuntimeRecoveredPayload
  | RuntimeMcpPayload;

export type McpElicitationRequestEvent = EventBase & {
  type: "mcp_elicitation_request";
  elicitationId: string;
  serverId: string;
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
  status: "pending";
  expiresAt: string;
};

export type McpElicitationResponseEvent = EventBase & {
  type: "mcp_elicitation_response";
  elicitationId: string;
  serverId: string;
  serverName: string;
  action: "accept" | "decline" | "cancel" | "timeout";
  message: string;
};

export type PermissionRequestEvent = EventBase & {
  type: "permission_request";
  permissionRequestId: string;
  toolName: string;
  action: string;
  subject: string;
  message: string;
  reason: string;
  options: Array<"allow_once" | "allow_session" | "deny">;
  status: "pending";
  expiresAt: string;
  toolUseId?: string;
  source?: {
    kind: "http" | "repl" | "cli" | "trigger" | "system" | "unknown";
    interactive?: boolean;
    deviceId?: string;
    deviceKind?: string;
    deviceName?: string;
  };
};

export type PermissionResponseEvent = EventBase & {
  type: "permission_response";
  permissionRequestId: string;
  toolName: string;
  action: string;
  subject: string;
  decision: "allow_once" | "allow_session" | "deny" | "timeout" | "aborted" | "noninteractive";
  status: "approved" | "denied" | "expired" | "aborted";
  message: string;
  toolUseId?: string;
  deviceId?: string;
  deviceName?: string;
};

export type ArtifactPointer = EventBase & {
  type: "artifact_pointer";
  artifactId: string;
  mimeType: string;
  sizeBytes: number;
};

export type CompactionBlock = EventBase & {
  type: "compaction_block";
  coversEvents: [number, number]; // [fromSeq, toSeq] inclusive
  summary: string;
};

export type AssistantDelta = EventBase & {
  type: "assistant_delta";
  text: string;
};

export type UsageEvent = EventBase & {
  type: "usage_event";
  usageRecordId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  reasoningTokens?: number;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  cost?: number;
  currency?: string;
  estimated: boolean;
  message: string;
};

export type ContextUsageEvent = EventBase & {
  type: "context_usage_event";
  source: "local_estimate";
  reason: "post_compaction";
  inputTokens: number;
  contextWindowTokens: number;
  contextUsedPercent: number;
  estimated: true;
  message: string;
};

export type SkillUsedEvent = EventBase & {
  type: "skill_used";
  skillName: string;
  packageId: string;
  version: string;
  trust: string;
  source: string;
  filePath: string;
  message: string;
};

export type SkillEvent = EventBase & {
  type: "skill_event";
  action:
    | "installed"
    | "updated"
    | "enabled"
    | "disabled"
    | "rollback"
    | "quarantined"
    | "rejected"
    | "source_added"
    | "source_removed"
    | "index_rebuilt"
    | "proposal_created"
    | "proposal_rejected"
    | "proposal_applied"
    | "evolution_degraded"
    | "evolution_recovered";
  skillName?: string;
  packageId?: string;
  status?: string;
  trust?: string;
  source?: string;
  message: string;
  payload?: Record<string, unknown>;
};

export type SessionEvent =
  | UserMessage
  | AssistantMessage
  | ToolCall
  | ToolResult
  | TriggerEvent
  | RuntimeEvent
  | BranchEvent
  | PermissionRequestEvent
  | PermissionResponseEvent
  | McpElicitationRequestEvent
  | McpElicitationResponseEvent
  | ArtifactPointer
  | CompactionBlock
  | AssistantDelta
  | UsageEvent
  | ContextUsageEvent
  | SkillUsedEvent
  | SkillEvent;

// ── System stream events ──

export type SystemEventCategory =
  | "runtime_lifecycle"
  | "core_lifecycle"
  | "agent_lifecycle"
  | "skill_lifecycle"
  | "mcp_lifecycle";

export type SystemEvent = {
  seq: number;
  timestamp: string;
  category: SystemEventCategory;
  detail: string;
  message: string;
};

// ── Supervisor transition events ──

export type SupervisorEvent =
  | { kind: "user_message" }
  | { kind: "turn_finished" }
  | { kind: "agent_ask_user" }
  | { kind: "agent_schedule_sleep" }
  | { kind: "runtime_failure" }
  | { kind: "user_reply" }
  | { kind: "trigger_fired" }
  | { kind: "trigger_scheduled" }
  | { kind: "triggers_empty" }
  | { kind: "runtime_recovered" }
  | { kind: "user_archive" }
  | { kind: "user_interrupt" }
  | { kind: "user_retry" };
