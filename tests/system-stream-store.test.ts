import { describe, it, expect } from "vitest";
import { SystemStreamStore } from "../src/streams/system-stream-store.js";
import type { SystemEvent } from "../src/streams/event-types.js";

function makeEvent(seq: number, detail: string): SystemEvent {
  return {
    seq,
    timestamp: new Date().toISOString(),
    category: "runtime_lifecycle",
    detail,
    message: `Event ${detail}`,
  };
}

describe("SystemStreamStore", () => {
  it("appends events in order", () => {
    const store = new SystemStreamStore();
    store.append(makeEvent(1, "connected"));
    store.append(makeEvent(2, "degraded"));
    store.append(makeEvent(3, "recovered"));

    const events = store.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0]!.detail).toBe("connected");
    expect(events[1]!.detail).toBe("degraded");
    expect(events[2]!.detail).toBe("recovered");
  });

  it("getEvents returns defensive copy", () => {
    const store = new SystemStreamStore();
    store.append(makeEvent(1, "started"));

    const events = store.getEvents();
    events.push(makeEvent(99, "intruder"));

    expect(store.getEvents()).toHaveLength(1);
  });

  it("getEventsAfter returns only newer events", () => {
    const store = new SystemStreamStore();
    store.append(makeEvent(1, "first"));
    store.append(makeEvent(2, "second"));
    store.append(makeEvent(3, "third"));
    store.append(makeEvent(4, "fourth"));

    const after = store.getEventsAfter(2);
    expect(after).toHaveLength(2);
    expect(after[0]!.seq).toBe(3);
    expect(after[1]!.seq).toBe(4);
  });

  it("getEventsAfter returns empty when no newer events", () => {
    const store = new SystemStreamStore();
    store.append(makeEvent(1, "only"));
    expect(store.getEventsAfter(5)).toHaveLength(0);
  });

  it("replay equals getEvents", () => {
    const store = new SystemStreamStore();
    store.append(makeEvent(1, "a"));
    store.append(makeEvent(2, "b"));
    expect(store.replay()).toEqual(store.getEvents());
  });

  it("length reflects event count", () => {
    const store = new SystemStreamStore();
    expect(store.length).toBe(0);
    store.append(makeEvent(1, "first"));
    expect(store.length).toBe(1);
    store.append(makeEvent(2, "second"));
    expect(store.length).toBe(2);
  });

  it("empty store returns empty array", () => {
    const store = new SystemStreamStore();
    expect(store.getEvents()).toEqual([]);
    expect(store.getEventsAfter(0)).toEqual([]);
  });
});
