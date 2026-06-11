import type {
  ActivityEvent,
  DiagnosticEvent,
  DiffEvent,
  EvidenceEvent,
  EvidenceReference,
  SessionEvent,
  ToolCall,
  ToolResult,
  TodoEvent,
  TodoItem,
  VerificationEvent,
} from "../streams/event-types.js";

export type StepEvidenceInput = {
  kind: EvidenceReference["kind"];
  seq?: number;
  command?: string;
  path?: string;
  note?: string;
};

export type StepEvidenceValidation = {
  ok: boolean;
  matchedSeqs: number[];
  message: string;
  references: EvidenceReference[];
};

export type MissingTodoEvidence = {
  todo: TodoItem;
  reason: string;
};

function branchMatches(event: SessionEvent, branchId?: string): boolean {
  return branchId === undefined || event.branchId === undefined || event.branchId === branchId;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCommand(value: string): string {
  return value
    .trim()
    .replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*/s, "")
    .replace(/\s+2>\s*&1\s*$/u, "")
    .replace(/\s+/g, " ");
}

function latestTodoEvent(events: SessionEvent[], branchId?: string): TodoEvent | undefined {
  return [...events].reverse().find((event): event is TodoEvent => (
    event.type === "todo_event" && branchMatches(event, branchId)
  ));
}

function previousStatusKey(item: TodoItem): string {
  return item.id || normalizeText(item.content);
}

function evidenceMatchesStep(event: EvidenceEvent, todo: TodoItem): boolean {
  if (event.status !== "passed") return false;
  if (event.todoId && event.todoId === todo.id) return true;
  return normalizeText(event.step) === normalizeText(todo.content);
}

export function findTodoEvidence(
  events: SessionEvent[],
  todo: TodoItem,
  options?: { afterSeq?: number; branchId?: string },
): EvidenceEvent | undefined {
  const afterSeq = options?.afterSeq ?? 0;
  return [...events].reverse().find((event): event is EvidenceEvent => (
    event.type === "evidence_event" &&
    event.seq > afterSeq &&
    branchMatches(event, options?.branchId) &&
    evidenceMatchesStep(event, todo)
  ));
}

export function missingEvidenceForCompletedTodos(
  nextItems: TodoItem[],
  events: SessionEvent[],
  branchId?: string,
): MissingTodoEvidence[] {
  const latestTodo = latestTodoEvent(events, branchId);
  const previous = new Map<string, TodoItem["status"]>();
  for (const item of latestTodo?.items ?? []) {
    previous.set(previousStatusKey(item), item.status);
  }
  const baselineSeq = latestTodo?.seq ?? 0;
  const missing: MissingTodoEvidence[] = [];
  for (const item of nextItems) {
    if (item.status !== "completed") continue;
    const key = previousStatusKey(item);
    if (previous.get(key) === "completed") continue;
    const evidenceOptions: { afterSeq: number; branchId?: string } = { afterSeq: baselineSeq };
    if (branchId !== undefined) evidenceOptions.branchId = branchId;
    const evidence = findTodoEvidence(events, item, evidenceOptions);
    if (!evidence) {
      missing.push({
        todo: item,
        reason: "Newly completed todo lacks a matching complete_step evidence receipt after the latest todo baseline.",
      });
    }
  }
  return missing;
}

function asReference(input: StepEvidenceInput): EvidenceReference {
  const ref: EvidenceReference = { kind: input.kind };
  if (input.seq !== undefined) ref.seq = input.seq;
  if (input.command !== undefined) ref.command = input.command;
  if (input.path !== undefined) ref.path = input.path;
  if (input.note !== undefined) ref.note = input.note;
  return ref;
}

function matchesWorkspaceReviewCommand(ref: StepEvidenceInput): boolean {
  return ref.command !== undefined && normalizeCommand(ref.command) === "workspace_review";
}

function matchWorkspaceReviewActivity(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): ActivityEvent | undefined {
  if (ref.seq === undefined && !matchesWorkspaceReviewCommand(ref)) return undefined;
  return [...events].reverse().find((event): event is ActivityEvent => {
    if (event.type !== "activity_event" || !branchMatches(event, branchId)) return false;
    if (event.activityKind !== "verification" || event.status !== "completed") return false;
    if (ref.seq !== undefined && event.seq !== ref.seq) return false;
    if (ref.command !== undefined && !matchesWorkspaceReviewCommand(ref)) return false;
    const title = normalizeText(event.title);
    if (title !== "workspace review") return false;
    return event.payload?.ready === true || /no unresolved issues|ready for final response/i.test(event.message);
  });
}

function matchVerification(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): VerificationEvent | ActivityEvent | undefined {
  const verification = [...events].reverse().find((event): event is VerificationEvent => {
    if (event.type !== "verification_event" || !branchMatches(event, branchId)) return false;
    if (event.status !== "passed") return false;
    if (ref.seq !== undefined) return event.seq === ref.seq;
    if (ref.command) return normalizeCommand(event.command) === normalizeCommand(ref.command);
    return true;
  });
  return verification ?? matchWorkspaceReviewActivity(events, ref, branchId);
}

function matchDiff(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): DiffEvent | undefined {
  return [...events].reverse().find((event): event is DiffEvent => {
    if (event.type !== "diff_event" || !branchMatches(event, branchId)) return false;
    if (ref.seq !== undefined) return event.seq === ref.seq;
    if (ref.path) return event.filePath === ref.path || event.filePath.endsWith(`/${ref.path}`);
    return true;
  });
}

function pathText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(" ");
  if (value && typeof value === "object") return Object.values(value).map(pathText).join(" ");
  return "";
}

const FILE_EVIDENCE_TOOL_RE = /^(read_file|file_search|glob|grep|git_diff|lsp_query|lsp_diagnostics|code_map|dependency_graph)$/;

function pairedToolCall(events: SessionEvent[], result: ToolResult, branchId?: string): ToolCall | undefined {
  const beforeResult = events.filter((event) => event.seq < result.seq && branchMatches(event, branchId));
  return [...beforeResult].reverse().find((event): event is ToolCall => (
    event.type === "tool_call" &&
    event.toolName === result.toolName &&
    (
      result.toolUseId !== undefined
        ? event.toolUseId === result.toolUseId
        : true
    )
  ));
}

function matchFiles(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): SessionEvent | undefined {
  return [...events].reverse().find((event) => {
    if (!branchMatches(event, branchId)) return false;
    if (ref.seq !== undefined) {
      if (event.seq !== ref.seq) return false;
      if (event.type === "diff_event") {
        return !ref.path || event.filePath === ref.path || event.filePath.endsWith(`/${ref.path}`);
      }
      if (event.type === "tool_result" && event.isError === false && FILE_EVIDENCE_TOOL_RE.test(event.toolName)) {
        if (!ref.path) return true;
        const call = pairedToolCall(events, event, branchId);
        return pathText(call?.args).includes(ref.path) || pathText(event.result).includes(ref.path);
      }
      return event.type === "artifact_pointer" && (!ref.path || pathText(event).includes(ref.path));
    }
    if (event.type === "diff_event") {
      if (!ref.path) return true;
      return event.filePath === ref.path || event.filePath.endsWith(`/${ref.path}`);
    }
    if (event.type !== "tool_result" || event.isError || !FILE_EVIDENCE_TOOL_RE.test(event.toolName)) return false;
    if (!ref.path) return true;
    const call = pairedToolCall(events, event, branchId);
    return pathText(call?.args).includes(ref.path) || pathText(event.result).includes(ref.path);
  });
}

function matchDiagnostics(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): DiagnosticEvent | undefined {
  return [...events].reverse().find((event): event is DiagnosticEvent => {
    if (event.type !== "diagnostic_event" || !branchMatches(event, branchId)) return false;
    if (ref.seq !== undefined) return event.seq === ref.seq;
    if (event.status === "failed") return false;
    return !event.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  });
}

function matchSubagent(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): ActivityEvent | undefined {
  return [...events].reverse().find((event): event is ActivityEvent => {
    if (event.type !== "activity_event" || !branchMatches(event, branchId)) return false;
    if (ref.seq !== undefined) return event.seq === ref.seq;
    if (!/subagent|agent_task/i.test(`${event.title}\n${event.message}`)) return false;
    const verdict = typeof event.payload?.verdict === "string" ? event.payload.verdict : "";
    return event.status === "completed" && (!verdict || verdict.toUpperCase() === "PASS");
  });
}

function matchReference(events: SessionEvent[], ref: StepEvidenceInput, branchId?: string): number | null {
  if (ref.kind === "verification") return matchVerification(events, ref, branchId)?.seq ?? null;
  if (ref.kind === "diff") return matchDiff(events, ref, branchId)?.seq ?? null;
  if (ref.kind === "files") return matchFiles(events, ref, branchId)?.seq ?? null;
  if (ref.kind === "diagnostics") return matchDiagnostics(events, ref, branchId)?.seq ?? null;
  if (ref.kind === "subagent") return matchSubagent(events, ref, branchId)?.seq ?? null;
  if (ref.kind === "manual") return ref.note && ref.note.trim().length >= 3 ? 0 : null;
  return null;
}

export function validateStepEvidence(input: {
  step: string;
  todoId?: string;
  evidence: StepEvidenceInput[];
  events: SessionEvent[];
  branchId?: string;
}): StepEvidenceValidation {
  const step = input.step.trim();
  if (!step) {
    return { ok: false, matchedSeqs: [], references: [], message: "complete_step requires a non-empty step." };
  }
  if (input.evidence.length === 0) {
    return {
      ok: false,
      matchedSeqs: [],
      references: [],
      message: "complete_step requires at least one evidence reference. Use verification, diff/files, diagnostics, subagent, or manual evidence.",
    };
  }

  const matchedSeqs: number[] = [];
  const references = input.evidence.map(asReference);
  const missing: string[] = [];
  for (const ref of input.evidence) {
    const matched = matchReference(input.events, ref, input.branchId);
    if (matched === null) {
      missing.push(`${ref.kind}${ref.seq !== undefined ? ` #${ref.seq}` : ""}${ref.command ? ` ${ref.command}` : ""}${ref.path ? ` ${ref.path}` : ""}`);
    } else if (matched > 0) {
      matchedSeqs.push(matched);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      matchedSeqs,
      references,
      message: [
        "complete_step evidence could not be verified from durable thread facts.",
        `Step: ${step}`,
        `Missing or invalid evidence: ${missing.join(", ")}`,
        "Recovery: run a real check, inspect the diff/files, refresh diagnostics, use a verify subagent, or ask the user for manual confirmation, then call complete_step again.",
      ].join("\n"),
    };
  }

  return {
    ok: true,
    matchedSeqs: [...new Set(matchedSeqs)].sort((a, b) => a - b),
    references,
    message: [
      "Step evidence verified.",
      `Step: ${step}`,
      input.todoId ? `Todo id: ${input.todoId}` : "",
      matchedSeqs.length > 0 ? `Matched thread event seqs: ${[...new Set(matchedSeqs)].sort((a, b) => a - b).join(", ")}` : "Evidence: manual confirmation",
    ].filter(Boolean).join("\n"),
  };
}
