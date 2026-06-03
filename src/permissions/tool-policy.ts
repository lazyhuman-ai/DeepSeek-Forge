import type {
  PermissionRequestEvent,
  PermissionResponseEvent,
} from "../streams/event-types.js";
import type { ToolCapability, ToolDefinition } from "../tools/schemas.js";
import { getSensitivePathReason } from "../sandbox/path-sandbox.js";

export type ToolRequestSource = {
  kind: "http" | "repl" | "cli" | "trigger" | "system" | "unknown";
  interactive?: boolean;
  deviceId?: string;
  deviceKind?: string;
  deviceName?: string;
};

export type ToolPolicyDecisionKind = "allow" | "ask" | "deny";

export type ToolPolicyRule = {
  id: string;
  decision: ToolPolicyDecisionKind;
  reason: string;
  toolName?: string;
  capability?: ToolCapability;
  subjectIncludes?: string;
};

export type PermissionResponseDecision =
  | "allow_once"
  | "allow_session"
  | "deny";

export type PermissionResolutionDecision =
  | PermissionResponseDecision
  | "timeout"
  | "aborted"
  | "noninteractive";

export type PermissionRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "aborted";

export type PublicPermissionRequest = {
  id: string;
  sessionId: string;
  branchId?: string;
  toolName: string;
  toolUseId?: string;
  action: string;
  subject: string;
  message: string;
  reason: string;
  options: PermissionResponseDecision[];
  status: PermissionRequestStatus;
  createdAt: string;
  expiresAt: string;
  source?: ToolRequestSource;
};

export type ToolPolicyInput = {
  sessionId: string;
  branchId?: string;
  toolUseId?: string;
  tool: ToolDefinition;
  args: Record<string, unknown>;
  source?: ToolRequestSource;
};

export type ToolPolicyDecision = {
  decision: ToolPolicyDecisionKind;
  reason: string;
  action: string;
  subject: string;
};

export type ToolPermissionResult =
  | { allowed: true }
  | { allowed: false; message: string };

type PendingRequest = PublicPermissionRequest & {
  resolve: (decision: PermissionResolutionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type PermissionBrokerOptions = {
  timeoutMs?: number;
  rules?: ToolPolicyRule[];
  nextSeq: () => number;
  now: () => string;
  appendSessionEvent: (
    sessionId: string,
    event: PermissionRequestEvent | PermissionResponseEvent,
  ) => void;
  appendSystemEvent?: (detail: string, message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 60_000;

const ASK_CAPABILITIES = new Set<ToolCapability>([
  "fs.write",
  "process.exec",
  "network.http",
  "memory.write",
  "scheduler.write",
  "runtime.browser",
  "mcp.tool",
  "mcp.server.launch",
  "mcp.sampling",
  "mcp.elicitation",
]);

const READ_CAPABILITIES = new Set<ToolCapability>([
  "fs.read",
  "memory.read",
  "scheduler.read",
  "artifact.read",
  "user.prompt",
  "mcp.resource.read",
  "mcp.prompt.read",
]);

function capabilityAction(capabilities: ToolCapability[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "tool.execute";
}

function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function subjectFromArgs(toolName: string, args: Record<string, unknown>): string {
  const command = firstString(args, ["command"]);
  if (command) return `Command: ${command}`;
  const path = firstString(args, ["file_path", "path"]);
  if (path) return `Path: ${path}`;
  const url = firstString(args, ["url"]);
  if (url) return `URL: ${url}`;
  const artifact = firstString(args, ["artifact_id"]);
  if (artifact) return `Artifact: ${artifact}`;
  return `Tool: ${toolName}`;
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  return firstString(args, ["file_path", "path"]);
}

function decisionRank(decision: ToolPolicyDecisionKind): number {
  if (decision === "deny") return 3;
  if (decision === "ask") return 2;
  return 1;
}

function ruleMatches(
  rule: ToolPolicyRule,
  input: ToolPolicyInput,
  capabilities: ToolCapability[],
  subject: string,
): boolean {
  if (rule.toolName && rule.toolName !== input.tool.name) return false;
  if (rule.capability && !capabilities.includes(rule.capability)) return false;
  if (rule.subjectIncludes && !subject.includes(rule.subjectIncludes)) return false;
  return true;
}

function sessionAllowanceKey(input: ToolPolicyInput, action: string, subject: string): string {
  return `${input.sessionId}\u0000${input.tool.name}\u0000${action}\u0000${subject}`;
}

export class ToolPolicyManager {
  #rules: ToolPolicyRule[] = [];
  #sessionAllowances = new Set<string>();
  #dangerouslyAllowedSessions = new Set<string>();

  constructor(options?: { rules?: ToolPolicyRule[] }) {
    this.#rules = [...(options?.rules ?? [])];
  }

  addRule(rule: ToolPolicyRule): void {
    this.#rules.push(rule);
  }

  allowForSession(input: ToolPolicyInput, action: string, subject: string): void {
    this.#sessionAllowances.add(sessionAllowanceKey(input, action, subject));
  }

  setDangerouslyAllowAllTools(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.#dangerouslyAllowedSessions.add(sessionId);
    } else {
      this.#dangerouslyAllowedSessions.delete(sessionId);
    }
  }

  isDangerouslyAllowingAllTools(sessionId: string): boolean {
    return this.#dangerouslyAllowedSessions.has(sessionId);
  }

  evaluate(input: ToolPolicyInput): ToolPolicyDecision {
    const capabilities = input.tool.capabilities ?? [];
    const action = capabilityAction(capabilities);
    const subject = subjectFromArgs(input.tool.name, input.args);

    if (this.#sessionAllowances.has(sessionAllowanceKey(input, action, subject))) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "This exact tool request was approved for the current session.",
      };
    }

    const matched = this.#rules
      .filter((rule) => ruleMatches(rule, input, capabilities, subject))
      .sort((a, b) => decisionRank(b.decision) - decisionRank(a.decision))[0];
    if (matched?.decision === "deny") {
      return {
        decision: matched.decision,
        action,
        subject,
        reason: matched.reason,
      };
    }

    if (this.#dangerouslyAllowedSessions.has(input.sessionId)) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Dangerous free mode is enabled for this session; approval prompts are bypassed.",
      };
    }

    if (matched) {
      return {
        decision: matched.decision,
        action,
        subject,
        reason: matched.reason,
      };
    }

    const requestedPath = pathFromArgs(input.args);
    if (requestedPath) {
      const sensitive = getSensitivePathReason(requestedPath);
      if (sensitive) {
        return {
          decision: "ask",
          action,
          subject,
          reason: sensitive,
        };
      }
    }

    if (capabilities.some((capability) => ASK_CAPABILITIES.has(capability))) {
      return {
        decision: "ask",
        action,
        subject,
        reason: "This tool capability requires user approval before execution.",
      };
    }

    if (
      capabilities.length === 0 ||
      capabilities.every((capability) => READ_CAPABILITIES.has(capability))
    ) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Read-only tool request is allowed by default policy.",
      };
    }

    return {
      decision: "ask",
      action,
      subject,
      reason: "This tool request is not covered by an allow policy and requires user approval.",
    };
  }
}

export class PermissionBroker {
  #policy: ToolPolicyManager;
  #timeoutMs: number;
  #nextSeq: () => number;
  #now: () => string;
  #appendSessionEvent: PermissionBrokerOptions["appendSessionEvent"];
  #appendSystemEvent: PermissionBrokerOptions["appendSystemEvent"];
  #pending = new Map<string, PendingRequest>();

  constructor(options: PermissionBrokerOptions) {
    this.#policy = new ToolPolicyManager(
      options.rules !== undefined ? { rules: options.rules } : undefined,
    );
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#nextSeq = options.nextSeq;
    this.#now = options.now;
    this.#appendSessionEvent = options.appendSessionEvent;
    this.#appendSystemEvent = options.appendSystemEvent;
  }

  get policy(): ToolPolicyManager {
    return this.#policy;
  }

  getPendingRequests(): PublicPermissionRequest[] {
    return [...this.#pending.values()].map((request) => this.#publicRequest(request));
  }

  setDangerouslyAllowAllTools(sessionId: string, enabled: boolean): void {
    this.#policy.setDangerouslyAllowAllTools(sessionId, enabled);
  }

  isDangerouslyAllowingAllTools(sessionId: string): boolean {
    return this.#policy.isDangerouslyAllowingAllTools(sessionId);
  }

  approvePendingRequestsForSession(
    sessionId: string,
    response: {
      message?: string;
      deviceId?: string;
      deviceName?: string;
    } = {},
  ): PublicPermissionRequest[] {
    const pending = [...this.#pending.values()].filter((request) => request.sessionId === sessionId);
    for (const request of pending) {
      this.#resolveRequest(
        request.id,
        "allow_session",
        response.message ?? "Permission approved by dangerous free mode.",
        response.deviceId,
        response.deviceName,
      );
    }
    return pending.map((request) => ({
      ...this.#publicRequest(request),
      status: "approved" as const,
    }));
  }

  abortAll(message = "Permission request aborted by Core shutdown."): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#resolveRequest(requestId, "aborted", message);
    }
  }

  async authorize(
    input: ToolPolicyInput,
    signal?: AbortSignal,
  ): Promise<ToolPermissionResult> {
    const decision = this.#policy.evaluate(input);
    if (decision.decision === "allow") return { allowed: true };
    if (decision.decision === "deny") {
      return {
        allowed: false,
        message: buildPermissionDeniedMessage(input.tool.name, decision, "Matched deny policy."),
      };
    }

    const request = this.#createRequest(input, decision, signal);
    this.#appendRequestEvent(request);

    const interactive = input.source?.interactive === true;
    if (!interactive) {
      const resolution: PermissionResolutionDecision = "noninteractive";
      this.#resolveRequest(request.id, resolution, "This turn has no interactive approval channel.");
      return {
        allowed: false,
        message: buildPermissionDeniedMessage(
          input.tool.name,
          decision,
          "This action requires user approval, but this turn has no interactive approval channel.",
        ),
      };
    }

    const resolution = await new Promise<PermissionResolutionDecision>((resolve) => {
      request.resolve = resolve;
      if (signal) {
        const onAbort = (): void => {
          this.#resolveRequest(request.id, "aborted", "Permission request aborted by turn interrupt.");
        };
        request.onAbort = onAbort;
        request.signal = signal;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    if (resolution === "allow_once") return { allowed: true };
    if (resolution === "allow_session") {
      this.#policy.allowForSession(input, decision.action, decision.subject);
      return { allowed: true };
    }

    const reason = resolution === "timeout"
      ? "The approval request timed out."
      : resolution === "aborted"
        ? "The approval request was aborted."
        : "The approval request was denied.";
    return {
      allowed: false,
      message: buildPermissionDeniedMessage(input.tool.name, decision, reason),
    };
  }

  respondToPermissionRequest(
    requestId: string,
    response: {
      decision: PermissionResponseDecision;
      message?: string;
      deviceId?: string;
      deviceName?: string;
    },
  ): PublicPermissionRequest {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new Error(`Permission request is not pending: ${requestId}`);
    const message = response.message ?? (
      response.decision === "deny"
        ? "Permission denied by user."
        : "Permission approved by user."
    );
    this.#resolveRequest(
      requestId,
      response.decision,
      message,
      response.deviceId,
      response.deviceName,
    );
    return {
      ...this.#publicRequest(pending),
      status: response.decision === "deny" ? "denied" : "approved",
    };
  }

  #createRequest(
    input: ToolPolicyInput,
    decision: ToolPolicyDecision,
    signal: AbortSignal | undefined,
  ): PendingRequest {
    const id = crypto.randomUUID();
    const createdAt = this.#now();
    const expiresAt = new Date(Date.parse(createdAt) + this.#timeoutMs).toISOString();
    const request: PendingRequest = {
      id,
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      toolName: input.tool.name,
      action: decision.action,
      subject: decision.subject,
      message: buildPermissionRequestMessage(input.tool.name, decision),
      reason: decision.reason,
      options: ["allow_once", "allow_session", "deny"],
      status: "pending",
      createdAt,
      expiresAt,
      resolve: () => undefined,
      timer: setTimeout(() => {
        this.#resolveRequest(id, "timeout", "Permission request timed out.");
      }, this.#timeoutMs),
    };
    if (input.toolUseId !== undefined) request.toolUseId = input.toolUseId;
    if (input.branchId !== undefined) request.branchId = input.branchId;
    if (input.source !== undefined) request.source = input.source;
    if (signal !== undefined) request.signal = signal;
    this.#pending.set(id, request);
    return request;
  }

  #appendRequestEvent(request: PendingRequest): void {
    const event: PermissionRequestEvent = {
      type: "permission_request",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: request.sessionId,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      permissionRequestId: request.id,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      message: request.message,
      reason: request.reason,
      options: request.options,
      status: "pending",
      expiresAt: request.expiresAt,
    };
    if (request.toolUseId !== undefined) event.toolUseId = request.toolUseId;
    if (request.source !== undefined) event.source = request.source;
    this.#appendSessionEvent(request.sessionId, event);
    this.#appendSystemEvent?.("permission_request", `${request.sessionId}: ${request.message}`);
  }

  #resolveRequest(
    requestId: string,
    decision: PermissionResolutionDecision,
    message: string,
    deviceId?: string,
    deviceName?: string,
  ): void {
    const request = this.#pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    this.#pending.delete(requestId);

    const status: PermissionRequestStatus =
      decision === "allow_once" || decision === "allow_session"
        ? "approved"
        : decision === "timeout"
          ? "expired"
          : decision === "aborted"
            ? "aborted"
            : "denied";

    const event: PermissionResponseEvent = {
      type: "permission_response",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: request.sessionId,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      permissionRequestId: request.id,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      decision,
      status,
      message,
    };
    if (request.toolUseId !== undefined) event.toolUseId = request.toolUseId;
    if (deviceId !== undefined) event.deviceId = deviceId;
    if (deviceName !== undefined) event.deviceName = deviceName;
    this.#appendSessionEvent(request.sessionId, event);
    this.#appendSystemEvent?.("permission_response", `${request.sessionId}: ${message}`);
    request.resolve(decision);
  }

  #publicRequest(request: PendingRequest): PublicPermissionRequest {
    const publicRequest: PublicPermissionRequest = {
      id: request.id,
      sessionId: request.sessionId,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      message: request.message,
      reason: request.reason,
      options: [...request.options],
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
    if (request.toolUseId !== undefined) publicRequest.toolUseId = request.toolUseId;
    if (request.branchId !== undefined) publicRequest.branchId = request.branchId;
    if (request.source !== undefined) publicRequest.source = request.source;
    return publicRequest;
  }
}

function buildPermissionRequestMessage(
  toolName: string,
  decision: ToolPolicyDecision,
): string {
  return [
    "Tool permission required before execution.",
    `Tool: ${toolName}`,
    `Requested action: ${decision.action}`,
    decision.subject,
    `Reason: ${decision.reason}`,
  ].join("\n");
}

export function buildPermissionDeniedMessage(
  toolName: string,
  decision: ToolPolicyDecision,
  reason: string,
): string {
  return [
    "Tool permission denied before execution.",
    `Tool: ${toolName}`,
    `Requested action: ${decision.action}`,
    decision.subject,
    `Reason: ${reason}`,
    "Recovery: Ask the user for approval, choose a less privileged tool or command, or operate inside the allowed workspace.",
  ].join("\n");
}
