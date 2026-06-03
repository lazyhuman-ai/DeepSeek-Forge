import type { SessionStatus, SupervisorEvent, Session } from "../streams/event-types.js";

// ── Transition table ──

const transitions: Record<SessionStatus, Record<string, SessionStatus>> = {
  idle: {
    user_message: "running",
    trigger_fired: "running",
    trigger_scheduled: "sleeping",
    user_interrupt: "idle",
    user_archive: "archived",
  },
  running: {
    turn_finished: "idle",
    agent_ask_user: "waiting_user",
    agent_schedule_sleep: "sleeping",
    runtime_failure: "blocked",
    user_interrupt: "idle",
  },
  waiting_user: {
    user_reply: "running",
    user_interrupt: "idle",
    user_archive: "archived",
  },
  sleeping: {
    trigger_fired: "running",
    user_message: "running",
    triggers_empty: "idle",
    user_interrupt: "idle",
    user_archive: "archived",
  },
  blocked: {
    runtime_recovered: "running",
    user_retry: "running",
    user_interrupt: "idle",
    user_archive: "archived",
  },
  archived: {},
};

export function transition(
  current: SessionStatus,
  event: SupervisorEvent,
): SessionStatus {
  const next = transitions[current]?.[event.kind];
  if (next === undefined) {
    throw new Error(
      `Illegal transition: ${current} → ${event.kind}`,
    );
  }
  return next;
}

export function validTransitions(
  status: SessionStatus,
): ReadonlyArray<string> {
  return Object.keys(transitions[status] ?? {});
}

// ── Session Supervisor: concurrency queue ──

export class SessionSupervisor {
  #queue: string[] = [];
  #active = new Set<string>();
  #maxConcurrent: number;
  #runTurn: (sessionId: string) => Promise<void>;
  #sessions: Map<string, Session>;
  #draining = false;

  constructor(
    sessions: Map<string, Session>,
    maxConcurrent: number,
    runTurn: (sessionId: string) => Promise<void>,
  ) {
    this.#sessions = sessions;
    this.#maxConcurrent = Math.max(1, maxConcurrent);
    this.#runTurn = runTurn;
  }

  /**
   * Enqueue a session for turn execution. Returns true if enqueued,
   * false if already active or already queued.
   */
  enqueue(sessionId: string): boolean {
    // Dedup: already running
    if (this.#active.has(sessionId)) return false;
    // Dedup: already queued
    if (this.#queue.includes(sessionId)) return false;

    // Verify session exists and is in a runnable state
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== "running") return false;

    this.#queue.push(sessionId);
    this.#drain();
    return true;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get activeSessionIds(): string[] {
    return [...this.#active];
  }

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  isQueued(sessionId: string): boolean {
    return this.#queue.includes(sessionId);
  }

  dequeue(sessionId: string): boolean {
    const before = this.#queue.length;
    this.#queue = this.#queue.filter((sid) => sid !== sessionId);
    return this.#queue.length !== before;
  }

  stop(): void {
    this.#queue = [];
  }

  // ── Private ──

  #drain(): void {
    // Prevent concurrent drain calls from stacking up
    if (this.#draining) return;

    this.#draining = true;

    const next = (): void => {
      while (this.#queue.length > 0 && this.#active.size < this.#maxConcurrent) {
        const sid = this.#queue.shift()!;
        this.#active.add(sid);

        this.#runTurn(sid).catch(() => {
            // Swallow — errors are handled by the turn executor and recorded
            // in the thread. We still need to free the slot.
          }).finally(() => {
          this.#active.delete(sid);
          // Check queue after each completion
          this.#draining = false;
          this.#drain();
        });
      }
      this.#draining = false;
    };

    next();
  }
}
