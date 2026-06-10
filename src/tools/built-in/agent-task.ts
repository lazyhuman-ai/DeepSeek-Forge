import type { ModelMessage } from "../../agent/model-provider.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { SessionEvent } from "../../streams/event-types.js";
import { buildWorkspaceActivitySummary } from "../../workspace/activity-manager.js";
import type { ExecutableToolDefinition, ToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

type SubagentType = "verify" | "explore" | "plan";
type SubagentToolMode = "none" | "read_only";

const MAX_CONTEXT_CHARS = 36_000;
const EVENT_PREVIEW_CHARS = 1_600;
const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 8_000;

const READ_ONLY_SUBAGENT_TOOLS = new Set([
  "read_file",
  "file_search",
  "glob",
  "grep",
  "git_diff",
  "lsp_query",
  "lsp_diagnostics",
  "verify_workspace",
  "workspace_review",
  "task_output",
]);

function subagentType(value: unknown): SubagentType {
  return value === "explore" || value === "plan" || value === "verify" ? value : "verify";
}

function subagentToolMode(value: unknown): SubagentToolMode {
  return value === "none" ? "none" : "read_only";
}

function preview(value: unknown, maxChars = EVENT_PREVIEW_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function eventSummary(event: SessionEvent): string {
  switch (event.type) {
    case "user_message":
      return `#${event.seq} user: ${preview(event.text)}`;
    case "assistant_message":
      return `#${event.seq} assistant: ${preview(event.text)}`;
    case "tool_call":
      return `#${event.seq} tool_call ${event.toolName}: ${preview(event.args, 800)}`;
    case "tool_result":
      return `#${event.seq} tool_result ${event.toolName}${event.isError ? " ERROR" : ""}: ${preview(event.result)}`;
    case "diff_event":
      return `#${event.seq} diff ${event.operation} ${event.filePath} (+${event.additions}/-${event.deletions})`;
    case "diagnostic_event":
      return `#${event.seq} diagnostics ${event.source} ${event.status}: ${event.message}`;
    case "verification_event":
      return `#${event.seq} check ${event.status} ${event.command}: ${event.summary}`;
    case "todo_event":
      return `#${event.seq} todos: ${event.items.map((item) => `[${item.status}] ${item.content}`).join(" | ")}`;
    case "activity_event":
      return `#${event.seq} activity ${event.activityKind}/${event.status}: ${event.title} - ${event.message}`;
    case "shell_task_event":
      return `#${event.seq} shell_task ${event.taskId}/${event.status}: ${event.message}`;
    case "worktree_event":
      return `#${event.seq} worktree ${event.action}: ${event.message}`;
    case "runtime_event":
      return `#${event.seq} runtime ${event.runtimeKind}/${event.detail}: ${event.message}`;
    case "artifact_pointer":
      return `#${event.seq} artifact ${event.artifactId}: ${event.mimeType}, ${event.sizeBytes} bytes`;
    default:
      return `#${event.seq} ${event.type}`;
  }
}

function boundedThreadContext(events: SessionEvent[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const event of [...events].reverse()) {
    const line = eventSummary(event);
    total += line.length + 1;
    if (total > MAX_CONTEXT_CHARS) break;
    lines.push(line);
  }
  return lines.reverse().join("\n");
}

function systemPrompt(kind: SubagentType, toolMode: SubagentToolMode): string {
  const base = [
    "You are a constrained read-only ForgeAgent workspace subagent.",
    "You must not edit files, write persistent state, launch external runtimes, install packages, change git state, or ask the user.",
    toolMode === "read_only"
      ? "You may use only the provided read/search/LSP/git-diff/verification tools. Unsafe tool requests will be rejected by ForgeAgent policy."
      : "You cannot use tools. You must reason only from the thread facts and workspace activity summary provided.",
    "Do not claim that code was inspected, commands ran, or tests passed unless either the provided facts or your own tool results show that.",
    "Return concise, actionable output for the main Agent. Do not address the user directly unless asked.",
  ];

  if (kind === "verify") {
    base.push(
      "Your job is adversarial verification: try to find why the main Agent's work may be incomplete or wrong.",
      "Act like a skeptical release reviewer, not a co-author defending the change.",
      "If evidence is missing, stale, narrow, or only implied by intent, treat it as not proven.",
      "Check whether the latest diffs are covered by diagnostics, real checks, tests, browser verification, or other task-appropriate evidence.",
      "Prefer using read-only tools to inspect diffs, files, diagnostics, task output, and verification records before reaching a verdict.",
      "Do not accept LSP diagnostics alone as proof of correctness after nontrivial workspace changes; require a strong check when one is available.",
      "When bash or verify_workspace is available, run or inspect real verification commands instead of only reading code. A passing test suite is useful context, but it is not enough by itself when the change needs direct behavioral evidence.",
      "Adapt the verification method to the work: frontend changes need browser or DOM evidence when possible; backend/API changes need endpoint/output shape checks; CLI/script changes need representative command invocations; refactors need existing tests and public API spot checks; document/browser/MCP/Blender/research work needs artifact/runtime/source evidence.",
      "Before PASS, include at least one task-appropriate adversarial probe, boundary case, regression check, or explicit explanation why no such probe is possible in this context.",
      "Look for edge cases, stale reads, unverified files, missing tests, suspicious permissions, generated artifacts that were not inspected, background tasks still running, and evidence that predates the latest diff.",
      "If the task is UI, browser, MCP, Blender, document, or research work rather than code, adapt the same skepticism to the relevant artifacts and runtime evidence.",
      "For each check you rely on, include the exact command/tool/evidence source, the observed output or durable event, and the result. Do not write PASS based only on source reading.",
      "Output exactly these sections: VERDICT, CHECKS, EVIDENCE, RISKS, REQUIRED NEXT ACTIONS.",
      "VERDICT must be PASS, PARTIAL, or FAIL. PASS requires explicit evidence of relevant checks after the latest changes.",
      "Use FAIL when the work is contradicted by evidence, PARTIAL when the work might be correct but lacks enough proof, and PASS only when the evidence is current and task-relevant.",
    );
  } else if (kind === "explore") {
    base.push(
      "Your job is exploration: identify relevant files, facts, errors, and likely next reads or checks.",
      "Output exactly these sections: FINDINGS, IMPORTANT CONTEXT, SUGGESTED NEXT READS, RISKS.",
    );
  } else {
    base.push(
      "Your job is planning: produce a concrete implementation and verification plan.",
      "Output exactly these sections: PLAN, FILES/TOOLS, VALIDATION, RISKS.",
    );
  }
  return base.join("\n");
}

function allowedSubagentTools(context?: ToolExecutionContext): ToolDefinition[] {
  const tools = context?.toolsProvider?.() ?? [];
  return tools.filter((tool) => {
    if (READ_ONLY_SUBAGENT_TOOLS.has(tool.name)) return true;
    if (tool.name === "bash") return true;
    return false;
  });
}

function stringifyToolResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "(no output)";
  return text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n... [subagent tool result truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

function toolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

type VerifyVerdict = "PASS" | "PARTIAL" | "FAIL" | "UNKNOWN";

function parseVerifyVerdict(text: string): VerifyVerdict {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*VERDICT\b/i.test(candidate));
  if (!line) return "UNKNOWN";
  const match = line.match(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*VERDICT\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASS|PARTIAL|FAIL)\b/i);
  return match ? (match[1]!.toUpperCase() as VerifyVerdict) : "UNKNOWN";
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const provider = context?.modelProvider;
  if (!provider) {
    return {
      output: "agent_task cannot run because no ModelProvider is available in the tool execution context.",
      isError: true,
    };
  }
  const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : "";
  if (!task) return { output: "task is required.", isError: true };
  const kind = subagentType(args.subagent_type);
  const toolMode = subagentToolMode(args.tool_mode);
  const events = context?.readThread?.(sessionId) ?? [];
  const activitySummary = buildWorkspaceActivitySummary(sessionId, events, context?.branchId);
  const tools = toolMode === "read_only" ? allowedSubagentTools(context) : [];
  const availableToolMap = toolMap(tools);
  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt(kind, tools.length > 0 ? toolMode : "none") },
    {
      role: "user",
      content: [
        `<subagent_type>${kind}</subagent_type>`,
        `<task>${task}</task>`,
        activitySummary.trim() ? `<workspace_activity_summary>\n${activitySummary}\n</workspace_activity_summary>` : "",
        `<recent_thread_facts>\n${boundedThreadContext(events)}\n</recent_thread_facts>`,
      ].filter(Boolean).join("\n\n"),
    },
  ];

  let responseText = "";
  const toolCalls: Array<{ name: string; isError: boolean }> = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await provider.generate(
      messages,
      tools.length > 0 ? tools : undefined,
      context?.signal ? { signal: context.signal } : undefined,
    );
    if (response.finishReason !== "tool_calls") {
      responseText = response.text;
      break;
    }
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        output: "Subagent returned finishReason=tool_calls without tool call payload.",
        isError: true,
      };
    }
    if (tools.length === 0 || !context?.toolExecutor) {
      return {
        output: "Subagent attempted to call tools, but no read-only subagent tools are available in this context.",
        isError: true,
      };
    }
    messages.push({
      role: "assistant",
      content: response.text,
      tool_calls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      const allowed = availableToolMap.get(call.name);
      if (!allowed) {
        const denied = `Subagent tool denied before execution.\nTool: ${call.name}\nReason: This tool is not in the read-only subagent allowlist.\nRecovery: Use read_file, file_search, grep, glob, git_diff, lsp_query, lsp_diagnostics, verify_workspace, workspace_review, task_output, or bash with a safe read/check command.`;
        toolCalls.push({ name: call.name, isError: true });
        messages.push({ role: "tool", tool_call_id: call.id, content: denied });
        continue;
      }
      const result = await context.toolExecutor.execute(call.name, call.args, sessionId, {
        ...context,
        toolUseId: call.id,
        source: {
          ...(context.source ?? { kind: "system" as const }),
          interactive: false,
        },
      });
      toolCalls.push({ name: call.name, isError: result.isError });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: [
          `Tool: ${result.toolName}`,
          `isError: ${result.isError ? "true" : "false"}`,
          "Output:",
          stringifyToolResult(result.output),
        ].join("\n"),
      });
    }
  }

  if (!responseText.trim()) {
    return {
      output: "Subagent did not produce a final response after the bounded tool loop.",
      isError: true,
    };
  }
  const verdict = kind === "verify" ? parseVerifyVerdict(responseText) : undefined;
  const failedVerification = verdict !== undefined && verdict !== "PASS";
  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
    activityKind: kind === "verify" ? "verification" : "plan",
    status: failedVerification ? "failed" : "completed",
    title: `Subagent ${kind}`,
    message: responseText.slice(0, 500),
    payload: {
      subagentType: kind,
      task,
      toolMode: tools.length > 0 ? toolMode : "none",
      toolCalls,
      ...(verdict !== undefined ? { verdict } : {}),
    },
  });
  if (failedVerification) {
    return {
      output: verdict === "UNKNOWN"
        ? [
          "Subagent verification did not produce a valid VERDICT line.",
          "Expected: VERDICT: PASS, VERDICT: PARTIAL, or VERDICT: FAIL.",
          "",
          responseText,
        ].join("\n")
        : responseText,
      isError: true,
    };
  }
  return responseText;
}

export const agentTaskTool: ExecutableToolDefinition = buildTool({
  name: "agent_task",
  description: "Runs a constrained read-only model subagent for independent workspace verification, exploration, or planning. It may use only approved read/search/LSP/git-diff/verification tools when available and records a workspace activity event.",
  params: {
    subagent_type: {
      type: "string",
      description: "verify, explore, or plan. Defaults to verify.",
      optional: true,
    },
    tool_mode: {
      type: "string",
      description: "read_only or none. Defaults to read_only when ForgeAgent can provide constrained subagent tools.",
      optional: true,
    },
    task: {
      type: "string",
      description: "Concrete read-only subtask for the subagent.",
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: true,
});
