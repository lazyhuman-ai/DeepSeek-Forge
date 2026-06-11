import { randomUUID } from "node:crypto";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { EvidenceReference } from "../../streams/event-types.js";
import { validateStepEvidence, type StepEvidenceInput } from "../../workspace/evidence.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

const VALID_EVIDENCE_KINDS = new Set<EvidenceReference["kind"]>([
  "verification",
  "diff",
  "files",
  "diagnostics",
  "subagent",
  "manual",
]);

function parseEvidence(raw: unknown): StepEvidenceInput[] | string {
  if (!Array.isArray(raw)) return "evidence must be an array.";
  const out: StepEvidenceInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `evidence[${i}] must be an object.`;
    }
    const record = item as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (!VALID_EVIDENCE_KINDS.has(kind as EvidenceReference["kind"])) {
      return `evidence[${i}].kind must be one of verification, diff, files, diagnostics, subagent, manual.`;
    }
    const parsed: StepEvidenceInput = { kind: kind as EvidenceReference["kind"] };
    if (typeof record.seq === "number" && Number.isFinite(record.seq)) parsed.seq = record.seq;
    if (typeof record.command === "string" && record.command.trim()) parsed.command = record.command.trim();
    if (typeof record.path === "string" && record.path.trim()) parsed.path = record.path.trim();
    if (typeof record.note === "string" && record.note.trim()) parsed.note = record.note.trim();
    out.push(parsed);
  }
  return out;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const step = typeof args.step === "string" ? args.step.trim() : "";
  const todoId = typeof args.todo_id === "string" && args.todo_id.trim()
    ? args.todo_id.trim()
    : typeof args.todoId === "string" && args.todoId.trim()
      ? args.todoId.trim()
      : undefined;
  const evidence = parseEvidence(args.evidence);
  if (typeof evidence === "string") return { output: evidence, isError: true };
  if (!context?.workspaceActivity) {
    return {
      output: "complete_step requires WorkspaceActivityManager context. Recovery: retry inside a normal ForgeAgent session.",
      isError: true,
    };
  }

  const events = context.readThread?.(sessionId) ?? [];
  const validation = validateStepEvidence({
    step,
    ...(todoId !== undefined ? { todoId } : {}),
    evidence,
    events,
    ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
  });
  if (!validation.ok) {
    return { output: validation.message, isError: true };
  }

  const event = context.workspaceActivity.recordEvidence({
    sessionId,
    ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
    evidenceId: randomUUID(),
    step,
    ...(todoId !== undefined ? { todoId } : {}),
    status: "passed",
    evidence: validation.references,
    matchedSeqs: validation.matchedSeqs,
    message: validation.message,
  });

  return [
    validation.message,
    `Evidence receipt id: ${event.evidenceId}`,
    `Evidence event seq: ${event.seq}`,
    "You may now mark the matching todo completed with todo_write.",
  ].join("\n");
}

export const completeStepTool: ExecutableToolDefinition = buildTool({
  name: "complete_step",
  description: "Records a host-verifiable evidence receipt for a completed workspace step. Use this before marking a todo completed; evidence must reference durable diff, verification, diagnostics, subagent, files, or manual confirmation facts.",
  params: {
    step: {
      type: "string",
      description: "The exact step or todo content being completed.",
    },
    todo_id: {
      type: "string",
      description: "Optional stable todo id from todo_write.",
      optional: true,
    },
    evidence: {
      type: "array",
      description: "Evidence references proving the step is complete.",
      items: {
        type: "object",
        description: "Evidence reference",
        properties: {
          kind: {
            type: "string",
            description: "verification, diff, files, diagnostics, subagent, or manual.",
          },
          seq: {
            type: "number",
            description: "Optional thread event seq to match exactly.",
            optional: true,
          },
          command: {
            type: "string",
            description: "Optional verification command to match.",
            optional: true,
          },
          path: {
            type: "string",
            description: "Optional changed file path to match.",
            optional: true,
          },
          note: {
            type: "string",
            description: "Manual user confirmation note, required for manual evidence.",
            optional: true,
          },
        },
      },
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: true,
});
