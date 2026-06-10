import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ShellTaskEvent } from "../../streams/event-types.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { killShellTask } from "./shell-task-store.js";

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

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) return { output: "task_id is required.", isError: true };
  const task = killShellTask(taskId);
  if (!task) {
    const latest = latestShellTaskFromThread(sessionId, taskId, context);
    if (!latest) return { output: `Unknown shell task: ${taskId}`, isError: true };
    return {
      output: [
        `No live background process is available for task ${taskId}.`,
        `Latest durable status: ${latest.status}.`,
        `Command: ${latest.command}`,
        latest.status === "running"
          ? "Recovery: the ForgeAgent process likely restarted before this task finished. There is nothing active to kill; start a fresh command if needed."
          : "Recovery: no action is needed unless you want to start a fresh command.",
      ].join("\n"),
      isError: true,
    };
  }
  context?.workspaceActivity?.recordShellTask({
    sessionId,
    ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
    taskId,
    action: "killed",
    command: task.command,
    status: "killed",
    message: `Background task killed: ${taskId}`,
  });
  return `Task killed: ${taskId}`;
}

export const taskKillTool: ExecutableToolDefinition = buildTool({
  name: "task_kill",
  description: "Stops a background bash task started with run_in_background.",
  params: {
    task_id: { type: "string", description: "Task id returned by bash." },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec"],
});
