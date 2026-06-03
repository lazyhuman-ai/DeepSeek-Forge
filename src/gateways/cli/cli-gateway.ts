import type { Gateway } from "../gateway.js";
import type { CoreAPI } from "../../core/core-api.js";
import type { Session, SessionEvent, SystemEvent } from "../../streams/event-types.js";
import type { Unsubscribe } from "../../core/notification-hub.js";

export class CliGateway implements Gateway {
  readonly name = "cli";

  #api: CoreAPI;
  #selectedSessionId: string | null = null;
  #unreadCounts = new Map<string, number>();
  #sessions: Session[] = [];
  #systemEvents: SystemEvent[] = [];
  #unsubscribes: Unsubscribe[] = [];

  constructor(api: CoreAPI) {
    this.#api = api;

    this.#sessions = api.listSessions();
    this.#systemEvents = api.getSystemEvents();

    this.#unsubscribes.push(
      api.onSessionEvent((sessionId, event) =>
        this.onSessionEvent(sessionId, event),
      ),
      api.onSystemEvent((event) => this.onSystemEvent(event)),
      api.onSessionListChanged(() => this.onSessionListChanged()),
    );
  }

  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (sessionId === this.#selectedSessionId) return;

    const session = this.#api.getSession(sessionId);
    if (session?.muted) return;

    if (event.type === "user_message" || event.type === "assistant_message") {
      const current = this.#unreadCounts.get(sessionId) ?? 0;
      this.#unreadCounts.set(sessionId, current + 1);
    }
  }

  onSystemEvent(event: SystemEvent): void {
    this.#systemEvents.push(event);
  }

  onSessionListChanged(): void {
    this.#sessions = this.#api.listSessions();
  }

  selectSession(sessionId: string): void {
    this.#selectedSessionId = sessionId;
    this.#unreadCounts.delete(sessionId);
  }

  getSelectedSessionId(): string | null {
    return this.#selectedSessionId;
  }

  getUnreadCount(sessionId: string): number {
    return this.#unreadCounts.get(sessionId) ?? 0;
  }

  getSessions(): Session[] {
    return this.#sessions;
  }

  getSystemEvents(): SystemEvent[] {
    return this.#systemEvents;
  }

  destroy(): void {
    for (const unsub of this.#unsubscribes) {
      unsub();
    }
    this.#unsubscribes = [];
  }
}
