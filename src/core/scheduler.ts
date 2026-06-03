import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Session, TriggerEvent } from "../streams/event-types.js";
import { SessionThreadStore } from "../streams/session-thread-store.js";
import { transition } from "./session-supervisor.js";
import type { NotificationHub } from "./notification-hub.js";
import type { SystemStreamStore } from "../streams/system-stream-store.js";
import type { SystemEvent } from "../streams/event-types.js";
import { parseCronSchedule } from "./cron-parser.js";
import { createLogger } from "./logger.js";

const logger = createLogger("scheduler");

export type Trigger = {
  id: string;
  sessionId: string;
  kind: "time" | "event" | "runtime" | "webhook" | "manual";
  schedule?: string; // cron expression or ms interval for time-based triggers
  nextFire?: number; // epoch ms
  payload: Record<string, unknown>;
  enabled: boolean;
  recurring: boolean;
};

export class Scheduler {
  #triggers = new Map<string, Trigger>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #threadStore: SessionThreadStore;
  #sessions: Map<string, Session>;
  #notificationHub: NotificationHub;
  #systemStreamStore: SystemStreamStore;
  #nextSeq: () => number;
  #now: () => string;
  #onWake: ((sessionId: string) => Promise<void>) | undefined;
  #onTriggersChanged: ((sessionId: string) => void) | undefined;
  #persistPath: string | undefined;

  constructor(
    threadStore: SessionThreadStore,
    sessions: Map<string, Session>,
    notificationHub: NotificationHub,
    systemStreamStore: SystemStreamStore,
    nextSeq: () => number,
    now: () => string,
    options?: {
      onWake?: (sessionId: string) => Promise<void>;
      onTriggersChanged?: (sessionId: string) => void;
      persistPath?: string;
    },
  ) {
    this.#threadStore = threadStore;
    this.#sessions = sessions;
    this.#notificationHub = notificationHub;
    this.#systemStreamStore = systemStreamStore;
    this.#nextSeq = nextSeq;
    this.#now = now;
    this.#onWake = options?.onWake;
    this.#onTriggersChanged = options?.onTriggersChanged;
    this.#persistPath = options?.persistPath;
  }

  // ── Persistence ──

  /**
   * Load triggers from a JSON file. Returns an array of Trigger objects,
   * or an empty array if the file doesn't exist.
   */
  static loadFromFile(path: string): Trigger[] {
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data as Trigger[];
    } catch {
      return [];
    }
  }

  /**
   * Bulk-load persisted triggers. Recalculates nextFire for triggers whose
   * fire time has already passed (fires ~1s after loading). Arms timers for
   * time-based triggers.
   */
  loadTriggers(triggers: Trigger[]): void {
    const now = Date.now();
    for (const trigger of triggers) {
      if (!trigger.enabled) continue;

      // Recalculate nextFire for triggers that should have fired already
      if (
        trigger.kind === "time" &&
        trigger.schedule &&
        trigger.nextFire !== undefined &&
        trigger.nextFire < now
      ) {
        const parsed = parseCronSchedule(trigger.schedule);
        if (parsed) {
          trigger.nextFire = parsed.nextFire;
        } else {
          // Can't recalculate — set to fire soon
          trigger.nextFire = now + 1000;
        }
      }

      this.#triggers.set(trigger.id, trigger);
      if (trigger.kind === "time" && trigger.nextFire !== undefined) {
        this.#armTimer(trigger);
      }
    }
  }

  #persist(): void {
    if (!this.#persistPath) return;
    try {
      const triggers = [...this.#triggers.values()];
      writeFileSync(this.#persistPath, JSON.stringify(triggers, null, 2), "utf-8");
    } catch {
      // Best effort — don't crash on persist failure
    }
  }

  // ── Trigger management ──

  schedule(trigger: Trigger): void {
    // If a schedule is provided and nextFire isn't already set, compute it
    if (trigger.kind === "time" && trigger.schedule && trigger.nextFire === undefined) {
      const parsed = parseCronSchedule(trigger.schedule);
      if (parsed) {
        trigger.nextFire = parsed.nextFire;
      }
    }

    this.#triggers.set(trigger.id, trigger);

    if (trigger.kind === "time" && trigger.nextFire !== undefined) {
      this.#armTimer(trigger);
    }

    this.#persist();
    this.#onTriggersChanged?.(trigger.sessionId);
  }

  cancel(triggerId: string): boolean {
    const trigger = this.#triggers.get(triggerId);
    if (!trigger) return false;

    trigger.enabled = false;
    const timer = this.#timers.get(triggerId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(triggerId);
    }
    this.#persist();
    this.#onTriggersChanged?.(trigger.sessionId);
    return true;
  }

  /**
   * Fully delete a trigger — cancel timer, remove from store, persist.
   */
  delete(triggerId: string): boolean {
    const timer = this.#timers.get(triggerId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(triggerId);
    }
    const trigger = this.#triggers.get(triggerId);
    const existed = this.#triggers.delete(triggerId);
    if (existed && trigger) {
      this.#persist();
      this.#onTriggersChanged?.(trigger.sessionId);
    }
    return existed;
  }

  getTrigger(triggerId: string): Trigger | undefined {
    return this.#triggers.get(triggerId);
  }

  listTriggers(sessionId: string): Trigger[] {
    return [...this.#triggers.values()].filter(
      (t) => t.sessionId === sessionId,
    );
  }

  listAllTriggers(): Trigger[] {
    return [...this.#triggers.values()];
  }

  async fire(triggerId: string): Promise<void> {
    const trigger = this.#triggers.get(triggerId);
    if (!trigger || !trigger.enabled) return;

    logger.info("Trigger fired", {
      triggerId,
      sessionId: trigger.sessionId,
      kind: trigger.kind,
    });

    const event: TriggerEvent = {
      type: "trigger_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: trigger.sessionId,
      triggerKind: trigger.kind,
      payload: trigger.payload,
    };

    this.#threadStore.append(trigger.sessionId, event);
    this.#notificationHub.emitSessionEvent(trigger.sessionId, event);

    const sysEvent: SystemEvent = {
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      category: "core_lifecycle",
      detail: "trigger_fired",
      message: `Trigger ${trigger.kind} fired for session ${trigger.sessionId}`,
    };
    this.#systemStreamStore.append(sysEvent);
    this.#notificationHub.emitSystemEvent(sysEvent);

    const session = this.#sessions.get(trigger.sessionId);
    const shouldWake = session?.status === "sleeping" || session?.status === "idle";
    if (session && shouldWake) {
      session.status = transition(session.status, { kind: "trigger_fired" });
      session.updatedAt = this.#now();
      this.#threadStore.writeSessionMeta(session.id, session);
      this.#notificationHub.emitSessionListChanged();
    }

    if (trigger.recurring) {
      const interval = trigger.schedule ? parseInt(trigger.schedule, 10) : 0;
      if (!isNaN(interval) && interval > 0) {
        trigger.nextFire = (trigger.nextFire ?? Date.now()) + interval;
        this.#armTimer(trigger);
      } else if (trigger.schedule) {
        // Recalculate from cron expression
        const parsed = parseCronSchedule(trigger.schedule);
        if (parsed) {
          trigger.nextFire = parsed.nextFire;
          this.#armTimer(trigger);
        }
      }
    } else {
      trigger.enabled = false;
    }

    this.#persist();

    // Wake the session through the supervisor
    if (shouldWake && this.#onWake) {
      await this.#onWake(trigger.sessionId);
    }
    this.#onTriggersChanged?.(trigger.sessionId);
  }

  stop(): void {
    for (const [, timer] of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }

  // ── Private ──

  #armTimer(trigger: Trigger): void {
    const existing = this.#timers.get(trigger.id);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, (trigger.nextFire ?? Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.#timers.delete(trigger.id);
      this.fire(trigger.id);
    }, delay);
    this.#timers.set(trigger.id, timer);
  }
}
