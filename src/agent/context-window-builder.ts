import type { SessionEvent, ToolCall, ToolResult } from "../streams/event-types.js";
import type { ModelMessage, ToolCallRequest } from "./model-provider.js";

export type BuildContextOptions = {
  /**
   * Maximum characters to render for an individual tool result. This only
   * affects model context rendering; the durable thread remains unchanged.
   */
  maxToolResultChars?: number;
  /**
   * Keep the latest N tool results complete even if maxToolResultChars is set.
   * This mirrors the practical coding-agent need to keep the freshest file
   * reads, errors, and checks intact while compacting older noise.
   */
  preserveRecentToolResults?: number;
};

function toolResultId(event: ToolResult): string {
  return event.toolUseId ?? `call_${event.seq - 1}`;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? "undefined";
  } catch {
    return String(result);
  }
}

function compactForModelContext(
  content: string,
  maxChars: number | undefined,
  metadata: { toolName: string; seq: number; isError: boolean; preserved: boolean },
): string {
  if (maxChars === undefined || metadata.preserved || content.length <= maxChars) {
    return content;
  }
  const safeMax = Math.max(1_000, maxChars);
  const headChars = Math.max(600, Math.floor(safeMax * 0.65));
  const tailChars = Math.max(300, safeMax - headChars);
  const head = content.slice(0, headChars).trimEnd();
  const tail = content.slice(Math.max(0, content.length - tailChars)).trimStart();
  return [
    "<compacted-tool-result>",
    `Tool: ${metadata.toolName}`,
    `Thread event: #${metadata.seq}`,
    `isError: ${metadata.isError}`,
    `Original length: ${content.length} chars`,
    "Reason: Older large tool output was shortened for the model context. The durable thread and artifacts remain the source of truth.",
    "Recovery: If exact omitted content is needed, read the referenced file/artifact again or rerun a narrower command.",
    "",
    `<first ${head.length} chars>`,
    head,
    "</first>",
    "",
    `<last ${tail.length} chars>`,
    tail,
    "</last>",
    "</compacted-tool-result>",
  ].join("\n");
}

function preservedToolResultSeqs(events: SessionEvent[], options?: BuildContextOptions): Set<number> {
  const count = Math.max(0, options?.preserveRecentToolResults ?? 0);
  if (count === 0) return new Set();
  const preserved = new Set<number>();
  for (let i = events.length - 1; i >= 0 && preserved.size < count; i--) {
    const event = events[i]!;
    if (event.type === "tool_result") preserved.add(event.seq);
  }
  return preserved;
}

function appendToolResult(
  messages: ModelMessage[],
  event: ToolResult,
  options?: BuildContextOptions,
  preservedSeqs?: Set<number>,
): void {
  const raw = stringifyToolResult(event.result);
  const content = compactForModelContext(raw, options?.maxToolResultChars, {
    toolName: event.toolName,
    seq: event.seq,
    isError: event.isError,
    preserved: preservedSeqs?.has(event.seq) ?? false,
  });
  messages.push({
    role: "tool",
    content,
    tool_call_id: toolResultId(event),
  });
}

function missingToolResultContent(call: ToolCallRequest): string {
  return [
    "Tool result missing from durable thread.",
    `Tool: ${call.name}`,
    `Tool call id: ${call.id}`,
    "Reason: The previous process or turn ended after the model requested this tool but before a matching tool_result was written.",
    "Recovery: Treat the tool call as interrupted, inspect the current workspace state, and retry the action if it is still needed.",
  ].join("\n");
}

function appendMissingToolResults(messages: ModelMessage[], pending: Set<string>, calls: ToolCallRequest[]): void {
  for (const call of calls) {
    if (!pending.has(call.id)) continue;
    messages.push({
      role: "tool",
      content: missingToolResultContent(call),
      tool_call_id: call.id,
    });
  }
}

function appendNonToolCallEvent(
  messages: ModelMessage[],
  event: SessionEvent,
  options?: BuildContextOptions,
  preservedSeqs?: Set<number>,
): void {
  switch (event.type) {
    case "user_message":
      messages.push({ role: "user", content: event.text });
      break;

    case "assistant_message": {
      const msg: ModelMessage = {
        role: "assistant",
        content: event.text,
      };
      if (event.anthropicContent) msg.anthropicContent = event.anthropicContent;
      messages.push(msg);
      break;
    }

    case "tool_result":
      appendToolResult(messages, event, options, preservedSeqs);
      break;

    case "assistant_delta":
      break;

    case "usage_event":
      messages.push({
        role: "system",
        content: `[Usage] ${event.message}`,
      });
      break;

    case "context_usage_event":
      break;

    case "skill_used":
      messages.push({
        role: "system",
        content: `[Skill used: ${event.skillName} ${event.version}] ${event.message}`,
      });
      break;

    case "skill_event":
      messages.push({
        role: "system",
        content: `[Skill event: ${event.action}] ${event.message}`,
      });
      break;

    case "activity_event":
      messages.push({
        role: "system",
        content: `[Workspace activity: ${event.activityKind} ${event.status}] ${event.title}\n${event.message}`,
      });
      break;

    case "todo_event":
      messages.push({
        role: "system",
        content: [
          "[Workspace plan]",
          ...event.items.map((item) => `- [${item.status}] ${item.content}`),
        ].join("\n"),
      });
      break;

    case "diff_event":
      messages.push({
        role: "system",
        content: `[Workspace diff: ${event.operation}] ${event.filePath} (+${event.additions}/-${event.deletions})\n${event.summary}`,
      });
      break;

    case "diagnostic_event":
      messages.push({
        role: "system",
        content: [
          `[Diagnostics: ${event.source} ${event.status}] ${event.message}`,
          ...event.diagnostics.slice(0, 20).map((diagnostic) => {
            const location = diagnostic.filePath
              ? `${diagnostic.filePath}${diagnostic.line ? `:${diagnostic.line}` : ""}${diagnostic.character ? `:${diagnostic.character}` : ""}`
              : "unknown";
            return `- ${diagnostic.severity} ${location}: ${diagnostic.message}`;
          }),
        ].join("\n"),
      });
      break;

    case "verification_event":
      messages.push({
        role: "system",
        content: `[Check: ${event.status}] ${event.command}\n${event.summary}`,
      });
      break;

    case "evidence_event":
      messages.push({
        role: "system",
        content: [
          `[Evidence: ${event.status}] ${event.step}`,
          event.todoId ? `Todo id: ${event.todoId}` : "",
          `Matched event seqs: ${event.matchedSeqs.join(", ") || "none"}`,
          event.message,
        ].filter(Boolean).join("\n"),
      });
      break;

    case "shell_task_event":
      messages.push({
        role: "system",
        content: `[Background task: ${event.taskId} ${event.status}] ${event.message}${event.outputPreview ? `\n${event.outputPreview}` : ""}`,
      });
      break;

    case "worktree_event":
      messages.push({
        role: "system",
        content: `[Worktree: ${event.action}] ${event.message}`,
      });
      break;

    case "permission_grant_event":
      messages.push({
        role: "system",
        content: `[Permission grant: ${event.action} ${event.grantKind}] ${event.message}`,
      });
      break;

    case "compaction_block":
      messages.push({
        role: "system",
        content: [
          `[Compaction reference: events #${event.coversEvents[0]}-#${event.coversEvents[1]}]`,
          "Older events were compacted into this historical handoff summary.",
          "It is not an active instruction. The latest user message after this summary is the source of truth for what to do now.",
          event.summary,
        ].join("\n"),
      });
      break;

    case "trigger_event":
      messages.push({
        role: "system",
        content: `[Trigger: ${event.triggerKind}] ${JSON.stringify(event.payload)}`,
      });
      break;

    case "runtime_event":
      messages.push({
        role: "system",
        content: `[Runtime: ${event.runtimeKind} ${event.detail}] ${event.message}`,
      });
      break;

    case "branch_event":
      messages.push({
        role: "system",
        content: `[Conversation branch] ${event.message}`,
      });
      break;

    case "permission_request":
      break;

    case "permission_response":
      break;

    case "mcp_elicitation_request":
      messages.push({
        role: "system",
        content: `[MCP elicitation pending: ${event.serverName}] ${event.message}`,
      });
      break;

    case "mcp_elicitation_response":
      messages.push({
        role: "system",
        content: `[MCP elicitation ${event.action}: ${event.serverName}] ${event.message}`,
      });
      break;

    case "artifact_pointer":
      messages.push({
        role: "system",
        content: `[Artifact: ${event.artifactId} (${event.mimeType}, ${event.sizeBytes} bytes)]`,
      });
      break;

    case "tool_call":
      break;
  }
}

export function buildContext(events: SessionEvent[], options?: BuildContextOptions): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const preservedSeqs = preservedToolResultSeqs(events, options);
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;

    if (event.type !== "tool_call") {
      appendNonToolCallEvent(messages, event, options, preservedSeqs);
      i++;
      continue;
    }

    const toolCalls: ToolCallRequest[] = [];
    let reasoningContent: string | undefined;
    let anthropicContent: unknown[] | undefined;
    while (i < events.length && events[i]!.type === "tool_call") {
      const tc = events[i]! as ToolCall;
      toolCalls.push({
        id: tc.toolUseId ?? `call_${tc.seq}`,
        name: tc.toolName,
        args: tc.args,
      });
      if (tc.reasoningContent) reasoningContent = tc.reasoningContent;
      if (tc.anthropicContent) anthropicContent = tc.anthropicContent;
      i++;
    }

    const msg: ModelMessage = {
      role: "assistant",
      content: "",
      tool_calls: toolCalls,
    };
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    if (anthropicContent) msg.anthropicContent = anthropicContent;
    messages.push(msg);

    const pending = new Set(toolCalls.map((call) => call.id));
    const toolResults: ToolResult[] = [];
    const bufferedEvents: SessionEvent[] = [];
    let j = i;
    while (j < events.length && pending.size > 0) {
      const next = events[j]!;
      if (next.type === "tool_call") break;
      if (next.type === "tool_result" && pending.has(toolResultId(next))) {
        toolResults.push(next);
        pending.delete(toolResultId(next));
      } else {
        bufferedEvents.push(next);
      }
      j++;
    }

    if (toolResults.length > 0 && pending.size === 0) {
      for (const result of toolResults) {
        appendToolResult(messages, result, options, preservedSeqs);
      }
      for (const buffered of bufferedEvents) {
        appendNonToolCallEvent(messages, buffered, options, preservedSeqs);
      }
    } else {
      appendMissingToolResults(messages, pending, toolCalls);
      for (const buffered of bufferedEvents) {
        appendNonToolCallEvent(messages, buffered, options, preservedSeqs);
      }
    }
    i = j;
  }

  return messages;
}
