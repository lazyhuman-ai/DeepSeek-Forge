import { randomUUID } from "node:crypto";
import type { TodoItem, VerificationEvent } from "../../streams/event-types.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";

const VALID_STATUSES = new Set<TodoItem["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function parseTodoItems(value: unknown): TodoItem[] | string {
  if (!Array.isArray(value)) return "items must be an array.";
  const items = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`items[${index}] must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) throw new Error(`items[${index}].content is required.`);
    const statusRaw = typeof item.status === "string" ? item.status : "pending";
    if (!VALID_STATUSES.has(statusRaw as TodoItem["status"])) {
      throw new Error(`items[${index}].status must be one of pending, in_progress, completed, cancelled.`);
    }
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
      content,
      status: statusRaw as TodoItem["status"],
    };
  });
  const inProgress = items.filter((item) => item.status === "in_progress");
  if (inProgress.length > 1) {
    throw new Error("Only one todo item may be in_progress at a time. Mark the current step completed or pending before starting another.");
  }
  return items;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  let items: TodoItem[] | string;
  try {
    items = parseTodoItems(args.items);
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  if (typeof items === "string") return { output: items, isError: true };
  context?.workspaceActivity?.recordTodos(sessionId, items, context.branchId);
  const open = items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length;
  const messages = [`Plan updated: ${items.length} item(s), ${open} still open.`];
  if (open === 0) {
    const events = context?.readThread?.(sessionId) ?? [];
    const latestDiffSeq = Math.max(0, ...events
      .filter((event) => event.type === "diff_event" && (context?.branchId === undefined || event.branchId === undefined || event.branchId === context.branchId))
      .map((event) => event.seq));
    const latestCheck = [...events].reverse().find((event): event is VerificationEvent => (
      event.type === "verification_event" &&
      (context?.branchId === undefined || event.branchId === undefined || event.branchId === context.branchId)
    ));
    if (latestDiffSeq > 0 && (!latestCheck || latestCheck.seq < latestDiffSeq || latestCheck.status !== "passed")) {
      messages.push("Verification reminder: workspace changes are newer than the latest passing check. Run an appropriate check or call workspace_review before finalizing.");
    }
    const latestWorkspaceReview = [...events].reverse().find((event) => (
      event.type === "activity_event" &&
      event.title === "Workspace review" &&
      (context?.branchId === undefined || event.branchId === undefined || event.branchId === context.branchId)
    ));
    if (latestWorkspaceReview?.type === "activity_event" && latestWorkspaceReview.status === "failed") {
      messages.push("Workspace review reminder: the latest workspace_review reported not-ready before this todo update. Run workspace_review again before finalizing so the latest closed todos and verification facts are checked.");
    }
  }
  return messages.join("\n");
}

export const todoWriteTool: ExecutableToolDefinition = buildTool({
  name: "todo_write",
  description: "Records or updates the current workspace plan/todo list for this session. Use it before and during multi-step work so the user and future turns can see progress.",
  params: {
    items: {
      type: "array",
      description: "Ordered todo items with content and status.",
      items: {
        type: "object",
        description: "Todo item",
        properties: {
          id: { type: "string", description: "Stable todo id. Omit for new items.", optional: true },
          content: { type: "string", description: "Concrete task item." },
          status: { type: "string", description: "pending, in_progress, completed, or cancelled." },
        },
      },
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
});
