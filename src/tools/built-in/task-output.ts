import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ShellTaskEvent } from "../../streams/event-types.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { loadShellTaskFromFile, snapshotShellTask } from "./shell-task-store.js";
import { join } from "node:path";

function latestShellTaskFromThread(
  sessionId: string,
  taskId: string,
  context?: ToolExecutionContext,
): ShellTaskEvent | undefined {
  const events = context?.readThread?.(sessionId) ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "shell_task_event" && event.taskId === taskId) return event;
  }
  return undefined;
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

function shellTaskStatePath(context: ToolExecutionContext | undefined, sessionId: string, taskId: string): string {
  const dataDir = context?.dataDir ?? join(context?.projectRoot ?? process.cwd(), ".forge");
  return join(dataDir, "shell-tasks", safeSessionId(sessionId), `${taskId}.json`);
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) return { output: "task_id is required.", isError: true };
  const task = snapshotShellTask(taskId) ?? loadShellTaskFromFile(shellTaskStatePath(context, sessionId, taskId));
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 50_000) : 20_000;
  if (!task) {
    const latest = latestShellTaskFromThread(sessionId, taskId, context);
    if (!latest) return { output: `Unknown shell task: ${taskId}`, isError: true };
    return [
      `Task: ${latest.taskId}`,
      `Status: ${latest.status}`,
      `Command: ${latest.command}`,
      latest.exitCode !== undefined ? `Exit code: ${latest.exitCode}` : undefined,
      "",
      latest.outputPreview
        ? `Last known output preview:\n${latest.outputPreview}`
        : "No live process or buffered output is available. This task state was recovered from the durable thread, not from an active background process.",
      latest.status === "running"
        ? "Recovery: the ForgeAgent process may have restarted before this background task finished. Start the command again if it is still needed."
        : undefined,
    ].filter((line) => line !== undefined).join("\n");
  }
  const output = task.output.slice(offset, offset + limit);
  const more = offset + limit < task.output.length
    ? `\n<system-reminder>Output truncated. Continue with offset=${offset + limit} and limit=${limit}.</system-reminder>`
    : "";
  return [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Command: ${task.command}`,
    task.outputFile !== undefined ? `Output file: ${task.outputFile}` : undefined,
    task.exitCode !== undefined ? `Exit code: ${task.exitCode}` : undefined,
    task.stallWarning !== undefined ? `Warning:\n${task.stallWarning}` : undefined,
    "",
    output || "(no output yet)",
    more,
  ].filter((line) => line !== undefined).join("\n");
}

export const taskOutputTool: ExecutableToolDefinition = buildTool({
  name: "task_output",
  description: "Reads buffered output from a background bash task started with run_in_background.",
  params: {
    task_id: { type: "string", description: "Task id returned by bash." },
    offset: { type: "number", description: "Character offset for long output.", optional: true },
    limit: { type: "number", description: "Maximum characters to return.", optional: true },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
