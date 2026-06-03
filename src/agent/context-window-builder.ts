import type { SessionEvent, ToolCall, ToolResult } from "../streams/event-types.js";
import type { ModelMessage, ToolCallRequest } from "./model-provider.js";

function toolResultId(event: ToolResult): string {
  return event.toolUseId ?? `call_${event.seq - 1}`;
}

function appendToolResult(messages: ModelMessage[], event: ToolResult): void {
  messages.push({
    role: "tool",
    content: typeof event.result === "string"
      ? event.result
      : JSON.stringify(event.result),
    tool_call_id: toolResultId(event),
  });
}

function appendNonToolCallEvent(messages: ModelMessage[], event: SessionEvent): void {
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
      appendToolResult(messages, event);
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

export function buildContext(events: SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;

    if (event.type !== "tool_call") {
      appendNonToolCallEvent(messages, event);
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
        appendToolResult(messages, result);
      }
      for (const buffered of bufferedEvents) {
        appendNonToolCallEvent(messages, buffered);
      }
      i = j;
    }
  }

  return messages;
}
