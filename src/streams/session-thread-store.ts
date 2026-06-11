import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionEvent, CompactionBlock, Session } from "./event-types.js";

const STRUCTURED_FACT_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "runtime_event",
  "permission_request",
  "permission_response",
  "activity_event",
  "todo_event",
  "diff_event",
  "diagnostic_event",
  "verification_event",
  "evidence_event",
  "shell_task_event",
  "worktree_event",
  "permission_grant_event",
  "mcp_elicitation_request",
  "mcp_elicitation_response",
  "artifact_pointer",
  "skill_used",
]);

function preserveDuringCompaction(event: SessionEvent): boolean {
  return STRUCTURED_FACT_EVENT_TYPES.has(event.type);
}

export class SessionThreadStore {
  #threads = new Map<string, SessionEvent[]>();
  #filePaths = new Map<string, string>();
  #sessionMetas = new Map<string, Session>();
  #dirty = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  attachFile(sessionId: string, filePath: string): void {
    this.#filePaths.set(sessionId, filePath);
  }

  hasFile(sessionId: string): boolean {
    return this.#filePaths.has(sessionId);
  }

  append(sessionId: string, event: SessionEvent): void {
    const thread = this.#threads.get(sessionId);
    if (thread) {
      thread.push(event);
    } else {
      this.#threads.set(sessionId, [event]);
    }
    this.#scheduleFlush(sessionId);
  }

  getThread(sessionId: string): SessionEvent[] {
    return [...(this.#threads.get(sessionId) ?? [])];
  }

  getRawThread(sessionId: string): SessionEvent[] | undefined {
    return this.#threads.get(sessionId);
  }

  replay(sessionId: string): SessionEvent[] {
    return this.getThread(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.#threads.has(sessionId);
  }

  compactEvents(sessionId: string, startIndex: number, endIndex: number, block: CompactionBlock): void {
    const thread = this.#threads.get(sessionId);
    if (!thread) throw new Error(`Session not found: ${sessionId}`);
    const removed = thread.slice(startIndex, endIndex + 1);
    const preservedFacts = removed.filter(preserveDuringCompaction);
    thread.splice(startIndex, endIndex - startIndex + 1, ...preservedFacts, block);
    this.#dirty.add(sessionId);
    this.#scheduleFlush(sessionId);
  }

  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    for (const sid of this.#dirty) {
      const path = this.#filePaths.get(sid);
      if (!path) continue;
      const thread = this.#threads.get(sid);
      if (!thread) continue;
      const meta = this.#sessionMetas.get(sid);
      mkdirSync(dirname(path), { recursive: true });
      const lines: string[] = [];
      if (meta) {
        lines.push(JSON.stringify({ type: "session_meta" as const, ...meta }));
      }
      for (const e of thread) {
        lines.push(JSON.stringify(e));
      }
      writeFileSync(path, lines.join("\n") + "\n");
    }
    this.#dirty.clear();
  }

  writeSessionMeta(sessionId: string, meta: Session): void {
    if (!this.#filePaths.has(sessionId)) return;
    this.#sessionMetas.set(sessionId, meta);
    this.#scheduleFlush(sessionId);
  }

  static loadFromFile(filePath: string): { meta: Session | null; events: SessionEvent[] } {
    if (!existsSync(filePath)) return { meta: null, events: [] };

    const raw = readFileSync(filePath, "utf-8");
    const events: SessionEvent[] = [];
    let meta: Session | null = null;

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown> & { type: string };
        if (entry.type === "session_meta") {
          const { type: _, ...rest } = entry as Record<string, unknown>;
          meta = rest as unknown as Session;
        } else {
          events.push(entry as unknown as SessionEvent);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return { meta, events };
  }

  #scheduleFlush(sessionId: string): void {
    this.#dirty.add(sessionId);
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => this.flush(), 100);
    }
  }
}
