import type { ModelMessage } from "../../agent/model-provider.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { SessionEvent } from "../../streams/event-types.js";
import { buildWorkspaceActivitySummary } from "../../workspace/activity-manager.js";
import type { ExecutableToolDefinition, ToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PathSandbox } from "../../sandbox/path-sandbox.js";

type SubagentType = "verify" | "explore" | "plan" | "implement";
type SubagentToolMode = "none" | "read_only" | "workspace_write";
type BackgroundSubagentStatus = "running" | "completed" | "failed" | "cancelled";

type BackgroundSubagentTask = {
  id: string;
  sessionId: string;
  branchId?: string;
  subagentType: SubagentType;
  toolMode: SubagentToolMode;
  name?: string;
  cwd?: string;
  task: string;
  status: BackgroundSubagentStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  output?: string;
  outputFile?: string;
  stateFile?: string;
  isError?: boolean;
  error?: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
  controller?: AbortController;
  cancelRequested: boolean;
};

const MAX_CONTEXT_CHARS = 36_000;
const EVENT_PREVIEW_CHARS = 1_600;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_BACKGROUND_TASKS = 100;

const BACKGROUND_SUBAGENT_TASKS = new Map<string, BackgroundSubagentTask>();

function subagentActivityKind(kind: SubagentType): "analysis" | "change" | "plan" | "verification" {
  if (kind === "verify") return "verification";
  if (kind === "implement") return "change";
  if (kind === "plan") return "plan";
  return "analysis";
}

const READ_ONLY_SUBAGENT_TOOLS = new Set([
  "read_file",
  "file_search",
  "glob",
  "grep",
  "code_map",
  "dependency_graph",
  "git_diff",
  "lsp_query",
  "lsp_diagnostics",
  "verify_workspace",
  "workspace_review",
  "task_output",
  "agent_task_output",
  "bash",
]);

const WORKSPACE_WRITE_SUBAGENT_TOOLS = new Set([
  ...READ_ONLY_SUBAGENT_TOOLS,
  "write_file",
  "edit_file",
  "multi_edit_file",
  "apply_patch_file",
  "move_file",
  "delete_file",
  "revert_file_change",
  "todo_write",
  "enter_worktree",
  "commit_worktree",
  "exit_worktree",
  "merge_worktree",
]);

function subagentType(value: unknown): SubagentType {
  return value === "explore" || value === "plan" || value === "verify" || value === "implement" ? value : "verify";
}

function subagentToolMode(value: unknown, kind: SubagentType): SubagentToolMode {
  if (value === "workspace_write") return kind === "implement" ? "workspace_write" : "read_only";
  return value === "none" ? "none" : "read_only";
}

function preview(value: unknown, maxChars = EVENT_PREVIEW_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTaskId(): string {
  return `subagent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function subagentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function requestedSubagentCwd(args: Record<string, unknown>, context: ToolExecutionContext | undefined): string | undefined {
  if (typeof args.cwd !== "string" || !args.cwd.trim()) return undefined;
  const base = context?.projectRoot ?? process.cwd();
  return resolve(base, args.cwd);
}

function subagentContext(
  args: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
): ToolExecutionContext | undefined {
  const requested = requestedSubagentCwd(args, context);
  if (!context || !requested) return context;
  if (context.pathSandbox) {
    const resolved = context.pathSandbox.resolvePath(requested, "read", "agent_task", "fs.read");
    if (!resolved.ok) {
      throw new Error([
        "Subagent cwd is outside the allowed workspace.",
        `Requested cwd: ${requested}`,
        `Reason: ${resolved.message}`,
        "Recovery: choose a cwd inside the current project/worktree, or create/enter a worktree first.",
      ].join("\n"));
    }
  }
  if (!existsSync(requested)) {
    throw new Error([
      "Subagent cwd does not exist.",
      `Requested cwd: ${requested}`,
      "Recovery: choose an existing directory inside the current project/worktree, or create it first with an approved workspace edit.",
    ].join("\n"));
  }
  if (!statSync(requested).isDirectory()) {
    throw new Error([
      "Subagent cwd is not a directory.",
      `Requested cwd: ${requested}`,
      "Recovery: choose a directory inside the current project/worktree.",
    ].join("\n"));
  }
  return {
    ...context,
    projectRoot: requested,
    pathSandbox: new PathSandbox({ projectRoot: requested }),
    readFileStateScope: `${context.readFileStateScope ?? context.projectRoot ?? "default"}::subagent:${requested}`,
  };
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

function subagentTaskRoot(context: ToolExecutionContext | undefined, sessionId: string): string {
  const dataDir = context?.dataDir ?? join(context?.projectRoot ?? process.cwd(), ".forge");
  return join(dataDir, "subagent-tasks", safeSessionId(sessionId));
}

function taskStatePath(context: ToolExecutionContext | undefined, sessionId: string, taskId: string): string {
  return join(subagentTaskRoot(context, sessionId), `${taskId}.json`);
}

function taskOutputPath(context: ToolExecutionContext | undefined, sessionId: string, taskId: string): string {
  return join(subagentTaskRoot(context, sessionId), `${taskId}.txt`);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function publicTask(task: BackgroundSubagentTask): Record<string, unknown> {
  return {
    task_id: task.id,
    status: task.status,
    subagent_type: task.subagentType,
    tool_mode: task.toolMode,
    ...(task.name ? { name: task.name } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    started_at: task.startedAt,
    updated_at: task.updatedAt,
    ...(task.finishedAt ? { finished_at: task.finishedAt } : {}),
    ...(task.branchId ? { branch_id: task.branchId } : {}),
    task: task.task,
    tool_calls: task.toolCalls,
    ...(task.isError !== undefined ? { is_error: task.isError } : {}),
    ...(task.output ? { output: task.output } : {}),
    ...(task.outputFile ? { output_file: task.outputFile } : {}),
    ...(task.stateFile ? { state_file: task.stateFile } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

function persistBackgroundTask(task: BackgroundSubagentTask): void {
  if (!task.stateFile) return;
  const outputFile = task.outputFile;
  if (outputFile && task.output !== undefined) {
    writeAtomic(outputFile, task.output);
  }
  writeAtomic(task.stateFile, JSON.stringify(publicTask(task), null, 2));
}

function loadBackgroundTask(
  context: ToolExecutionContext | undefined,
  sessionId: string,
  taskId: string,
): BackgroundSubagentTask | null {
  const stateFile = taskStatePath(context, sessionId, taskId);
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    const status = parsed.status === "running" || parsed.status === "completed" || parsed.status === "failed" || parsed.status === "cancelled"
      ? parsed.status
      : "failed";
    const parsedSubagentType = subagentType(parsed.subagent_type);
    const toolMode = subagentToolMode(parsed.tool_mode, parsedSubagentType);
    const outputFile = typeof parsed.output_file === "string" ? parsed.output_file : taskOutputPath(context, sessionId, taskId);
    const persistedOutput = typeof parsed.output === "string"
      ? parsed.output
      : existsSync(outputFile)
        ? readFileSync(outputFile, "utf-8")
        : undefined;
    return {
      id: taskId,
      sessionId,
      ...(typeof parsed.branch_id === "string" ? { branchId: parsed.branch_id } : {}),
      subagentType: parsedSubagentType,
      toolMode,
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      task: typeof parsed.task === "string" ? parsed.task : "",
      status,
      startedAt: typeof parsed.started_at === "string" ? parsed.started_at : new Date().toISOString(),
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
      ...(typeof parsed.finished_at === "string" ? { finishedAt: parsed.finished_at } : {}),
      ...(persistedOutput !== undefined ? { output: persistedOutput } : {}),
      outputFile,
      stateFile,
      isError: parsed.is_error === true || status === "failed" || status === "cancelled",
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      toolCalls: Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls.flatMap((call) => {
          if (!call || typeof call !== "object") return [];
          const record = call as Record<string, unknown>;
          return typeof record.name === "string" ? [{ name: record.name, isError: record.isError === true || record.is_error === true }] : [];
        })
        : [],
      cancelRequested: status === "cancelled",
    };
  } catch {
    return null;
  }
}

function readTaskOutputSlice(task: BackgroundSubagentTask, offset: number, limit: number): string {
  const output = task.outputFile && existsSync(task.outputFile)
    ? readFileSync(task.outputFile, "utf-8")
    : task.output ?? "";
  const safeOffset = Math.max(0, Math.min(offset, output.length));
  const safeLimit = Math.max(1, Math.min(limit, 50_000));
  const slice = output.slice(safeOffset, safeOffset + safeLimit);
  return [
    `Output range: ${safeOffset}-${safeOffset + slice.length} of ${output.length} chars`,
    slice,
    safeOffset + slice.length < output.length ? `\n... call agent_task_output again with offset=${safeOffset + slice.length} to continue.` : "",
  ].filter(Boolean).join("\n");
}

function pruneBackgroundTasks(): void {
  if (BACKGROUND_SUBAGENT_TASKS.size <= MAX_BACKGROUND_TASKS) return;
  const finished = [...BACKGROUND_SUBAGENT_TASKS.values()]
    .filter((task) => task.status !== "running")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const task of finished.slice(0, Math.max(0, BACKGROUND_SUBAGENT_TASKS.size - MAX_BACKGROUND_TASKS))) {
    BACKGROUND_SUBAGENT_TASKS.delete(task.id);
  }
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
  const canWrite = toolMode === "workspace_write";
  const base = [
    canWrite
      ? "You are a constrained ForgeAgent workspace implementation subagent."
      : "You are a constrained read-only ForgeAgent workspace subagent.",
    canWrite
      ? "You may edit only the current allowed workspace or worktree through the provided ForgeAgent tools."
      : "You must not edit files, write persistent state, launch external runtimes, install packages, change git state, or ask the user.",
    toolMode === "read_only"
      ? "You may use only the provided read/search/LSP/git-diff/verification tools. Unsafe tool requests will be rejected by ForgeAgent policy."
      : toolMode === "workspace_write"
      ? "You may use only the provided workspace tools for reading, bounded file edits, todos, git diff, safe verification, and worktree handoff. PermissionBroker and PathSandbox still apply to every tool call."
      : "You cannot use tools. You must reason only from the thread facts and workspace activity summary provided.",
    "You must not install packages, launch unknown external runtimes, access paths outside the allowed workspace, change secrets, ask the user, or bypass permissions.",
    "Do not claim that code was inspected, files changed, commands ran, or tests passed unless either the provided facts or your own tool results show that.",
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
    if (kind === "implement") {
      base.push(
        "Your job is bounded implementation: make the smallest correct workspace changes needed for the requested subtask.",
        "Start by inspecting the relevant files. Prefer edit_file, multi_edit_file, or apply_patch_file over shell writes.",
        "Keep todo state current for multi-step implementation subtasks.",
        "After edits, run task-appropriate checks with verify_workspace or safe bash when available, then inspect git_diff.",
        "If a tool returns permission, sandbox, stale-read, diagnostic, or verification errors, read the error text and recover within the workspace.",
        "If verification cannot run, say exactly why and what evidence is still missing.",
        "Output exactly these sections: SUMMARY, CHANGES, CHECKS, RISKS, HANDOFF.",
      );
      return base.join("\n");
    }
    base.push(
      "Your job is planning: produce a concrete implementation and verification plan.",
      "Output exactly these sections: PLAN, FILES/TOOLS, VALIDATION, RISKS.",
    );
  }
  return base.join("\n");
}

function allowedSubagentTools(context: ToolExecutionContext | undefined, toolMode: SubagentToolMode): ToolDefinition[] {
  const tools = context?.toolsProvider?.() ?? [];
  const allowedNames = toolMode === "workspace_write" ? WORKSPACE_WRITE_SUBAGENT_TOOLS : READ_ONLY_SUBAGENT_TOOLS;
  return tools.filter((tool) => allowedNames.has(tool.name));
}

function stringifyToolResult(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "(no output)";
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n... [subagent tool result truncated ${text.length - maxChars} chars]`;
}

function toolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

type VerifyVerdict = "PASS" | "PARTIAL" | "FAIL" | "UNKNOWN";

function parseVerifyVerdict(text: string): VerifyVerdict {
  const lines = text.split(/\r?\n/);
  const verdictLineIndex = lines.findIndex((candidate) => /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*VERDICT\b/i.test(candidate));
  if (verdictLineIndex === -1) return "UNKNOWN";

  const sameLineMatch = lines[verdictLineIndex]!.match(
    /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*VERDICT\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASS|PARTIAL|FAIL)\b/i,
  );
  if (sameLineMatch) return sameLineMatch[1]!.toUpperCase() as VerifyVerdict;

  for (const followingLine of lines.slice(verdictLineIndex + 1)) {
    const normalized = followingLine
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\*\*/, "")
      .replace(/\*\*$/, "")
      .replace(/^`+|`+$/g, "")
      .trim();
    if (!normalized) continue;
    const nextLineMatch = normalized.match(/^(PASS|PARTIAL|FAIL)\b/i);
    return nextLineMatch ? nextLineMatch[1]!.toUpperCase() as VerifyVerdict : "UNKNOWN";
  }

  return "UNKNOWN";
}

function normalizeVerifyResponse(text: string, verdict: VerifyVerdict | undefined): string {
  if (!verdict || verdict === "UNKNOWN" || /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*VERDICT\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASS|PARTIAL|FAIL)\b/im.test(text)) {
    return text;
  }
  return [`VERDICT: ${verdict}`, text].join("\n\n");
}

async function runSubagent(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
  runOptions?: { signal?: AbortSignal; backgroundTask?: BackgroundSubagentTask },
): Promise<unknown> {
  const cwd = requestedSubagentCwd(args, context);
  try {
    context = subagentContext(args, context);
  } catch (error) {
    return {
      output: errorMessage(error),
      isError: true,
    };
  }
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
  const toolMode = subagentToolMode(args.tool_mode ?? (kind === "implement" ? "workspace_write" : "read_only"), kind);
  const name = subagentName(args.name);
  const signal = runOptions?.signal ?? context?.signal;
  const events = context?.readThread?.(sessionId) ?? [];
  const activitySummary = buildWorkspaceActivitySummary(sessionId, events, context?.branchId);
  const tools = toolMode !== "none" ? allowedSubagentTools(context, toolMode) : [];
  if (kind === "implement" && toolMode === "workspace_write" && tools.length === 0) {
    return {
      output: "agent_task implement cannot run because no constrained workspace tools are available in this tool execution context.",
      isError: true,
    };
  }
  const availableToolMap = toolMap(tools);
  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt(kind, tools.length > 0 ? toolMode : "none") },
    {
      role: "user",
      content: [
        `<subagent_type>${kind}</subagent_type>`,
        name ? `<subagent_name>${name}</subagent_name>` : "",
        cwd ? `<subagent_cwd>${cwd}</subagent_cwd>` : "",
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
      signal ? { signal } : undefined,
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
        const recovery = toolMode === "workspace_write"
          ? "Use workspace read/edit/todo/diff/verification/worktree tools only, or return a HANDOFF note for the main Agent when extension, MCP, browser, package install, or user interaction is required."
          : "Use read_file, file_search, grep, glob, git_diff, lsp_query, lsp_diagnostics, verify_workspace, workspace_review, task_output, or bash with a safe read/check command.";
        const denied = `Subagent tool denied before execution.\nTool: ${call.name}\nReason: This tool is not in the ${toolMode} subagent allowlist.\nRecovery: ${recovery}`;
        toolCalls.push({ name: call.name, isError: true });
        messages.push({ role: "tool", tool_call_id: call.id, content: denied });
        continue;
      }
      const result = await context.toolExecutor.execute(call.name, call.args, sessionId, {
        ...context,
        toolUseId: call.id,
        ...(signal ? { signal } : {}),
        source: {
          ...(context.source ?? { kind: "system" as const }),
          interactive: false,
        },
      });
      toolCalls.push({ name: call.name, isError: result.isError });
      if (runOptions?.backgroundTask) {
        runOptions.backgroundTask.toolCalls = [...toolCalls];
        runOptions.backgroundTask.updatedAt = new Date().toISOString();
        persistBackgroundTask(runOptions.backgroundTask);
      }
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
  const normalizedResponseText = normalizeVerifyResponse(responseText, verdict);
  const failedVerification = verdict !== undefined && verdict !== "PASS";
  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    activityKind: subagentActivityKind(kind),
    status: failedVerification ? "failed" : "completed",
    title: `Subagent ${kind}`,
    message: normalizedResponseText.slice(0, 500),
    payload: {
      ...(runOptions?.backgroundTask ? { backgroundTaskId: runOptions.backgroundTask.id } : {}),
      subagentType: kind,
      ...(name ? { name } : {}),
      ...(cwd ? { cwd } : {}),
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
          normalizedResponseText,
        ].join("\n")
        : normalizedResponseText,
      isError: true,
    };
  }
  return normalizedResponseText;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const runInBackground = args.run_in_background === true;
  if (!runInBackground) return runSubagent(args, sessionId, context);

  const provider = context?.modelProvider;
  if (!provider) {
    return {
      output: "agent_task cannot run in the background because no ModelProvider is available in the tool execution context.",
      isError: true,
    };
  }
  const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : "";
  if (!task) return { output: "task is required.", isError: true };

  const kind = subagentType(args.subagent_type);
  const toolMode = subagentToolMode(args.tool_mode ?? (kind === "implement" ? "workspace_write" : "read_only"), kind);
  const name = subagentName(args.name);
  const cwd = requestedSubagentCwd(args, context);
  try {
    // Validate the requested cwd before returning a background task id. The actual
    // run scopes the context once inside runSubagent; do not pass this scoped
    // context back in or relative cwd values would be applied twice.
    subagentContext(args, context);
  } catch (error) {
    return { output: errorMessage(error), isError: true };
  }
  const controller = new AbortController();
  const taskId = makeTaskId();
  const timestamp = new Date().toISOString();
  const backgroundTask: BackgroundSubagentTask = {
    id: taskId,
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    subagentType: kind,
    toolMode,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    task,
    status: "running",
    startedAt: timestamp,
    updatedAt: timestamp,
    outputFile: taskOutputPath(context, sessionId, taskId),
    stateFile: taskStatePath(context, sessionId, taskId),
    toolCalls: [],
    controller,
    cancelRequested: false,
  };
  BACKGROUND_SUBAGENT_TASKS.set(taskId, backgroundTask);
  persistBackgroundTask(backgroundTask);
  pruneBackgroundTasks();

  context?.workspaceActivity?.recordActivity({
    sessionId,
    ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
    activityKind: subagentActivityKind(kind),
    status: "running",
    title: `Background subagent ${kind}`,
    message: `Background subagent task started: ${taskId}`,
    payload: {
      backgroundTaskId: taskId,
      subagentType: kind,
      ...(name ? { name } : {}),
      ...(cwd ? { cwd } : {}),
      toolMode,
      task,
    },
  });

  void runSubagent(args, sessionId, context, { signal: controller.signal, backgroundTask })
    .then((result) => {
      if (backgroundTask.cancelRequested) return;
      const structured = result && typeof result === "object" && "isError" in result
        ? result as { output?: unknown; isError?: boolean }
        : undefined;
      backgroundTask.isError = structured?.isError === true;
      backgroundTask.output = stringifyToolResult(structured ? structured.output : result, 20_000);
      backgroundTask.status = backgroundTask.isError ? "failed" : "completed";
      backgroundTask.finishedAt = new Date().toISOString();
      backgroundTask.updatedAt = backgroundTask.finishedAt;
      persistBackgroundTask(backgroundTask);
      context?.workspaceActivity?.recordActivity({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        activityKind: subagentActivityKind(kind),
        status: backgroundTask.status,
        title: `Background subagent ${kind}`,
        message: `${backgroundTask.status === "completed" ? "Completed" : "Failed"} background subagent task: ${taskId}`,
        payload: {
          backgroundTaskId: taskId,
          subagentType: kind,
          ...(name ? { name } : {}),
          ...(cwd ? { cwd } : {}),
          toolMode,
          task,
          toolCalls: backgroundTask.toolCalls,
        },
      });
    })
    .catch((error) => {
      backgroundTask.isError = true;
      backgroundTask.error = errorMessage(error);
      backgroundTask.output = backgroundTask.cancelRequested
        ? `Background subagent task was cancelled: ${taskId}`
        : `Background subagent task failed: ${backgroundTask.error}`;
      backgroundTask.status = backgroundTask.cancelRequested ? "cancelled" : "failed";
      backgroundTask.finishedAt = new Date().toISOString();
      backgroundTask.updatedAt = backgroundTask.finishedAt;
      persistBackgroundTask(backgroundTask);
      context?.workspaceActivity?.recordActivity({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        activityKind: subagentActivityKind(kind),
        status: backgroundTask.status,
        title: `Background subagent ${kind}`,
        message: backgroundTask.output ?? `Background subagent task ${backgroundTask.status}: ${taskId}`,
        payload: {
          backgroundTaskId: taskId,
          subagentType: kind,
          ...(name ? { name } : {}),
          ...(cwd ? { cwd } : {}),
          toolMode,
          task,
          ...(backgroundTask.error ? { error: backgroundTask.error } : {}),
          toolCalls: backgroundTask.toolCalls,
        },
      });
    });

  return [
    `Background subagent started: ${taskId}`,
    `Type: ${kind}`,
    name ? `Name: ${name}` : "",
    cwd ? `Cwd: ${cwd}` : "",
    `Tool mode: ${toolMode}`,
    `Output file: ${backgroundTask.outputFile}`,
    "Use agent_task_output with this task_id to inspect the result, or agent_task_cancel to stop it.",
  ].filter(Boolean).join("\n");
}

export const agentTaskTool: ExecutableToolDefinition = buildTool({
  name: "agent_task",
  description: "Runs a constrained model subagent for independent workspace verification, exploration, planning, or bounded implementation. Can run in the foreground or as a background subagent task. Implementation mode may use only approved workspace read/edit/diff/verification/worktree tools and still goes through PermissionBroker and PathSandbox.",
  params: {
    subagent_type: {
      type: "string",
      description: "verify, explore, plan, or implement. Defaults to verify.",
      optional: true,
    },
    tool_mode: {
      type: "string",
      description: "read_only, workspace_write, or none. implement defaults to workspace_write; other subagent types default to read_only.",
      optional: true,
    },
    task: {
      type: "string",
      description: "Concrete read-only subtask for the subagent.",
    },
    name: {
      type: "string",
      description: "Optional short human-readable name for this subagent task, useful when several background agents run at once.",
      optional: true,
    },
    cwd: {
      type: "string",
      description: "Optional directory inside the current project/worktree for the subagent's tool context. It must stay inside the allowed workspace roots.",
      optional: true,
    },
    run_in_background: {
      type: "boolean",
      description: "Set true to start the subagent as a background task and immediately return a task id.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["fs.read", "fs.write", "process.exec"],
});

export const agentTaskOutputTool: ExecutableToolDefinition = buildTool({
  name: "agent_task_output",
  description: "Reads the status and final output of a background subagent task started by agent_task run_in_background=true.",
  params: {
    task_id: {
      type: "string",
      description: "The background subagent task id returned by agent_task.",
    },
    offset: {
      type: "number",
      description: "Character offset into the persisted task output. Defaults to 0.",
      optional: true,
    },
    limit: {
      type: "number",
      description: "Maximum output characters to read. Defaults to 20000 and caps at 50000.",
      optional: true,
    },
  },
  async handler(args, sessionId, context) {
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    if (!taskId) return { output: "task_id is required.", isError: true };
    const task = BACKGROUND_SUBAGENT_TASKS.get(taskId) ?? loadBackgroundTask(context, sessionId, taskId);
    if (!task) {
      return {
        output: `No background subagent task found for ${taskId}.\nRecovery: check the task id from the earlier agent_task result, or start a new background subagent task.`,
        isError: true,
      };
    }
    if (task.status === "running") {
      return [
        `Background subagent is still running: ${task.id}`,
        `Type: ${task.subagentType}`,
        `Tool mode: ${task.toolMode}`,
        `Started: ${task.startedAt}`,
        `Tool calls so far: ${task.toolCalls.map((call) => `${call.name}${call.isError ? "(error)" : ""}`).join(", ") || "none"}`,
      ].join("\n");
    }
    if (task.status === "failed" || task.status === "cancelled") {
      if (typeof args.offset === "number" || typeof args.limit === "number") {
        return {
          output: readTaskOutputSlice(task, typeof args.offset === "number" ? args.offset : 0, typeof args.limit === "number" ? args.limit : 20_000),
          isError: true,
        };
      }
      return {
        output: JSON.stringify(publicTask(task), null, 2),
        isError: true,
      };
    }
    if (typeof args.offset === "number" || typeof args.limit === "number") {
      return readTaskOutputSlice(task, typeof args.offset === "number" ? args.offset : 0, typeof args.limit === "number" ? args.limit : 20_000);
    }
    return JSON.stringify(publicTask(task), null, 2);
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});

export const agentTaskCancelTool: ExecutableToolDefinition = buildTool({
  name: "agent_task_cancel",
  description: "Cancels a running background subagent task started by agent_task run_in_background=true.",
  params: {
    task_id: {
      type: "string",
      description: "The background subagent task id returned by agent_task.",
    },
  },
  async handler(args, sessionId, context) {
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    if (!taskId) return { output: "task_id is required.", isError: true };
    const task = BACKGROUND_SUBAGENT_TASKS.get(taskId) ?? loadBackgroundTask(context, sessionId, taskId);
    if (!task) {
      return {
        output: `No background subagent task found for ${taskId}.`,
        isError: true,
      };
    }
    if (task.status !== "running") {
      return `Background subagent ${taskId} is already ${task.status}.`;
    }
    task.cancelRequested = true;
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    task.updatedAt = task.finishedAt;
    task.output = `Background subagent task was cancelled: ${taskId}`;
    task.controller?.abort();
    persistBackgroundTask(task);
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: subagentActivityKind(task.subagentType),
      status: "cancelled",
      title: `Background subagent ${task.subagentType}`,
      message: task.output,
      payload: {
        backgroundTaskId: task.id,
        subagentType: task.subagentType,
        toolMode: task.toolMode,
        task: task.task,
        toolCalls: task.toolCalls,
      },
    });
    return task.output;
  },
  isConcurrencySafe: true,
  isReadOnly: false,
  capabilities: ["process.exec"],
});
