import type { SessionEvent, SystemEvent } from "../streams/event-types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("notification-hub");

export type SessionEventCallback = (
  sessionId: string,
  event: SessionEvent,
) => void;
export type SystemEventCallback = (event: SystemEvent) => void;
export type SessionListCallback = () => void;
export type Unsubscribe = () => void;

export class NotificationHub {
  #sessionListeners = new Set<SessionEventCallback>();
  #systemListeners = new Set<SystemEventCallback>();
  #listListeners = new Set<SessionListCallback>();

  onSessionEvent(cb: SessionEventCallback): Unsubscribe {
    this.#sessionListeners.add(cb);
    return () => this.#sessionListeners.delete(cb);
  }

  onSystemEvent(cb: SystemEventCallback): Unsubscribe {
    this.#systemListeners.add(cb);
    return () => this.#systemListeners.delete(cb);
  }

  onSessionListChanged(cb: SessionListCallback): Unsubscribe {
    this.#listListeners.add(cb);
    return () => this.#listListeners.delete(cb);
  }

  emitSessionEvent(sessionId: string, event: SessionEvent): void {
    for (const cb of this.#sessionListeners) {
      try {
        cb(sessionId, event);
      } catch (err) {
        logger.error("session event listener error", err);
      }
    }
  }

  emitSystemEvent(event: SystemEvent): void {
    for (const cb of this.#systemListeners) {
      try {
        cb(event);
      } catch (err) {
        logger.error("system event listener error", err);
      }
    }
  }

  emitSessionListChanged(): void {
    for (const cb of this.#listListeners) {
      try {
        cb();
      } catch (err) {
        logger.error("session list listener error", err);
      }
    }
  }
}
