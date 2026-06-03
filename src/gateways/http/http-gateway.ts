import type { Gateway } from "../gateway.js";
import type { CoreAPI } from "../../core/core-api.js";
import type { SessionEvent, SystemEvent } from "../../streams/event-types.js";
import type { Unsubscribe } from "../../core/notification-hub.js";
import type { ServerResponse } from "node:http";

export class HttpGateway implements Gateway {
  readonly name = "http";

  #api: CoreAPI;
  #unsubscribes: Unsubscribe[] = [];
  #sseClients = new Set<ServerResponse>();

  constructor(api: CoreAPI) {
    this.#api = api;

    this.#unsubscribes.push(
      api.onSessionEvent((sid, ev) => this.onSessionEvent(sid, ev)),
      api.onSystemEvent((ev) => this.onSystemEvent(ev)),
      api.onSessionListChanged(() => this.onSessionListChanged()),
    );
  }

  // ── Gateway interface ──

  onSessionEvent(sessionId: string, event: SessionEvent): void {
    this.#broadcast("session_event", { sessionId, event });
  }

  onSystemEvent(event: SystemEvent): void {
    this.#broadcast("system_event", event);
  }

  onSessionListChanged(): void {
    this.#broadcast("session_list_changed", {});
  }

  // ── SSE client management ──

  addSseClient(res: ServerResponse): void {
    this.#sseClients.add(res);
  }

  removeSseClient(res: ServerResponse): void {
    this.#sseClients.delete(res);
    if (!res.writableEnded) {
      res.end();
    }
  }

  // ── Lifecycle ──

  destroy(): void {
    for (const unsub of this.#unsubscribes) {
      unsub();
    }
    for (const res of this.#sseClients) {
      if (!res.writableEnded) {
        res.end();
      }
    }
    this.#sseClients.clear();
  }

  get sseClientCount(): number {
    return this.#sseClients.size;
  }

  // ── Private ──

  #broadcast(eventType: string, data: unknown): void {
    if (this.#sseClients.size === 0) return;
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const res of this.#sseClients) {
      try {
        res.write(payload);
      } catch {
        this.removeSseClient(res);
      }
    }
  }
}
