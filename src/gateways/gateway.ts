import type { SessionEvent, SystemEvent } from "../streams/event-types.js";

export interface Gateway {
  readonly name: string;
  onSessionEvent(sessionId: string, event: SessionEvent): void;
  onSystemEvent(event: SystemEvent): void;
  onSessionListChanged(): void;
}
