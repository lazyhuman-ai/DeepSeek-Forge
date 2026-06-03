import type { SystemEvent } from "./event-types.js";

export class SystemStreamStore {
  #events: SystemEvent[] = [];

  append(event: SystemEvent): void {
    this.#events.push(event);
  }

  getEvents(): SystemEvent[] {
    return [...this.#events];
  }

  getEventsAfter(seq: number): SystemEvent[] {
    return this.#events.filter((e) => e.seq > seq);
  }

  replay(): SystemEvent[] {
    return this.getEvents();
  }

  get length(): number {
    return this.#events.length;
  }
}
